import { v4 as uuidv4 } from 'uuid';

import { aqlQuery } from '#server/aql';
import { createApp } from '#server/app';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import { batchUpdateTransactions } from '#server/transactions';
import { undoable } from '#server/undo';
import {
  escrowForDate,
  monthlyInterest,
  type EscrowAmounts,
} from '#shared/mortgage';
import { q } from '#shared/query';
import { makeChild, recalculateSplit } from '#shared/transactions';
import type { TransactionEntity } from '#types/models';

/**
 * Mortgage tracking. A mortgage-type account carries loan terms (rate, original
 * principal, start date, term, P&I payment) plus an effective-dated escrow
 * history (property tax, home insurance, PMI). A monthly payment on the funding
 * account can be split into Interest / Property Tax / Home Insurance / PMI
 * categories plus a Principal transfer into the mortgage account, which is what
 * actually pays it down. Escrow moves over time (every annual analysis), so the
 * amount used for a split is whichever period is in force on the payment's date;
 * each line can also be overridden per-payment straight off the statement.
 *
 * The loan balance itself stays owned by the servicer (via Plaid); use the
 * account's built-in Reconcile to snap it to the real number.
 */

type MortgageConfigRow = {
  id: string;
  account_id: string;
  annual_interest_rate: number;
  original_principal: number | null;
  start_date: string | null;
  term_months: number | null;
  pi_payment: number | null;
  // Legacy inline escrow (pre escrow-periods); still read as a fallback.
  property_tax_monthly: number | null;
  home_insurance_monthly: number | null;
  pmi_monthly: number | null;
  interest_category: string | null;
  property_tax_category: string | null;
  home_insurance_category: string | null;
  pmi_category: string | null;
  tombstone: number;
};

type EscrowPeriodRow = {
  id: string;
  account_id: string;
  effective_date: string;
  property_tax_monthly: number | null;
  home_insurance_monthly: number | null;
  pmi_monthly: number | null;
  tombstone: number;
};

export type MortgageEscrowPeriod = {
  id: string;
  effectiveDate: string;
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
};

export type MortgageConfig = {
  accountId: string;
  annualInterestRate: number;
  originalPrincipal: number | null;
  startDate: string | null;
  termMonths: number | null;
  piPayment: number | null;
  escrowPeriods: MortgageEscrowPeriod[];
};

export type MortgageBreakdown = {
  paymentAmount: number;
  date: string;
  interest: number;
  propertyTax: number;
  homeInsurance: number;
  pmi: number;
  principal: number;
};

export type MortgageSplitResult = {
  principal: number;
  interest: number;
  propertyTax: number;
  homeInsurance: number;
  pmi: number;
};

export type MortgageSummary = {
  balance: number;
  originalPrincipal: number | null;
  principalPaid: number | null;
  interestPaid: number;
  taxPaid: number;
  insurancePaid: number;
  pmiPaid: number;
  escrowPaid: number;
};

type SplitOverrides = {
  interest?: number;
  propertyTax?: number;
  homeInsurance?: number;
  pmi?: number;
};

export type MortgageHandlers = {
  'mortgage-get-config': typeof getMortgageConfig;
  'mortgage-save-config': typeof saveMortgageConfig;
  'mortgage-set-escrow': typeof setEscrowPeriod;
  'mortgage-delete-escrow': typeof deleteEscrowPeriod;
  'mortgage-get-summary': typeof getMortgageSummary;
  'mortgage-preview-split': typeof previewMortgageSplit;
  'mortgage-split-payment': typeof splitMortgagePayment;
};

export const app = createApp<MortgageHandlers>();
app.method('mortgage-get-config', getMortgageConfig);
app.method('mortgage-save-config', mutator(saveMortgageConfig));
app.method('mortgage-set-escrow', mutator(setEscrowPeriod));
app.method('mortgage-delete-escrow', mutator(deleteEscrowPeriod));
app.method('mortgage-get-summary', getMortgageSummary);
app.method('mortgage-preview-split', previewMortgageSplit);
app.method('mortgage-split-payment', mutator(undoable(splitMortgagePayment)));

async function getConfigRow(
  accountId: string,
): Promise<MortgageConfigRow | null> {
  return db.first<MortgageConfigRow>(
    'SELECT * FROM mortgage_configs WHERE account_id = ? AND tombstone = 0',
    [accountId],
  );
}

