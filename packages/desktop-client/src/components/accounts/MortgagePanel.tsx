import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { listen, send } from '@actual-app/core/platform/client/connection';
import { currentDay } from '@actual-app/core/shared/months';
import {
  addMonths,
  buildSchedule,
  computePayment,
  escrowForDate,
  escrowTotal,
  payoffSavings,
} from '@actual-app/core/shared/mortgage';
import type { AccountEntity } from '@actual-app/core/types/models';

import {
  ColumnResizeGrip,
  ColumnWidthsProvider,
  useColumnWidth,
} from '#components/table/columnResize';
import { useNavigate } from '#hooks/useNavigate';
import { pushModal } from '#modals/modalsSlice';
import { useDispatch } from '#redux';

type EscrowPeriod = {
  id: string;
  effectiveDate: string;
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
};

type Config = {
  accountId: string;
  annualInterestRate: number;
  originalPrincipal: number | null;
  startDate: string | null;
  termMonths: number | null;
  piPayment: number | null;
  escrowPeriods: EscrowPeriod[];
};

type Summary = {
  balance: number;
  originalPrincipal: number | null;
  principalPaid: number | null;
  interestPaid: number;
  taxPaid: number;
  insurancePaid: number;
  pmiPaid: number;
  escrowPaid: number;
};

type PaymentRow = {
  parentId: string;
  fundingAccountId: string;
  fundingAccountName: string;
  date: string;
  total: number;
  interest: number;
  propertyTax: number;
  homeInsurance: number;
  pmi: number;
  principal: number;
  hasTransfer: boolean;
  attachmentCount: number;
};

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });
}

function moneyCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

function monthLabel(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
  });
}

function firstOfNextMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}

type MortgagePanelProps = {
  account: AccountEntity;
};

