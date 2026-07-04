import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { currentDay } from '@actual-app/core/shared/months';
import { integerToCurrency } from '@actual-app/core/shared/util';

import { Error as ErrorAlert } from '#components/alerts';
import {
  Modal,
  ModalButtons,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import { useAccounts } from '#hooks/useAccounts';
import type { Modal as ModalType } from '#modals/modalsSlice';

type PaycheckModalProps = Extract<ModalType, { name: 'paycheck' }>['options'];

type Line = { name: string; category: string | null; amount: number };
type Deposit = { accountId: string; amount: number };
type Frequency = 'weekly' | 'biweekly' | 'monthly';

type Config = {
  id: string;
  name: string;
  payeeId: string | null;
  accountId: string;
  scheduleId: string | null;
  earnings: Line[];
  pretax: Line[];
  taxes: Line[];
  aftertax: Line[];
  deposits: Deposit[];
  qualifiedOt: number;
  frequency?: Frequency;
  nextDate?: string;
};

const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100);
const fromCents = (c: number) => (c ? String(c / 100) : '');

// Native date input — renders in the user's locale (MM/DD/YYYY here), stores
// yyyy-mm-dd. Matches the escrow modal / register date handling.
const dateInputStyle = {
  height: 36,
  padding: '0 10px',
  border: '1px solid ' + theme.formInputBorder,
  borderRadius: 4,
  backgroundColor: theme.tableBackground,
  color: theme.pageText,
  colorScheme: 'light dark',
} as const;

type EditableLine = { name: string; category: string | null; amountStr: string };
type EditableDeposit = { accountId: string; amountStr: string };

function linesToEdit(lines: Line[]): EditableLine[] {
  return lines.map(l => ({
    name: l.name,
    category: l.category,
    amountStr: fromCents(l.amount),
  }));
}
function editToLines(lines: EditableLine[]): Line[] {
  return lines
    .filter(l => l.name.trim())
    .map(l => ({
      name: l.name.trim(),
      category: l.category,
      amount: toCents(l.amountStr),
    }));
}

function LineSection({
  title,
  lines,
  onChange,
}: {
  title: string;
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
}) {
  const { t } = useTranslation();
  const update = (i: number, patch: Partial<EditableLine>) =>
    onChange(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  useEffect(() => {
    if (focusIndex != null) {
      inputRefs.current[focusIndex]?.focus();
      setFocusIndex(null);
    }
  }, [focusIndex, lines.length]);

  // Enter in an amount field hops to the next line's amount (adding a line at
  // the end) — fast keyboard entry for taxes/earnings.
  const onEnterLine = (i: number) => {
    if (i < lines.length - 1) {
      inputRefs.current[i + 1]?.focus();
    } else {
      onChange([...lines, { name: '', category: null, amountStr: '' }]);
      setFocusIndex(lines.length);
    }
  };

  return (
    <View style={{ gap: 4 }}>
      <Text style={{ fontWeight: 600, fontSize: 13 }}>{title}</Text>
      {lines.map((line, i) => (
        <View
          key={i}
          style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}
        >
          <Input
            value={line.name}
            placeholder={t('Name')}
            onChangeValue={v => update(i, { name: v })}
            style={{ flex: 1 }}
          />
          <Input
            ref={el => {
              inputRefs.current[i] = el;
            }}
            value={line.amountStr}
            placeholder="0.00"
            onChangeValue={v => update(i, { amountStr: v })}
            onEnter={() => onEnterLine(i)}
            style={{ width: 100, textAlign: 'right' }}
          />
          <Button
            variant="bare"
            aria-label={t('Remove line')}
            onPress={() => onChange(lines.filter((_, idx) => idx !== i))}
          >
            ✕
          </Button>
        </View>
      ))}
      <Button
        variant="bare"
        style={{ alignSelf: 'flex-start', fontSize: 12 }}
        onPress={() =>
          onChange([...lines, { name: '', category: null, amountStr: '' }])
        }
      >
        <Trans>Add line</Trans>
      </Button>
    </View>
  );
}

/**
 * Quicken-style paycheck window: set up the recurring template (earnings,
 * pre-tax deductions, taxes, after-tax deductions, deposit accounts) and
 * enter individual paychecks into the register from it.
 */