async function getEscrowPeriods(
  accountId: string,
): Promise<MortgageEscrowPeriod[]> {
  const rows = await db.all<EscrowPeriodRow>(
    `SELECT * FROM mortgage_escrow_periods
      WHERE account_id = ? AND tombstone = 0
      ORDER BY effective_date`,
    [accountId],
  );
  return rows.map(r => ({
    id: r.id,
    effectiveDate: r.effective_date,
    propertyTaxMonthly: r.property_tax_monthly ?? 0,
    homeInsuranceMonthly: r.home_insurance_monthly ?? 0,
    pmiMonthly: r.pmi_monthly ?? 0,
  }));
}

export async function getMortgageConfig({
  accountId,
}: {
  accountId: string;
}): Promise<MortgageConfig | null> {
  const row = await getConfigRow(accountId);
  if (!row) {
    return null;
  }
  return {
    accountId: row.account_id,
    annualInterestRate: row.annual_interest_rate,
    originalPrincipal: row.original_principal ?? null,
    startDate: row.start_date ?? null,
    termMonths: row.term_months ?? null,
    piPayment: row.pi_payment ?? null,
    escrowPeriods: await getEscrowPeriods(accountId),
  };
}

// Create the "Mortgage" category group + its categories once, reusing them on
// later config saves.
async function ensureCategories(existing: MortgageConfigRow | null): Promise<{
  interest: string;
  propertyTax: string;
  homeInsurance: string;
  pmi: string;
}> {
  if (
    existing?.interest_category &&
    existing.property_tax_category &&
    existing.home_insurance_category &&
    existing.pmi_category
  ) {
    return {
      interest: existing.interest_category,
      propertyTax: existing.property_tax_category,
      homeInsurance: existing.home_insurance_category,
      pmi: existing.pmi_category,
    };
  }

  const groupId = await db.insertCategoryGroup({ name: 'Mortgage' });
  const interest = await db.insertCategory({
    name: 'Mortgage Interest',
    cat_group: groupId,
  });
  const propertyTax = await db.insertCategory({
    name: 'Property Tax',
    cat_group: groupId,
  });
  const homeInsurance = await db.insertCategory({
    name: 'Home Insurance',
    cat_group: groupId,
  });
  const pmi = await db.insertCategory({ name: 'PMI', cat_group: groupId });
  return { interest, propertyTax, homeInsurance, pmi };
}

export async function saveMortgageConfig({
  accountId,
  annualInterestRate,
  originalPrincipal,
  startDate,
  termMonths,
  piPayment,
}: {
  accountId: string;
  annualInterestRate: number;
  originalPrincipal?: number | null;
  startDate?: string | null;
  termMonths?: number | null;
  piPayment?: number | null;
}): Promise<'ok'> {
  if (!(annualInterestRate >= 0 && annualInterestRate < 1)) {
    throw new Error(
      'Enter the interest rate as a fraction, e.g. 0.065 for 6.5%.',
    );
  }
  const existing = await getConfigRow(accountId);
  const cats = await ensureCategories(existing);

  const round = (v: number | null | undefined) =>
    v != null ? Math.round(v) : null;
  const fields = {
    annual_interest_rate: annualInterestRate,
    original_principal: round(originalPrincipal),
    start_date: startDate ?? null,
    term_months: round(termMonths),
    pi_payment: round(piPayment),
    interest_category: cats.interest,
    property_tax_category: cats.propertyTax,
    home_insurance_category: cats.homeInsurance,
    pmi_category: cats.pmi,
  };

  if (existing) {
    await db.update('mortgage_configs', { id: existing.id, ...fields });
  } else {
    await db.insert('mortgage_configs', {
      id: uuidv4(),
      account_id: accountId,
      ...fields,
    });
  }
  return 'ok';
}

