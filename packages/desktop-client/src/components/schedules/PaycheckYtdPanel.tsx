import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Select } from '@actual-app/components/select';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { integerToCurrency } from '@actual-app/core/shared/util';
import { format as formatDate, parseISO } from 'date-fns';

import { FinancialText } from '#components/FinancialText';
import { useDateFormat } from '#hooks/useDateFormat';

type Config = { id: string; name: string };

type YtdLine = { name: string; category: string | null; ytd: number };
type YtdCheck = {
  transactionId: string;
  date: string;
  deposit: number;
  qualifiedOt: number;
};
type Ytd = {
  year: number;
  earnings: YtdLine[];
  grossYtd: number;
  taxesYtd: number;
  deductionsYtd: number;
  netYtd: number;
  qualifiedOtYtd: number;
  checks: YtdCheck[];
};

const toCents = (v: string) => Math.round((parseFloat(v) || 0) * 100);

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>{label}</Text>
      <FinancialText style={{ fontSize: 15, fontWeight: 600 }}>
        {integerToCurrency(value)}
      </FinancialText>
    </View>
  );
}

/**
 * Pay-stub-style year-to-date summary for a paycheck, shown on the Income tab.
 * Per-line earnings + gross/tax/net come straight from the categorized split
 * children; qualified overtime comes from the per-check records and can be
 * backfilled here for checks entered before it was tracked.
 */
export function PaycheckYtdPanel() {
  const { t } = useTranslation();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  const [configs, setConfigs] = useState<Config[]>([]);
  const [configId, setConfigId] = useState('');
  const [ytd, setYtd] = useState<Ytd | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const list = (await send('paycheck-get-configs')) as Config[];
      setConfigs(list);
      if (list.length > 0) {
        setConfigId(prev => prev || list[0].id);
      }
    })();
  }, []);

  const reload = useCallback(async () => {
    if (!configId) {
      return;
    }
    const result = (await send('paycheck-get-ytd', { configId })) as Ytd | null;
    setYtd(result);
    setDrafts({});
  }, [configId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const saveQualifiedOt = async (transactionId: string) => {
    setSavingId(transactionId);
    try {
      await send('paycheck-set-entry-qualified-ot', {
        configId,
        transactionId,
        qualifiedOt: toCents(drafts[transactionId] ?? ''),
      });
      await reload();
    } finally {
      setSavingId(null);
    }
  };

  const fmtDate = (d: string) => formatDate(parseISO(d), dateFormat);

  const cellStyle = useMemo(
    () => ({ padding: '4px 8px', fontSize: 13 }) as const,
    [],
  );

  // No paychecks set up → nothing to show.
  if (configs.length === 0 || !ytd) {
    return null;
  }

  return (
    <View
      style={{
        flexShrink: 0,
        marginBottom: 16,
        border: '1px solid ' + theme.tableBorder,
        borderRadius: 8,
        padding: '12px 14px',
        gap: 12,
      }}
    >
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <Text style={{ fontWeight: 600 }}>
          <Trans>Paycheck YTD</Trans> · {ytd.year}
        </Text>
        {configs.length > 1 && (
          <Select
            value={configId}
            onChange={setConfigId}
            options={configs.map(c => [c.id, c.name] as [string, string])}
          />
        )}
        <View style={{ flex: 1 }} />
        <Button variant="bare" onPress={() => setExpanded(e => !e)}>
          {expanded ? t('Hide detail') : t('Show detail')}
        </Button>
      </View>

      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 24 }}
      >
        <Stat label={t('Gross')} value={ytd.grossYtd} />
        <Stat label={t('Taxes')} value={ytd.taxesYtd} />
        <Stat label={t('Deductions')} value={ytd.deductionsYtd} />
        <Stat label={t('Net')} value={ytd.netYtd} />
        <Stat label={t('Qualified overtime')} value={ytd.qualifiedOtYtd} />
      </View>

      {expanded && (
        <>
          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: 600 }}>
              <Trans>Earnings by line</Trans>
            </Text>
            {ytd.earnings.map(line => (
              <View
                key={line.name}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  ...cellStyle,
                }}
              >
                <Text>{line.name}</Text>
                <FinancialText>{integerToCurrency(line.ytd)}</FinancialText>
              </View>
            ))}
          </View>

          <View style={{ gap: 4 }}>
            <Text style={{ fontSize: 12, fontWeight: 600 }}>
              <Trans>Qualified overtime by check</Trans>
            </Text>
            <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
              <Trans>
                Enter the qualified (non-taxable) overtime for each check —
                including ones you entered before this was tracked.
              </Trans>
            </Text>
            {ytd.checks.length === 0 && (
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>No paychecks entered yet this year.</Trans>
              </Text>
            )}
            {ytd.checks.map(check => {
              const draft =
                drafts[check.transactionId] ??
                (check.qualifiedOt ? String(check.qualifiedOt / 100) : '');
              const dirty =
                drafts[check.transactionId] != null &&
                toCents(draft) !== check.qualifiedOt;
              return (
                <View
                  key={check.transactionId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 10,
                    ...cellStyle,
                  }}
                >
                  <Text style={{ width: 110 }}>{fmtDate(check.date)}</Text>
                  <Text
                    style={{
                      width: 110,
                      color: theme.pageTextSubdued,
                      textAlign: 'right',
                    }}
                  >
                    {integerToCurrency(check.deposit)}
                  </Text>
                  <Input
                    value={draft}
                    placeholder="0.00"
                    onChangeValue={v =>
                      setDrafts(d => ({ ...d, [check.transactionId]: v }))
                    }
                    onEnter={() => void saveQualifiedOt(check.transactionId)}
                    style={{ width: 100, textAlign: 'right' }}
                  />
                  <Button
                    variant="bare"
                    isDisabled={!dirty || savingId === check.transactionId}
                    onPress={() => void saveQualifiedOt(check.transactionId)}
                  >
                    <Trans>Save</Trans>
                  </Button>
                </View>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}
