import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
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
  const [config, setConfig] = useState<Config | null | undefined>(undefined);
  const [summary, setSummary] = useState<Summary | null | undefined>(undefined);
  const [showDetails, setShowDetails] = useState(false);
  const [extra, setExtra] = useState(0); // extra principal $/mo

  const load = useCallback(async () => {
    const [cfg, sum] = await Promise.all([
      send('mortgage-get-config', { accountId: account.id }),
      send('mortgage-get-summary', { accountId: account.id }),
    ]);
    setConfig(cfg);
    setSummary(sum);
  }, [account.id]);

  useEffect(() => {
    load().catch(() => {
      setConfig(null);
      setSummary(null);
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

      <Button
        variant="bare"
        onPress={() => setShowDetails(v => !v)}
        style={{ alignSelf: 'flex-start' }}
      >
        {showDetails ? (
          <Trans>Hide schedule & payoff</Trans>
        ) : (
          <Trans>Show schedule & payoff</Trans>
        )}
      </Button>

      {showDetails && effectivePI != null && (
        <>
          {/* Amortization schedule */}
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
              <Text style={{ flex: 2, fontSize: 12, color: theme.pageTextSubdued }}>
                <Trans>Upcoming</Trans>
              </Text>
              <Text style={{ flex: 1, fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                <Trans>Principal</Trans>
              </Text>
              <Text style={{ flex: 1, fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                <Trans>Interest</Trans>
              </Text>
              <Text style={{ flex: 1, fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                <Trans>Escrow</Trans>
              </Text>
              <Text style={{ flex: 1.3, fontSize: 12, textAlign: 'right', color: theme.pageTextSubdued }}>
                <Trans>Balance</Trans>
              </Text>
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
                <Text style={{ flex: 2, fontSize: 12 }}>
                  {row.date ? monthLabel(row.date) : `#${row.index}`}
                  {i === 0 ? t(' · next') : ''}
                </Text>
                <Text style={{ flex: 1, fontSize: 12, textAlign: 'right' }}>
                  {moneyCents(row.principal)}
                </Text>
                <Text style={{ flex: 1, fontSize: 12, textAlign: 'right' }}>
                  {moneyCents(row.interest)}
                </Text>
                <Text style={{ flex: 1, fontSize: 12, textAlign: 'right' }}>
                  {moneyCents(row.escrow)}
                </Text>
                <Text style={{ flex: 1.3, fontSize: 12, textAlign: 'right' }}>
                  {moneyCents(row.balance)}
                </Text>
              </View>
            ))}
          </View>

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