export function MortgagePanel({ account }: MortgagePanelProps) {
  const { t } = useTranslation();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [config, setConfig] = useState<Config | null | undefined>(undefined);
  const [summary, setSummary] = useState<Summary | null | undefined>(undefined);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [showDetails, setShowDetails] = useState(false);
  const [showPayments, setShowPayments] = useState(false);
  const [extra, setExtra] = useState(0); // extra principal $/mo

  const load = useCallback(async () => {
    const [cfg, sum, pays] = await Promise.all([
      send('mortgage-get-config', { accountId: account.id }),
      send('mortgage-get-summary', { accountId: account.id }),
      send('mortgage-get-payments', { accountId: account.id }),
    ]);
    setConfig(cfg);
    setSummary(sum);
    setPayments(pays);
  }, [account.id]);

  useEffect(() => {
    load().catch(() => {
      setConfig(null);
      setSummary(null);
    });
  }, [load]);

  // Splits, imports, and attachments all land as sync events; keep the panel
  // (summary numbers + payment history) live instead of mount-time stale.
  useEffect(() => {
    return listen('sync-event', event => {
      if (
        (event.type === 'applied' || event.type === 'success') &&
        (event.tables?.includes('transactions') ||
          event.tables?.includes('transaction_attachments'))
      ) {
        load().catch(() => {});
      }
    });
  }, [load]);

  const today = currentDay();

  const effectivePI = useMemo(() => {
    if (!config) {
      return null;
    }
    if (config.piPayment) {
      return config.piPayment;
    }
    if (config.originalPrincipal && config.termMonths) {
      return computePayment(
        config.originalPrincipal,
        config.annualInterestRate,
        config.termMonths,
      );
    }
    return null;
  }, [config]);

  const schedule = useMemo(() => {
    if (!config || !summary || !effectivePI) {
      return [];
    }
    const periods = config.escrowPeriods;
    return buildSchedule({
      balance: summary.balance,
      annualRate: config.annualInterestRate,
      piPayment: effectivePI,
      count: 12,
      startDate: firstOfNextMonth(today),
      escrowForRow: date =>
        date ? escrowTotal(escrowForDate(periods, date)) : 0,
    });
  }, [config, summary, effectivePI, today]);

  const openSetup = () =>
    dispatch(
      pushModal({
        modal: { name: 'mortgage-setup', options: { accountId: account.id } },
      }),
    );
  const openEscrow = () =>
    dispatch(
      pushModal({
        modal: { name: 'mortgage-escrow', options: { accountId: account.id } },
      }),
    );
  const openImport = () =>
    dispatch(
      pushModal({
        modal: { name: 'mortgage-import', options: { accountId: account.id } },
      }),
    );

  const cardStyle = {
    flex: '1 1 130px',
    backgroundColor: theme.tableRowHeaderBackground,
    borderRadius: 8,
    padding: '10px 12px',
  } as const;

  if (config === undefined || summary === undefined) {
    return null; // loading
  }

  // Not set up yet — a slim prompt right on the page. Config and summary are
  // written together, so a null config means a null summary too.
  if (!config || !summary) {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          margin: '0 16px 8px',
          padding: '10px 14px',
          backgroundColor: theme.tableRowHeaderBackground,
          borderRadius: 8,
        }}
      >
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>
            Track interest, escrow, principal, and payoff for this mortgage.
          </Trans>
        </Text>
        <Button variant="primary" onPress={openSetup}>
          <Trans>Set up mortgage tracking</Trans>
        </Button>
      </View>
    );
  }

  const currentEscrow = escrowForDate(config.escrowPeriods, today);
  const currentEscrowTotal = escrowTotal(currentEscrow);
  const latestPeriod = config.escrowPeriods[config.escrowPeriods.length - 1];
  const maturity =
    config.startDate && config.termMonths
      ? monthLabel(addMonths(config.startDate, config.termMonths))
      : null;
  const monthlyPayment = effectivePI ? effectivePI + currentEscrowTotal : null;
  const pctPaid =
    summary.principalPaid != null && config.originalPrincipal
      ? Math.max(
          0,
          Math.min(100, (summary.principalPaid / config.originalPrincipal) * 100),
        )
      : null;

  const savings = effectivePI
    ? payoffSavings(
        summary.balance,
        config.annualInterestRate,
        effectivePI,
        extra * 100,
      )
    : { monthsSaved: 0, interestSaved: 0 };
  const yrs = Math.floor(savings.monthsSaved / 12);
  const mos = savings.monthsSaved % 12;

  return (
    <View style={{ margin: '0 16px 10px', gap: 12 }}>
      {/* Summary cards */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <View style={cardStyle}>
          <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
            <Trans>Balance owed</Trans>
          </Text>
          <Text style={{ fontSize: 20, fontWeight: 500 }}>
            {moneyCents(summary.balance)}
          </Text>
        </View>
        <View style={cardStyle}>
          <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
            <Trans>Rate</Trans>
          </Text>
          <Text style={{ fontSize: 20, fontWeight: 500 }}>
            {(config.annualInterestRate * 100).toFixed(3)}%
          </Text>
        </View>
        <View style={cardStyle}>
          <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
            <Trans>Payment / mo</Trans>
          </Text>
          <Text style={{ fontSize: 20, fontWeight: 500 }}>
            {monthlyPayment != null ? money(monthlyPayment) : '—'}
          </Text>
          {monthlyPayment != null && effectivePI != null && (
            <Text style={{ fontSize: 11, color: theme.pageTextSubdued }}>
              <Trans>
                P&I {{ pi: money(effectivePI) }} + escrow{' '}
                {{ esc: money(currentEscrowTotal) }}
              </Trans>
            </Text>
          )}
        </View>
        <View style={cardStyle}>
          <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
            <Trans>Payoff</Trans>
          </Text>
          <Text style={{ fontSize: 20, fontWeight: 500 }}>
            {maturity ?? '—'}
          </Text>
        </View>
      </View>

      {/* Progress */}
      {pctPaid != null && config.originalPrincipal != null && (
        <View style={{ gap: 4 }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
            }}
          >
            <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
              <Trans>Principal paid</Trans>
            </Text>
            <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
              {moneyCents(summary.principalPaid ?? 0)} {t('of')}{' '}
              {money(config.originalPrincipal)} · {pctPaid.toFixed(1)}%
            </Text>
          </View>
          <View
            style={{
              height: 8,
              backgroundColor: theme.tableRowHeaderBackground,
              borderRadius: 20,
            }}
          >
            <View
              style={{
                width: `${Math.max(1, pctPaid)}%`,
                height: '100%',
                backgroundColor: theme.pageTextPositive,
                borderRadius: 20,
              }}
            />
          </View>
        </View>
      )}

      {/* Paid-to-date + escrow */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <View
          style={{
            flex: '1 1 220px',
            border: '1px solid ' + theme.tableBorder,
            borderRadius: 8,
            padding: '10px 12px',
            gap: 6,
          }}
        >
          <Text style={{ fontWeight: 500 }}>
            <Trans>Paid so far</Trans>
          </Text>
          <Row label={t('Interest')} value={moneyCents(summary.interestPaid)} />
          <Row
            label={t('Principal')}
            value={moneyCents(summary.principalPaid ?? 0)}
          />
          <Row
            label={t('Taxes & insurance')}
            value={moneyCents(summary.escrowPaid)}
          />
        </View>

        <View
          style={{
            flex: '1 1 220px',
            border: '1px solid ' + theme.tableBorder,
            borderRadius: 8,
            padding: '10px 12px',
            gap: 6,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Text style={{ fontWeight: 500 }}>
              <Trans>Escrow</Trans>
            </Text>
            <Button variant="bare" onPress={openEscrow}>
              <Trans>Adjust…</Trans>
            </Button>
          </View>
          <Row
            label={t('Current')}
            value={
              currentEscrowTotal > 0
                ? `${moneyCents(currentEscrowTotal)}/mo`
                : t('none set')
            }
          />
          {latestPeriod && (
            <Row
              label={t('In effect since')}
              value={latestPeriod.effectiveDate}
            />
          )}
          <Row
            label={t('Recorded changes')}
            value={String(config.escrowPeriods.length)}
          />
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <Button variant="primary" onPress={openImport}>
          <Trans>Import splits from statements…</Trans>
        </Button>
        {payments.length > 0 && (
          <Button variant="bare" onPress={() => setShowPayments(v => !v)}>
            {showPayments ? (
              <Trans>Hide payment history</Trans>
            ) : (
              <Trans>Payment history ({{ count: payments.length }})</Trans>
            )}
          </Button>
        )}
        <Button variant="bare" onPress={() => setShowDetails(v => !v)}>
          {showDetails ? (
            <Trans>Hide schedule & payoff</Trans>
          ) : (
            <Trans>Show schedule & payoff</Trans>
          )}
        </Button>
      </View>

      {showPayments && payments.length > 0 && (
        <ColumnWidthsProvider tableId="mortgage-payments">
          <View
            style={{
              border: '1px solid ' + theme.tableBorder,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                padding: '6px 12px',
                backgroundColor: theme.tableRowHeaderBackground,
              }}
            >
              <ResizableCol col="paid" flex={1.4} grip>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Paid</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="from" flex={1.6} grip>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>From</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="interest" flex={1} grip>
                <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                  <Trans>Interest</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="escrow" flex={1} grip>
                <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                  <Trans>Escrow</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="principal" flex={1} grip>
                <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                  <Trans>Principal</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="total" flex={1} grip>
                <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                  <Trans>Total</Trans>
                </Text>
              </ResizableCol>
              <Text style={{ width: 40 }} />
            </View>
            {payments.map(p => (
              <View
                key={p.parentId}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  padding: '4px 12px',
                  borderTop: '1px solid ' + theme.tableBorder,
                }}
              >
                <ResizableCol col="paid" flex={1.4}>
                  <Text style={{ fontSize: 12 }}>{p.date}</Text>
                </ResizableCol>
                <ResizableCol
                  col="from"
                  flex={1.6}
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                >
                  <Button
                    variant="bare"
                    style={{ fontSize: 12, padding: '2px 4px' }}
                    onPress={() => navigate('/accounts/' + p.fundingAccountId)}
                  >
                    {p.fundingAccountName}
                  </Button>
                  {!p.hasTransfer && (
                    <Text
                      style={{ fontSize: 11, color: theme.warningText }}
                      title={t(
                        'The Principal line is not linked as a transfer, so this payment is missing from the loan ledger.',
                      )}
                    >
                      ⚠
                    </Text>
                  )}
                </ResizableCol>
                <ResizableCol col="interest" flex={1}>
                  <Text style={{ fontSize: 12, textAlign: 'right' }}>
                    {moneyCents(p.interest)}
                  </Text>
                </ResizableCol>
                <ResizableCol col="escrow" flex={1}>
                  <Text style={{ fontSize: 12, textAlign: 'right' }}>
                    {moneyCents(p.propertyTax + p.homeInsurance + p.pmi)}
                  </Text>
                </ResizableCol>
                <ResizableCol col="principal" flex={1}>
                  <Text style={{ fontSize: 12, textAlign: 'right', fontWeight: 500 }}>
                    {moneyCents(p.principal)}
                  </Text>
                </ResizableCol>
                <ResizableCol col="total" flex={1}>
                  <Text style={{ fontSize: 12, textAlign: 'right' }}>
                    {moneyCents(p.total)}
                  </Text>
                </ResizableCol>
                <View style={{ width: 40, alignItems: 'flex-end' }}>
                  <Button
                    variant="bare"
                    style={{ fontSize: 12, padding: '2px 4px' }}
                    aria-label={t('Attachments')}
                    onPress={() =>
                      dispatch(
                        pushModal({
                          modal: {
                            name: 'transaction-attachments',
                            options: { transactionId: p.parentId },
                          },
                        }),
                      )
                    }
                  >
                    {p.attachmentCount > 0 ? `📎${p.attachmentCount}` : '📎'}
                  </Button>
                </View>
              </View>
            ))}
          </View>
        </ColumnWidthsProvider>
      )}

      {showDetails && effectivePI != null && (
        <>
          {/* Amortization schedule */}
          <ColumnWidthsProvider tableId="mortgage-schedule">
            <View
              style={{
                border: '1px solid ' + theme.tableBorder,
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  padding: '6px 12px',
                  backgroundColor: theme.tableRowHeaderBackground,
                }}
              >
                <ResizableCol col="upcoming" flex={2} grip>
                  <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                    <Trans>Upcoming</Trans>
                  </Text>
                </ResizableCol>
                <ResizableCol col="principal" flex={1} grip>
                  <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                    <Trans>Principal</Trans>
                  </Text>
                </ResizableCol>
                <ResizableCol col="interest" flex={1} grip>
                  <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                    <Trans>Interest</Trans>
                  </Text>
                </ResizableCol>
                <ResizableCol col="escrow" flex={1} grip>
                  <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                    <Trans>Escrow</Trans>
                  </Text>
                </ResizableCol>
                <ResizableCol col="balance" flex={1.3} grip>
                  <Text style={{ fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                    <Trans>Balance</Trans>
                  </Text>
                </ResizableCol>
              </View>
              {schedule.map((row, i) => (
                <View
                  key={row.index}
                  style={{
                    flexDirection: 'row',
                    padding: '5px 12px',
                    borderTop: '1px solid ' + theme.tableBorder,
                    backgroundColor:
                      i === 0 ? theme.tableRowBackgroundHighlight : undefined,
                  }}
                >
                  <ResizableCol col="upcoming" flex={2}>
                    <Text style={{ fontSize: 12 }}>
                      {row.date ? monthLabel(row.date) : `#${row.index}`}
                      {i === 0 ? t(' · next') : ''}
                    </Text>
                  </ResizableCol>
                  <ResizableCol col="principal" flex={1}>
                    <Text style={{ fontSize: 12, textAlign: 'right' }}>
                      {moneyCents(row.principal)}
                    </Text>
                  </ResizableCol>
                  <ResizableCol col="interest" flex={1}>
                    <Text style={{ fontSize: 12, textAlign: 'right' }}>
                      {moneyCents(row.interest)}
                    </Text>
                  </ResizableCol>
                  <ResizableCol col="escrow" flex={1}>
                    <Text style={{ fontSize: 12, textAlign: 'right' }}>
                      {moneyCents(row.escrow)}
                    </Text>
                  </ResizableCol>
                  <ResizableCol col="balance" flex={1.3}>
                    <Text style={{ fontSize: 12, textAlign: 'right' }}>
                      {moneyCents(row.balance)}
                    </Text>
                  </ResizableCol>
                </View>
              ))}
            </View>
          </ColumnWidthsProvider>

          {/* Payoff calculator */}
          <View
            style={{
              border: '1px solid ' + theme.tableBorder,
              borderRadius: 8,
              padding: '10px 12px',
              gap: 8,
            }}
          >
            <Text style={{ fontWeight: 500 }}>
              <Trans>Payoff calculator</Trans>
            </Text>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>Extra principal / mo</Trans>
              </Text>
              <input
                type="range"
                min={0}
                max={1000}
                step={25}
                value={extra}
                onChange={e => setExtra(Number(e.target.value))}
                style={{ flex: 1, accentColor: theme.pageTextPositive }}
              />
              <Text style={{ fontWeight: 500, minWidth: 56, textAlign: 'right' }}>
                +${extra}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <View style={cardStyle}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Paid off sooner</Trans>
                </Text>
                <Text style={{ fontSize: 18, fontWeight: 500 }}>
                  {extra === 0
                    ? '—'
                    : `${yrs > 0 ? `${yrs}y ` : ''}${mos}m`}
                </Text>
              </View>
              <View style={cardStyle}>
                <Text style={{ fontSize: 12, color: theme.pageTextSubdued }}>
                  <Trans>Interest saved</Trans>
                </Text>
                <Text style={{ fontSize: 18, fontWeight: 500 }}>
                  {extra === 0 ? '—' : money(savings.interestSaved)}
                </Text>
              </View>
            </View>
          </View>
        </>
      )}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View
      style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 12 }}
    >
      <Text style={{ fontSize: 13, color: theme.pageTextSubdued }}>{label}</Text>
      <Text style={{ fontSize: 13, fontWeight: 500 }}>{value}</Text>
    </View>
  );
}

// A flex table column that honors a drag-resized pixel override: pinned to
// px when the user resized it, proportional flex otherwise. Header cells
// render the drag grip.
function ResizableCol({
  col,
  flex,
  grip,
  style,
  children,
}: {
  col: string;
  flex: number;
  grip?: boolean;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}) {
  const width = useColumnWidth(col, undefined);
  return (
    <View
      style={{
        ...(typeof width === 'number'
          ? { width, flexShrink: 0 }
          : { flex }),
        position: 'relative',
        justifyContent: 'center',
        ...style,
      }}
    >
      {children}
      {grip && <ColumnResizeGrip column={col} />}
    </View>
  );
}