export function PaycheckModal({ configId }: PaycheckModalProps = {}) {
  const { t } = useTranslation();
  const { data: accounts = [] } = useAccounts();
  const openAccounts = useMemo(
    () => accounts.filter(a => !a.closed),
    [accounts],
  );

  const [config, setConfig] = useState<Config | null>(null);
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [frequency, setFrequency] = useState<Frequency>('weekly');
  const [nextDate, setNextDate] = useState(currentDay());
  const [earnings, setEarnings] = useState<EditableLine[]>([
    { name: 'Salary', category: null, amountStr: '' },
  ]);
  const [pretax, setPretax] = useState<EditableLine[]>([]);
  const [taxes, setTaxes] = useState<EditableLine[]>([
    { name: 'Federal Tax', category: null, amountStr: '' },
    { name: 'State Tax', category: null, amountStr: '' },
    { name: 'Social Security (FICA)', category: null, amountStr: '' },
    { name: 'Medicare Tax', category: null, amountStr: '' },
    { name: 'County Tax', category: null, amountStr: '' },
  ]);
  const [aftertax, setAftertax] = useState<EditableLine[]>([]);
  const [deposits, setDeposits] = useState<EditableDeposit[]>([]);
  const [qualifiedOtStr, setQualifiedOtStr] = useState('');
  const [entryDate, setEntryDate] = useState(currentDay());
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [pendingMatch, setPendingMatch] = useState<{
    transactionId: string;
    amount: number;
    savedId: string;
  } | null>(null);

  useEffect(() => {
    void (async () => {
      const configs = (await send('paycheck-get-configs')) as Config[];
      const existing = configId
        ? configs.find(c => c.id === configId)
        : configs[0];
      if (existing) {
        setConfig(existing);
        setName(existing.name);
        setAccountId(existing.accountId);
        setEarnings(linesToEdit(existing.earnings));
        setPretax(linesToEdit(existing.pretax));
        setTaxes(linesToEdit(existing.taxes));
        setAftertax(linesToEdit(existing.aftertax));
        setDeposits(
          existing.deposits.map(d => ({
            accountId: d.accountId,
            amountStr: fromCents(d.amount),
          })),
        );
        setQualifiedOtStr(fromCents(existing.qualifiedOt));
        if (existing.frequency) {
          setFrequency(existing.frequency);
        }
        if (existing.nextDate) {
          setNextDate(existing.nextDate);
        }
      }
    })();
  }, [configId]);

  const gross = editToLines(earnings).reduce((a, l) => a + l.amount, 0);
  const totalDeductions =
    editToLines(pretax).reduce((a, l) => a + l.amount, 0) +
    editToLines(taxes).reduce((a, l) => a + l.amount, 0) +
    editToLines(aftertax).reduce((a, l) => a + l.amount, 0);
  const net = gross - totalDeductions;
  const secondary = deposits.reduce((a, d) => a + toCents(d.amountStr), 0);
  const primary = net - secondary;

  const configInput = () => ({
    name,
    payeeName: name,
    accountId,
    earnings: editToLines(earnings),
    pretax: editToLines(pretax),
    taxes: editToLines(taxes),
    aftertax: editToLines(aftertax),
    deposits: deposits
      .filter(d => d.accountId && toCents(d.amountStr) > 0)
      .map(d => ({ accountId: d.accountId, amount: toCents(d.amountStr) })),
    qualifiedOt: toCents(qualifiedOtStr),
    frequency,
    nextDate,
  });

  const onSave = async () => {
    setIsBusy(true);
    setError(null);
    try {
      const saved = (await send('paycheck-save-config', {
        ...(config ? { id: config.id } : {}),
        ...configInput(),
      })) as Config;
      setConfig(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsBusy(false);
  };

  const onEnter = async (close: () => void) => {
    setIsBusy(true);
    setError(null);
    setPendingMatch(null);
    try {
      // Save first so the entered paycheck always matches what's on screen.
      const saved = (await send('paycheck-save-config', {
        ...(config ? { id: config.id } : {}),
        ...configInput(),
      })) as Config;
      setConfig(saved);
      // If a plain transaction for this deposit is already in the register
      // (usually the bank's own row), offer to replace it instead of adding a
      // duplicate.
      const match = (await send('paycheck-find-match', {
        configId: saved.id,
        date: entryDate,
      })) as { transactionId: string; amount: number } | null;
      if (match) {
        setPendingMatch({ ...match, savedId: saved.id });
        setIsBusy(false);
        return;
      }
      await send('paycheck-generate', {
        configId: saved.id,
        date: entryDate,
      });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsBusy(false);
    }
  };

  // Finish entering after the user chooses replace-vs-add for a matched row.
  const finishEnter = async (
    close: () => void,
    replaceTransactionId?: string,
  ) => {
    if (!pendingMatch) {
      return;
    }
    setIsBusy(true);
    setError(null);
    try {
      await send('paycheck-generate', {
        configId: pendingMatch.savedId,
        date: entryDate,
        ...(replaceTransactionId ? { replaceTransactionId } : {}),
      });
      setPendingMatch(null);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsBusy(false);
    }
  };

  const summaryCard = {
    flex: 1,
    backgroundColor: theme.tableRowHeaderBackground,
    borderRadius: 8,
    padding: '8px 12px',
  } as const;

  return (
    <Modal name="paycheck" containerProps={{ style: { width: 560 } }}>
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Paycheck')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 14, maxHeight: '70vh', overflowY: 'auto' }}>
            {error && <ErrorAlert>{error}</ErrorAlert>}

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Company name</Trans>
                </Text>
                <Input value={name} onChangeValue={setName} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Deposit account</Trans>
                </Text>
                <Select
                  value={accountId}
                  onChange={value => setAccountId(value)}
                  options={[
                    ['', t('Choose an account…')],
                    ...openAccounts.map(
                      a => [a.id, a.name] as [string, string],
                    ),
                  ]}
                />
              </View>
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Frequency</Trans>
                </Text>
                <Select
                  value={frequency}
                  onChange={value => setFrequency(value as Frequency)}
                  options={[
                    ['weekly', t('Weekly')],
                    ['biweekly', t('Every two weeks')],
                    ['monthly', t('Monthly')],
                  ]}
                />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Next pay date</Trans>
                </Text>
                <input
                  type="date"
                  value={nextDate}
                  onChange={e => setNextDate(e.target.value)}
                  style={dateInputStyle}
                />
              </View>
            </View>

            <LineSection
              title={t('Earnings')}
              lines={earnings}
              onChange={setEarnings}
            />
            <LineSection
              title={t('Pre-tax deductions')}
              lines={pretax}
              onChange={setPretax}
            />
            <LineSection title={t('Taxes')} lines={taxes} onChange={setTaxes} />
            <LineSection
              title={t('After-tax deductions')}
              lines={aftertax}
              onChange={setAftertax}
            />

            <View style={{ gap: 4 }}>
              <Text style={{ fontWeight: 600, fontSize: 13 }}>
                <Trans>Deposit accounts</Trans>
              </Text>
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>
                  The remainder of net pay stays in the deposit account above;
                  add rows for the accounts the rest is split into.
                </Trans>
              </Text>
              {deposits.map((dep, i) => (
                <View
                  key={i}
                  style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}
                >
                  <View style={{ flex: 1 }}>
                    <Select
                      value={dep.accountId}
                      onChange={value =>
                        setDeposits(
                          deposits.map((d, idx) =>
                            idx === i ? { ...d, accountId: value } : d,
                          ),
                        )
                      }
                      options={[
                        ['', t('Choose an account…')],
                        ...openAccounts
                          .filter(a => a.id !== accountId)
                          .map(a => [a.id, a.name] as [string, string]),
                      ]}
                    />
                  </View>
                  <Input
                    value={dep.amountStr}
                    placeholder="0.00"
                    onChangeValue={v =>
                      setDeposits(
                        deposits.map((d, idx) =>
                          idx === i ? { ...d, amountStr: v } : d,
                        ),
                      )
                    }
                    style={{ width: 100, textAlign: 'right' }}
                  />
                  <Button
                    variant="bare"
                    aria-label={t('Remove deposit')}
                    onPress={() =>
                      setDeposits(deposits.filter((_, idx) => idx !== i))
                    }
                  >
                    ✕
                  </Button>
                </View>
              ))}
              <Button
                variant="bare"
                style={{ alignSelf: 'flex-start', fontSize: 12 }}
                onPress={() =>
                  setDeposits([...deposits, { accountId: '', amountStr: '' }])
                }
              >
                <Trans>Add deposit account</Trans>
              </Button>
            </View>

            <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>Qualified overtime (non-taxable, tracked)</Trans>
              </Text>
              <Input
                value={qualifiedOtStr}
                placeholder="0.00"
                onChangeValue={setQualifiedOtStr}
                style={{ width: 100, textAlign: 'right' }}
              />
            </View>

            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={summaryCard}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>W2 gross</Trans>
                </Text>
                <FinancialText style={{ fontSize: 17, fontWeight: 600 }}>
                  {integerToCurrency(gross)}
                </FinancialText>
              </View>
              <View style={summaryCard}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Net pay</Trans>
                </Text>
                <FinancialText style={{ fontSize: 17, fontWeight: 600 }}>
                  {integerToCurrency(net)}
                </FinancialText>
              </View>
              <View style={summaryCard}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Stays in account</Trans>
                </Text>
                <FinancialText
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    color: primary < 0 ? theme.errorText : undefined,
                  }}
                >
                  {integerToCurrency(primary)}
                </FinancialText>
              </View>
            </View>

            <View
              style={{
                flexDirection: 'row',
                gap: 8,
                alignItems: 'center',
                borderTop: '1px solid ' + theme.tableBorder,
                paddingTop: 10,
              }}
            >
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>Enter a paycheck dated</Trans>
              </Text>
              <input
                type="date"
                value={entryDate}
                onChange={e => {
                  setEntryDate(e.target.value);
                  setPendingMatch(null);
                }}
                style={{ ...dateInputStyle, width: 150 }}
              />
              <ButtonWithLoading
                variant="primary"
                isLoading={isBusy && !pendingMatch}
                isDisabled={
                  !name.trim() || !accountId || net <= 0 || pendingMatch != null
                }
                onPress={() => void onEnter(() => state.close())}
              >
                <Trans>Enter paycheck</Trans>
              </ButtonWithLoading>
            </View>

            {pendingMatch && (
              <View
                style={{
                  gap: 8,
                  padding: 10,
                  borderRadius: 8,
                  backgroundColor: theme.tableRowHeaderBackground,
                  border: '1px solid ' + theme.tableBorder,
                }}
              >
                <Text style={{ fontSize: 13 }}>
                  <Trans>
                    A{' '}
                    {{ amount: integerToCurrency(pendingMatch.amount) }}{' '}
                    transaction is already in this account on that date —
                    probably the bank&apos;s own deposit. Replace it with this
                    paycheck split, or add a new one?
                  </Trans>
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <ButtonWithLoading
                    variant="primary"
                    isLoading={isBusy}
                    onPress={() =>
                      void finishEnter(
                        () => state.close(),
                        pendingMatch.transactionId,
                      )
                    }
                  >
                    <Trans>Replace it</Trans>
                  </ButtonWithLoading>
                  <Button
                    isDisabled={isBusy}
                    onPress={() => void finishEnter(() => state.close())}
                  >
                    <Trans>Add new anyway</Trans>
                  </Button>
                  <Button
                    variant="bare"
                    isDisabled={isBusy}
                    onPress={() => setPendingMatch(null)}
                  >
                    <Trans>Cancel</Trans>
                  </Button>
                </View>
              </View>
            )}
          </View>

          <ModalButtons>
            <Button onPress={() => state.close()}>
              <Trans>Close</Trans>
            </Button>
            <ButtonWithLoading
              variant="primary"
              isLoading={isBusy}
              isDisabled={!name.trim() || !accountId}
              onPress={() => void onSave()}
            >
              {config ? <Trans>Save changes</Trans> : <Trans>Save paycheck</Trans>}
            </ButtonWithLoading>
          </ModalButtons>
        </>
      )}
    </Modal>
  );
}
