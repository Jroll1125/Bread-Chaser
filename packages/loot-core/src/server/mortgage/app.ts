import { v4 as uuidv4 } from 'uuid';

import { aqlQuery } from '#server/aql';
import { createApp } from '#server/app';
import * as db from '#server/db';
import { getLlmSettings } from '#server/email/receipts';
import { extractStatement } from '#server/mortgage/statement-extract';
import { mutator } from '#server/mutators';
import { batchUpdateTransactions } from '#server/transactions';
import { undoable } from '#server/undo';
import {
  buildSchedule,
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
  'mortgage-parse-statements': typeof parseStatements;
  'mortgage-split-payment': typeof splitMortgagePayment;
  'mortgage-get-payments': typeof getMortgagePayments;
};

export const app = createApp<MortgageHandlers>();
app.method('mortgage-get-config', getMortgageConfig);
app.method('mortgage-save-config', mutator(saveMortgageConfig));
app.method('mortgage-set-escrow', mutator(setEscrowPeriod));
app.method('mortgage-delete-escrow', mutator(deleteEscrowPeriod));
app.method('mortgage-get-summary', getMortgageSummary);
app.method('mortgage-preview-split', previewMortgageSplit);
app.method('mortgage-parse-statements', parseStatements);
app.method('mortgage-split-payment', mutator(undoable(splitMortgagePayment)));
app.method('mortgage-get-payments', getMortgagePayments);

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

// Interest for a payment taken straight off the loan's amortization schedule
// (from the entered terms), anchored by the payment's date. This is
// authoritative even when the tracked account balance has drifted from the
// servicer's — a Plaid-reported loan balance is frequently wrong, which would
// otherwise compute interest on the wrong principal. Returns null when the
// terms needed to build a schedule aren't set.
function scheduledInterest(
  row: MortgageConfigRow,
  paymentDate: string,
): number | null {
  if (!row.original_principal || !row.start_date || !row.pi_payment) {
    return null;
  }
  const schedule = buildSchedule({
    balance: row.original_principal,
    annualRate: row.annual_interest_rate,
    piPayment: row.pi_payment,
    count: row.term_months ?? 360,
    startDate: row.start_date,
  });
  const ym = paymentDate.slice(0, 7);
  const match = schedule.find(r => r.date?.slice(0, 7) === ym);
  if (match) {
    return match.interest;
  }
  // A payment dated before the schedule starts uses the first month's interest.
  if (schedule.length > 0 && paymentDate < (schedule[0].date ?? '')) {
    return schedule[0].interest;
  }
  return null;
}

function computeBreakdown(
  paymentAbs: number,
  defaultInterest: number,
  escrow: EscrowAmounts,
  overrides?: SplitOverrides,
): Omit<MortgageBreakdown, 'paymentAmount' | 'date'> {
  const pick = (override: number | undefined, fallback: number) =>
    override != null ? Math.round(override) : fallback;

  const interest = pick(overrides?.interest, defaultInterest);
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
  const defaultInterest =
    scheduledInterest(config, txn.date) ??
    monthlyInterest(balance, config.annual_interest_rate);
  const breakdown = computeBreakdown(paymentAbs, defaultInterest, escrow);
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
  const defaultInterest =
    scheduledInterest(config, txn.date) ??
    monthlyInterest(balance, config.annual_interest_rate);
  const { interest, propertyTax, homeInsurance, pmi, principal } =
    computeBreakdown(paymentAbs, defaultInterest, escrow, overrides);

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

  // The Principal child must come out the other side as a real transfer — a
  // mirror transaction on the mortgage account, linked via transfer_id. That
  // mirror is what actually pays the loan down; without it the split is
  // cosmetic and the loan balance never moves.
  const principalChildId = String(children[children.length - 1].id);
  await ensurePrincipalTransfer(principalChildId, transferPayee.id);

  return { principal, interest, propertyTax, homeInsurance, pmi };
}

async function getRawTransferId(transactionId: string): Promise<string | null> {
  const row = await db.first<{ transferred_id: string | null }>(
    'SELECT transferred_id FROM transactions WHERE id = ?',
    [transactionId],
  );
  return row?.transferred_id ?? null;
}