export async function setEscrowPeriod({
  accountId,
  id,
  effectiveDate,
  propertyTaxMonthly,
  homeInsuranceMonthly,
  pmiMonthly,
}: {
  accountId: string;
  id?: string;
  effectiveDate: string;
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
}): Promise<'ok'> {
  if (!effectiveDate) {
    throw new Error('Pick the date this escrow amount takes effect.');
  }
  const fields = {
    account_id: accountId,
    effective_date: effectiveDate,
    property_tax_monthly: Math.round(propertyTaxMonthly || 0),
    home_insurance_monthly: Math.round(homeInsuranceMonthly || 0),
    pmi_monthly: Math.round(pmiMonthly || 0),
  };

  // Upsert: prefer an explicit id, else replace any period already dated to the
  // same day so a re-entered date doesn't stack duplicates.
  let existingId = id ?? null;
  if (!existingId) {
    const dup = await db.first<{ id: string }>(
      `SELECT id FROM mortgage_escrow_periods
        WHERE account_id = ? AND effective_date = ? AND tombstone = 0`,
      [accountId, effectiveDate],
    );
    existingId = dup?.id ?? null;
  }

  if (existingId) {
    await db.update('mortgage_escrow_periods', { id: existingId, ...fields });
  } else {
    await db.insert('mortgage_escrow_periods', { id: uuidv4(), ...fields });
  }
  return 'ok';
}

export async function deleteEscrowPeriod({ id }: { id: string }): Promise<'ok'> {
  await db.delete_('mortgage_escrow_periods', id);
  return 'ok';
}

async function currentPrincipal(accountId: string): Promise<number> {
  const row = await db.first<{ balance: number | null }>(
    `SELECT sum(amount) AS balance FROM transactions
      WHERE acct = ? AND isParent = 0 AND tombstone = 0`,
    [accountId],
  );
  return Math.abs(row?.balance ?? 0);
}

async function sumCategory(category: string | null): Promise<number> {
  if (!category) {
    return 0;
  }
  const row = await db.first<{ s: number | null }>(
    'SELECT sum(amount) AS s FROM transactions WHERE category = ? AND tombstone = 0',
    [category],
  );
  return Math.abs(row?.s ?? 0);
}

export async function getMortgageSummary({
  accountId,
}: {
  accountId: string;
}): Promise<MortgageSummary | null> {
  const row = await getConfigRow(accountId);
  if (!row) {
    return null;
  }
  const balance = await currentPrincipal(accountId);
  const interestPaid = await sumCategory(row.interest_category);
  const taxPaid = await sumCategory(row.property_tax_category);
  const insurancePaid = await sumCategory(row.home_insurance_category);
  const pmiPaid = await sumCategory(row.pmi_category);
  const originalPrincipal = row.original_principal ?? null;
  return {
    balance,
    originalPrincipal,
    principalPaid:
      originalPrincipal != null ? originalPrincipal - balance : null,
    interestPaid,
    taxPaid,
    insurancePaid,
    pmiPaid,
    escrowPaid: taxPaid + insurancePaid + pmiPaid,
  };
}

async function resolveEscrow(
  accountId: string,
  date: string,
  row: MortgageConfigRow,
): Promise<EscrowAmounts> {
  const periods = await getEscrowPeriods(accountId);
  if (periods.length > 0) {
    return escrowForDate(periods, date);
  }
  // Back-compat: a config saved before escrow periods existed keeps its inline
  // amounts.
  return {
    propertyTaxMonthly: row.property_tax_monthly ?? 0,
    homeInsuranceMonthly: row.home_insurance_monthly ?? 0,
    pmiMonthly: row.pmi_monthly ?? 0,
  };
}

function computeBreakdown(
  row: MortgageConfigRow,
  paymentAbs: number,
  balance: number,
  escrow: EscrowAmounts,
  overrides?: SplitOverrides,
): Omit<MortgageBreakdown, 'paymentAmount' | 'date'> {
  const pick = (override: number | undefined, fallback: number) =>
    override != null ? Math.round(override) : fallback;

  const interest = pick(
    overrides?.interest,
    monthlyInterest(balance, row.annual_interest_rate),
  );
  const propertyTax = pick(overrides?.propertyTax, escrow.propertyTaxMonthly);
  const homeInsurance = pick(
    overrides?.homeInsurance,
    escrow.homeInsuranceMonthly,
  );
  const pmi = pick(overrides?.pmi, escrow.pmiMonthly);
  const principal = paymentAbs - interest - propertyTax - homeInsurance - pmi;

  return { interest, propertyTax, homeInsurance, pmi, principal };
}