// Belt and suspenders for the split's loan side: verify the principal child
// linked up as a transfer, and if the insert-time hook didn't materialize the
// mirror, re-assert the transfer payee through the normal update path (which
// runs the transfer hook). Still unlinked after that is an error worth
// surfacing — a silently missing mirror is how loan balances drift.
async function ensurePrincipalTransfer(
  childId: string,
  transferPayeeId: string,
): Promise<void> {
  if ((await getRawTransferId(childId)) != null) {
    return;
  }
  await batchUpdateTransactions({
    updated: [
      { id: childId, payee: transferPayeeId },
    ] as unknown as Partial<TransactionEntity>[],
  });
  if ((await getRawTransferId(childId)) == null) {
    throw new Error(
      'The Principal line did not link as a transfer into the mortgage ' +
        'account, so the loan side of this payment is missing. Undo the ' +
        'split and try again.',
    );
  }
}

export type StatementInput = { fileName: string; text: string };

export type StatementProposal = {
  fileName: string;
  status: 'matched' | 'already-split' | 'no-match' | 'extract-failed' | 'invalid';
  statementDate: string | null;
  dueDate: string | null;
  matchedTransactionId: string | null;
  matchedDate: string | null;
  payment: number | null;
  interest: number;
  taxAndInsurance: number;
  propertyTax: number;
  homeInsurance: number;
  pmi: number;
  principal: number | null;
};

// Transactions store the date as an integer yyyymmdd; parse yyyy-mm-dd in local
// time (never `new Date('yyyy-mm-dd')`, which is UTC and shifts a day).
function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function toDateInt(d: Date): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function dateIntToYmd(n: number): string {
  const y = Math.floor(n / 10000);
  const m = Math.floor((n % 10000) / 100);
  const d = n % 100;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// The "amount due" is the payment due the month after the statement, so derive
// that due date from the statement date (which the model reads reliably); fall
// back to whatever dueDate it returned.
function deriveDueDate(ext: {
  statementDate: string | null;
  dueDate: string | null;
}): string | null {
  if (ext.statementDate) {
    const [y, m] = ext.statementDate.split('-').map(Number);
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return `${ny}-${String(nm).padStart(2, '0')}-01`;
  }
  return ext.dueDate;
}

// The posted mortgage payment for a statement: a debit near the due date whose
// amount leaves a positive, plausible principal after interest + escrow.
async function findPaymentTransaction(
  mortgageAccountId: string,
  minAmount: number, // interest + escrow, cents (principal must be > 0)
  dueDate: string,
): Promise<{ id: string; amount: number; date: number } | null> {
  const due = parseYmd(dueDate);
  const start = new Date(due);
  start.setDate(start.getDate() - 20);
  const end = new Date(due);
  end.setDate(end.getDate() + 15);
  const rows = await db.all<{ id: string; amount: number; date: number }>(
    `SELECT id, amount, date FROM transactions
      WHERE acct != ? AND isParent = 0 AND isChild = 0 AND tombstone = 0
        AND amount < 0 AND (-amount) > ? AND (-amount) <= ?
        AND date >= ? AND date <= ?
      ORDER BY ABS(date - ?) LIMIT 1`,
    [
      mortgageAccountId,
      minAmount,
      minAmount + 200_000, // principal under $2,000
      toDateInt(start),
      toDateInt(end),
      toDateInt(due),
    ],
  );
  return rows[0] ?? null;
}

// A statement whose payment was split on an earlier import still has value —
// its PDF can attach to the split parent. Same window/amount logic as
// findPaymentTransaction, but over split parents.
async function findSplitPaymentParent(
  mortgageAccountId: string,
  minAmount: number,
  dueDate: string,
): Promise<{ id: string; amount: number; date: number } | null> {
  const due = parseYmd(dueDate);
  const start = new Date(due);
  start.setDate(start.getDate() - 20);
  const end = new Date(due);
  end.setDate(end.getDate() + 15);
  const rows = await db.all<{ id: string; amount: number; date: number }>(
    `SELECT id, amount, date FROM transactions
      WHERE acct != ? AND isParent = 1 AND tombstone = 0
        AND amount < 0 AND (-amount) > ? AND (-amount) <= ?
        AND date >= ? AND date <= ?
      ORDER BY ABS(date - ?) LIMIT 1`,
    [
      mortgageAccountId,
      minAmount,
      minAmount + 200_000,
      toDateInt(start),
      toDateInt(end),
      toDateInt(due),
    ],
  );
  return rows[0] ?? null;
}

// Split the statement's single Tax & Insurance figure into the user's
// tax/insurance/PMI categories using the ratio configured for that date. With
// no ratio set, it all goes to property tax (still one editable line in review).
function allocateEscrow(
  periods: MortgageEscrowPeriod[],
  date: string,
  totalTI: number,
): { propertyTax: number; homeInsurance: number; pmi: number } {
  const e = escrowForDate(periods, date);
  const configTotal =
    e.propertyTaxMonthly + e.homeInsuranceMonthly + e.pmiMonthly;
  if (configTotal <= 0) {
    return { propertyTax: totalTI, homeInsurance: 0, pmi: 0 };
  }
  const propertyTax = Math.round((totalTI * e.propertyTaxMonthly) / configTotal);
  const homeInsurance = Math.round(
    (totalTI * e.homeInsuranceMonthly) / configTotal,
  );
  return {
    propertyTax,
    homeInsurance,
    pmi: totalTI - propertyTax - homeInsurance,
  };
}

// Read a batch of statement texts with the local model and match each to its
// posted payment, producing an editable proposal per statement. Read-only — the
// user applies the ones they want from the review screen (via
// mortgage-split-payment). A dead local model throws so the whole import stops
// with a clear message rather than silently matching nothing.
export async function parseStatements({
  accountId,
  statements,
}: {
  accountId: string;
  statements: StatementInput[];
}): Promise<StatementProposal[]> {
  const config = await getConfigRow(accountId);
  if (!config) {
    throw new Error('Set up the mortgage terms for this account first.');
  }
  const { endpoint, model } = await getLlmSettings();
  const periods = await getEscrowPeriods(accountId);
  const out: StatementProposal[] = [];

  for (const statement of statements) {
    const blank = {
      fileName: statement.fileName,
      statementDate: null,
      dueDate: null,
      matchedTransactionId: null,
      matchedDate: null,
      payment: null,
      interest: 0,
      taxAndInsurance: 0,
      propertyTax: 0,
      homeInsurance: 0,
      pmi: 0,
      principal: null,
    };

    const ext = await extractStatement(statement.text, { endpoint, model });
    if (!ext) {
      out.push({ ...blank, status: 'extract-failed' });
      continue;
    }

    const dueDate = deriveDueDate(ext);
    const minAmount = ext.interest + ext.taxAndInsurance;
    const match = dueDate
      ? await findPaymentTransaction(accountId, minAmount, dueDate)
      : null;

    if (!match) {
      // Already split on an earlier pass? Offer to attach the PDF to it.
      const splitParent = dueDate
        ? await findSplitPaymentParent(accountId, minAmount, dueDate)
        : null;
      if (splitParent) {
        out.push({
          ...blank,
          status: 'already-split',
          statementDate: ext.statementDate,
          dueDate,
          matchedTransactionId: splitParent.id,
          matchedDate: dateIntToYmd(splitParent.date),
          payment: Math.abs(splitParent.amount),
          interest: ext.interest,
          taxAndInsurance: ext.taxAndInsurance,
        });
        continue;
      }
      out.push({
        ...blank,
        status: 'no-match',
        statementDate: ext.statementDate,
        dueDate,
        interest: ext.interest,
        taxAndInsurance: ext.taxAndInsurance,
      });
      continue;
    }

    const payment = Math.abs(match.amount);
    const principal = payment - ext.interest - ext.taxAndInsurance;
    const matchedDate = dateIntToYmd(match.date);
    if (principal <= 0) {
      out.push({
        ...blank,
        status: 'invalid',
        statementDate: ext.statementDate,
        dueDate,
        matchedTransactionId: match.id,
        matchedDate,
        payment,
        interest: ext.interest,
        taxAndInsurance: ext.taxAndInsurance,
      });
      continue;
    }

    const escrow = allocateEscrow(periods, matchedDate, ext.taxAndInsurance);
    out.push({
      fileName: statement.fileName,
      status: 'matched',
      statementDate: ext.statementDate,
      dueDate,
      matchedTransactionId: match.id,
      matchedDate,
      payment,
      interest: ext.interest,
      taxAndInsurance: ext.taxAndInsurance,
      ...escrow,
      principal,
    });
  }

  return out;
}

export type MortgagePaymentRow = {
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
  // False means the Principal child never linked as a transfer, so this
  // payment has no mirror on the loan — worth surfacing in the UI.
  hasTransfer: boolean;
  attachmentCount: number;
};

/**
 * Every split payment that feeds this mortgage, seen from the loan's side:
 * any split whose Principal child is addressed to this account's transfer
 * payee, whether or not the mirror actually linked up. Powers the payment
 * history on the mortgage account page.
 */
export async function getMortgagePayments({
  accountId,
}: {
  accountId: string;
}): Promise<MortgagePaymentRow[]> {
  const config = await getConfigRow(accountId);
  if (!config) {
    return [];
  }
  const transferPayee = await db.first<{ id: string }>(
    'SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0',
    [accountId],
  );
  if (!transferPayee) {
    return [];
  }

  const spines = await db.all<{
    parent_id: string;
    funding_acct: string;
    funding_name: string | null;
    pdate: number;
    total: number;
    principal: number;
    transferred_id: string | null;
  }>(
    `SELECT p.id AS parent_id, p.acct AS funding_acct, a.name AS funding_name,
            p.date AS pdate, p.amount AS total,
            child.amount AS principal, child.transferred_id
       FROM transactions child
       JOIN transactions p ON p.id = child.parent_id
       LEFT JOIN accounts a ON a.id = p.acct
      WHERE child.description = ? AND child.isChild = 1
        AND child.tombstone = 0 AND p.tombstone = 0
      ORDER BY p.date DESC`,
    [transferPayee.id],
  );
  if (spines.length === 0) {
    return [];
  }

  const parentIds = spines.map(s => s.parent_id);
  const placeholders = parentIds.map(() => '?').join(',');
  const childRows = await db.all<{
    parent_id: string;
    category: string | null;
    amount: number;
  }>(
    `SELECT parent_id, category, amount FROM transactions
      WHERE parent_id IN (${placeholders}) AND isChild = 1 AND tombstone = 0`,
    parentIds,
  );
  const attachRows = await db.all<{ transaction_id: string; n: number }>(
    `SELECT transaction_id, COUNT(*) AS n FROM transaction_attachments
      WHERE transaction_id IN (${placeholders}) AND tombstone = 0
      GROUP BY transaction_id`,
    parentIds,
  );

  const byParent = new Map<
    string,
    { interest: number; tax: number; ins: number; pmi: number }
  >();
  for (const c of childRows) {
    const bucket = byParent.get(c.parent_id) ?? {
      interest: 0,
      tax: 0,
      ins: 0,
      pmi: 0,
    };
    const amt = Math.abs(c.amount);
    if (c.category === config.interest_category) {
      bucket.interest += amt;
    } else if (c.category === config.property_tax_category) {
      bucket.tax += amt;
    } else if (c.category === config.home_insurance_category) {
      bucket.ins += amt;
    } else if (c.category === config.pmi_category) {
      bucket.pmi += amt;
    }
    byParent.set(c.parent_id, bucket);
  }
  const attachCount = new Map(
    attachRows.map(r => [r.transaction_id, r.n] as const),
  );

  return spines.map(s => {
    const bucket = byParent.get(s.parent_id);
    return {
      parentId: s.parent_id,
      fundingAccountId: s.funding_acct,
      fundingAccountName: s.funding_name ?? 'Unknown account',
      date: dateIntToYmd(s.pdate),
      total: Math.abs(s.total),
      interest: bucket?.interest ?? 0,
      propertyTax: bucket?.tax ?? 0,
      homeInsurance: bucket?.ins ?? 0,
      pmi: bucket?.pmi ?? 0,
      principal: Math.abs(s.principal),
      hasTransfer: s.transferred_id != null,
      attachmentCount: attachCount.get(s.parent_id) ?? 0,
    };
  });
}