async function loadPayment(transactionId: string): Promise<TransactionEntity> {
  const { data } = await aqlQuery(
    q('transactions')
      .filter({ id: transactionId })
      .select('*')
      .options({ splits: 'grouped' }),
  );
  const txn = (data as TransactionEntity[])[0];
  if (!txn) {
    throw new Error('Transaction not found.');
  }
  if (txn.is_parent || txn.is_child) {
    throw new Error(
      'Pick a plain, unsplit transaction — the monthly payment from your funding account.',
    );
  }
  return txn;
}

export async function previewMortgageSplit({
  transactionId,
  mortgageAccountId,
}: {
  transactionId: string;
  mortgageAccountId: string;
}): Promise<MortgageBreakdown> {
  const config = await getConfigRow(mortgageAccountId);
  if (!config) {
    throw new Error('Set up the mortgage terms for this account first.');
  }
  const txn = await loadPayment(transactionId);
  const paymentAbs = Math.abs(txn.amount);
  const balance = await currentPrincipal(mortgageAccountId);
  const escrow = await resolveEscrow(mortgageAccountId, txn.date, config);
  const breakdown = computeBreakdown(config, paymentAbs, balance, escrow);
  return { paymentAmount: paymentAbs, date: txn.date, ...breakdown };
}

export async function splitMortgagePayment({
  transactionId,
  mortgageAccountId,
  overrides,
}: {
  transactionId: string;
  mortgageAccountId: string;
  overrides?: SplitOverrides;
}): Promise<MortgageSplitResult> {
  const config = await getConfigRow(mortgageAccountId);
  if (!config) {
    throw new Error('Set up the mortgage terms for this account first.');
  }

  const txn = await loadPayment(transactionId);
  const paymentAbs = Math.abs(txn.amount);
  const balance = await currentPrincipal(mortgageAccountId);
  const escrow = await resolveEscrow(mortgageAccountId, txn.date, config);
  const { interest, propertyTax, homeInsurance, pmi, principal } =
    computeBreakdown(config, paymentAbs, balance, escrow, overrides);

  if (principal <= 0) {
    throw new Error(
      'The payment is smaller than interest + escrow — double-check the rate and escrow amounts.',
    );
  }

  const transferPayee = await db.first<{ id: string }>(
    'SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0',
    [mortgageAccountId],
  );
  if (!transferPayee) {
    throw new Error(
      'Could not find the transfer payee for the mortgage account.',
    );
  }

  // Payments are negative (money leaving the funding account); keep every child
  // the same sign so they sum to the parent.
  const sign = txn.amount < 0 ? -1 : 1;
  const parent: TransactionEntity = {
    ...txn,
    is_parent: true,
    category: undefined,
  };

  const parts: Array<{
    amount: number;
    category: string | null;
    payee?: string;
    notes: string;
  }> = [];
  if (interest > 0) {
    parts.push({
      amount: sign * interest,
      category: config.interest_category,
      notes: 'Interest',
    });
  }
  if (propertyTax > 0) {
    parts.push({
      amount: sign * propertyTax,
      category: config.property_tax_category,
      notes: 'Property tax',
    });
  }
  if (homeInsurance > 0) {
    parts.push({
      amount: sign * homeInsurance,
      category: config.home_insurance_category,
      notes: 'Home insurance',
    });
  }
  if (pmi > 0) {
    parts.push({
      amount: sign * pmi,
      category: config.pmi_category,
      notes: 'PMI',
    });
  }
  // Principal pays down the loan via a transfer into the mortgage account.
  parts.push({
    amount: sign * principal,
    category: null,
    payee: transferPayee.id,
    notes: 'Principal',
  });

  const children = parts.map((part, i) =>
    makeChild(parent, {
      amount: part.amount,
      category: part.category ?? undefined,
      ...(part.payee ? { payee: part.payee } : {}),
      notes: part.notes,
      sort_order: 0 - i,
    }),
  );

  const checked = recalculateSplit({ ...parent, subtransactions: children });
  if (checked.error) {
    throw new Error('Split does not sum to the payment amount.');
  }

  await batchUpdateTransactions({
    updated: [
      { id: txn.id, is_parent: true, category: null },
    ] as unknown as Partial<TransactionEntity>[],
    added: children,
  });

  return { principal, interest, propertyTax, homeInsurance, pmi };
}
