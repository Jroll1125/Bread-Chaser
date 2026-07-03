import { v4 as uuidv4 } from 'uuid';

import { aqlQuery } from '#server/aql';
import { createApp } from '#server/app';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import {
  createSchedule,
  deleteSchedule,
  updateSchedule,
} from '#server/schedules/app';
import { batchUpdateTransactions } from '#server/transactions';
import { undoable } from '#server/undo';
import { q } from '#shared/query';
import { makeChild, recalculateSplit } from '#shared/transactions';
import type { RuleConditionEntity, TransactionEntity } from '#types/models';

/**
 * Quicken-style paychecks. A paycheck config is a reusable template: earnings
 * lines (income categories), pre-tax deductions, taxes, after-tax deductions,
 * and how net pay splits across deposit accounts. Entering a paycheck
 * generates one split transaction in the primary account — positive earnings
 * children, negative deduction children, and negative transfer children for
 * the secondary deposit accounts (their mirrors land there automatically,
 * and the transfer engine adopts already-imported bank rows instead of
 * duplicating them). A linked schedule provides the recurrence and the
 * reminder on the Schedules page; the bank feed later merges into the
 * entered transaction through the normal import matching.
 */

export type PaycheckLine = {
  name: string;
  category: string | null;
  amount: number;
};

export type PaycheckDeposit = {
  accountId: string;
  amount: number;
};

export type PaycheckFrequency = 'weekly' | 'biweekly' | 'monthly';

export type PaycheckConfig = {
  id: string;
  name: string;
  payeeId: string | null;
  accountId: string;
  scheduleId: string | null;
  earnings: PaycheckLine[];
  pretax: PaycheckLine[];
  taxes: PaycheckLine[];
  aftertax: PaycheckLine[];
  deposits: PaycheckDeposit[];
  qualifiedOt: number;
};

export type PaycheckBreakdown = {
  gross: number;
  totalPretax: number;
  totalTaxes: number;
  totalAftertax: number;
  net: number;
  secondaryDeposits: number;
  primaryDeposit: number;
};

type PaycheckConfigRow = {
  id: string;
  name: string | null;
  payee_id: string | null;
  account_id: string;
  schedule_id: string | null;
  earnings_json: string | null;
  pretax_json: string | null;
  taxes_json: string | null;
  aftertax_json: string | null;
  deposits_json: string | null;
  qualified_ot: number | null;
  tombstone: number;
};

export type PaycheckHandlers = {
  'paycheck-get-configs': typeof getPaycheckConfigs;
  'paycheck-save-config': typeof savePaycheckConfig;
  'paycheck-delete-config': typeof deletePaycheckConfig;
  'paycheck-find-match': typeof findPaycheckMatch;
  'paycheck-generate': typeof generatePaycheck;
};

export const app = createApp<PaycheckHandlers>();
app.method('paycheck-get-configs', getPaycheckConfigs);
app.method('paycheck-save-config', mutator(undoable(savePaycheckConfig)));
app.method('paycheck-delete-config', mutator(undoable(deletePaycheckConfig)));
app.method('paycheck-find-match', findPaycheckMatch);
app.method('paycheck-generate', mutator(undoable(generatePaycheck)));

function parseLines(json: string | null): PaycheckLine[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseDeposits(json: string | null): PaycheckDeposit[] {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function fromRow(row: PaycheckConfigRow): PaycheckConfig {
  return {
    id: row.id,
    name: row.name ?? 'Paycheck',
    payeeId: row.payee_id,
    accountId: row.account_id,
    scheduleId: row.schedule_id,
    earnings: parseLines(row.earnings_json),
    pretax: parseLines(row.pretax_json),
    taxes: parseLines(row.taxes_json),
    aftertax: parseLines(row.aftertax_json),
    deposits: parseDeposits(row.deposits_json),
    qualifiedOt: row.qualified_ot ?? 0,
  };
}

const sum = (values: Array<{ amount: number }>) =>
  values.reduce((total, v) => total + Math.round(v.amount || 0), 0);

export function computeBreakdown(config: {
  earnings: PaycheckLine[];
  pretax: PaycheckLine[];
  taxes: PaycheckLine[];
  aftertax: PaycheckLine[];
  deposits: PaycheckDeposit[];
}): PaycheckBreakdown {
  const gross = sum(config.earnings);
  const totalPretax = sum(config.pretax);
  const totalTaxes = sum(config.taxes);
  const totalAftertax = sum(config.aftertax);
  const net = gross - totalPretax - totalTaxes - totalAftertax;
  const secondaryDeposits = sum(config.deposits);
  return {
    gross,
    totalPretax,
    totalTaxes,
    totalAftertax,
    net,
    secondaryDeposits,
    primaryDeposit: net - secondaryDeposits,
  };
}

export async function getPaycheckConfigs(): Promise<PaycheckConfig[]> {
  const rows = await db.all<PaycheckConfigRow>(
    'SELECT * FROM paycheck_configs WHERE tombstone = 0',
  );
  return rows.map(fromRow);
}

async function findOrCreatePayee(name: string): Promise<string> {
  const existing = await db.first<{ id: string }>(
    'SELECT id FROM payees WHERE UPPER(name) = UPPER(?) AND tombstone = 0',
    [name],
  );
  if (existing) {
    return existing.id;
  }
  return db.insertPayee({ name });
}

async function findOrCreateGroup(
  name: string,
  isIncome: boolean,
): Promise<string> {
  if (isIncome) {
    const income = await db.first<{ id: string }>(
      'SELECT id FROM category_groups WHERE is_income = 1 AND tombstone = 0',
    );
    if (income) {
      return income.id;
    }
  }
  const existing = await db.first<{ id: string }>(
    'SELECT id FROM category_groups WHERE UPPER(name) = UPPER(?) AND tombstone = 0',
    [name],
  );
  if (existing) {
    return existing.id;
  }
  return db.insertCategoryGroup({ name, is_income: isIncome ? 1 : 0 });
}

async function findOrCreateCategory(
  name: string,
  groupId: string,
  isIncome: boolean,
): Promise<string> {
  const existing = await db.first<{ id: string }>(
    `SELECT id FROM categories
      WHERE UPPER(name) = UPPER(?) AND cat_group = ? AND tombstone = 0`,
    [name, groupId],
  );
  if (existing) {
    return existing.id;
  }
  return db.insertCategory({
    name,
    cat_group: groupId,
    is_income: isIncome ? 1 : 0,
  });
}

// Every line gets a category named after it: earnings live in the income
// group, taxes in a "Taxes" group, and both deduction kinds in a "Paycheck
// Deductions" group — mirroring Quicken's fixed category mapping.
async function ensureLineCategories(config: {
  earnings: PaycheckLine[];
  pretax: PaycheckLine[];
  taxes: PaycheckLine[];
  aftertax: PaycheckLine[];
}): Promise<void> {
  const incomeGroup = await findOrCreateGroup('Income', true);
  for (const line of config.earnings) {
    if (!line.category) {
      line.category = await findOrCreateCategory(line.name, incomeGroup, true);
    }
  }
  const taxGroup = await findOrCreateGroup('Taxes', false);
  for (const line of config.taxes) {
    if (!line.category) {
      line.category = await findOrCreateCategory(line.name, taxGroup, false);
    }
  }
  const deductionGroup = await findOrCreateGroup(
    'Paycheck Deductions',
    false,
  );
  for (const line of [...config.pretax, ...config.aftertax]) {
    if (!line.category) {
      line.category = await findOrCreateCategory(
        line.name,
        deductionGroup,
        false,
      );
    }
  }
}

async function upsertScheduleForConfig(
  config: PaycheckConfig,
  frequency: PaycheckFrequency,
  nextDate: string,
): Promise<string> {
  const breakdown = computeBreakdown(config);
  const dateValue = {
    start: nextDate,
    frequency: frequency === 'monthly' ? 'monthly' : 'weekly',
    interval: frequency === 'biweekly' ? 2 : 1,
    patterns: [],
    skipWeekend: false,
    weekendSolveMode: 'after',
    endMode: 'never',
    endOccurrences: 1,
    endDate: nextDate,
  };
  const conditions = [
    { op: 'isapprox', field: 'date', value: dateValue },
    { op: 'isapprox', field: 'amount', value: breakdown.primaryDeposit },
    { op: 'is', field: 'account', value: config.accountId },
    ...(config.payeeId
      ? [{ op: 'is', field: 'payee', value: config.payeeId }]
      : []),
  ] as RuleConditionEntity[];

  if (config.scheduleId) {
    await updateSchedule({
      schedule: { id: config.scheduleId, name: config.name },
      conditions,
    });
    return config.scheduleId;
  }
  return createSchedule({
    schedule: { name: config.name, posts_transaction: false },
    conditions,
  });
}

export async function savePaycheckConfig({
  id,
  name,
  payeeName,
  accountId,
  earnings,
  pretax,
  taxes,
  aftertax,
  deposits,
  qualifiedOt,
  frequency,
  nextDate,
}: {
  id?: string;
  name: string;
  payeeName: string;
  accountId: string;
  earnings: PaycheckLine[];
  pretax: PaycheckLine[];
  taxes: PaycheckLine[];
  aftertax: PaycheckLine[];
  deposits: PaycheckDeposit[];
  qualifiedOt?: number;
  frequency: PaycheckFrequency;
  nextDate: string;
}): Promise<PaycheckConfig> {
  if (!name.trim()) {
    throw new Error('Give the paycheck a name (usually the employer).');
  }
  if (!accountId) {
    throw new Error('Pick the account the paycheck is deposited into.');
  }
  const breakdown = computeBreakdown({
    earnings,
    pretax,
    taxes,
    aftertax,
    deposits,
  });
  if (breakdown.gross <= 0) {
    throw new Error('Earnings must add up to more than zero.');
  }
  if (breakdown.net <= 0) {
    throw new Error('Deductions exceed gross pay — check the amounts.');
  }
  if (breakdown.primaryDeposit < 0) {
    throw new Error(
      'Deposits to other accounts exceed net pay — check the amounts.',
    );
  }

  const config: PaycheckConfig = {
    id: id ?? uuidv4(),
    name: name.trim(),
    payeeId: await findOrCreatePayee(payeeName.trim() || name.trim()),
    accountId,
    scheduleId: null,
    earnings,
    pretax,
    taxes,
    aftertax,
    deposits,
    qualifiedOt: Math.round(qualifiedOt ?? 0),
  };

  await ensureLineCategories(config);

  if (id) {
    const existing = await db.first<Pick<PaycheckConfigRow, 'schedule_id'>>(
      'SELECT schedule_id FROM paycheck_configs WHERE id = ? AND tombstone = 0',
      [id],
    );
    config.scheduleId = existing?.schedule_id ?? null;
  }
  config.scheduleId = await upsertScheduleForConfig(
    config,
    frequency,
    nextDate,
  );

  const fields = {
    name: config.name,
    payee_id: config.payeeId,
    account_id: config.accountId,
    schedule_id: config.scheduleId,
    earnings_json: JSON.stringify(config.earnings),
    pretax_json: JSON.stringify(config.pretax),
    taxes_json: JSON.stringify(config.taxes),
    aftertax_json: JSON.stringify(config.aftertax),
    deposits_json: JSON.stringify(config.deposits),
    qualified_ot: config.qualifiedOt,
  };
  if (id) {
    await db.update('paycheck_configs', { id, ...fields });
  } else {
    await db.insert('paycheck_configs', { id: config.id, ...fields });
  }
  return config;
}

export async function deletePaycheckConfig({
  id,
}: {
  id: string;
}): Promise<'ok'> {
  const row = await db.first<Pick<PaycheckConfigRow, 'schedule_id'>>(
    'SELECT schedule_id FROM paycheck_configs WHERE id = ? AND tombstone = 0',
    [id],
  );
  await db.delete_('paycheck_configs', id);
  if (row?.schedule_id) {
    await deleteSchedule({ id: row.schedule_id });
  }
  return 'ok';
}

export type PaycheckMatch = {
  transactionId: string;
  amount: number;
  date: string;
  notes: string | null;
};

/**
 * Before entering a paycheck, look for a transaction that already sits in the
 * register for this deposit — same account, same date, and the same net amount
 * that would land in the account. That's almost always the bank's own deposit
 * row (imported or hand-entered), so entering the paycheck would duplicate it.
 * Returns the candidate so the UI can offer to replace it instead. Only plain,
 * unsplit rows are considered (an already-split paycheck has isParent = 1).
 */
export async function findPaycheckMatch({
  configId,
  date,
}: {
  configId: string;
  date: string;
}): Promise<PaycheckMatch | null> {
  const row = await db.first<PaycheckConfigRow>(
    'SELECT * FROM paycheck_configs WHERE id = ? AND tombstone = 0',
    [configId],
  );
  if (!row) {
    return null;
  }
  const config = fromRow(row);
  const breakdown = computeBreakdown(config);
  const dateInt = Number(date.replace(/-/g, ''));
  const match = await db.first<{
    id: string;
    amount: number;
    notes: string | null;
  }>(
    `SELECT id, amount, notes FROM transactions
      WHERE acct = ? AND date = ? AND amount = ?
        AND isParent = 0 AND isChild = 0 AND tombstone = 0
      ORDER BY sort_order LIMIT 1`,
    [config.accountId, dateInt, breakdown.primaryDeposit],
  );
  if (!match) {
    return null;
  }
  return {
    transactionId: match.id,
    amount: match.amount,
    date,
    notes: match.notes,
  };
}

// Load a plain, unsplit transaction to convert into a paycheck split.
async function loadPlainTransaction(id: string): Promise<TransactionEntity> {
  const { data } = await aqlQuery(
    q('transactions')
      .filter({ id })
      .select('*')
      .options({ splits: 'grouped' }),
  );
  const txn = (data as TransactionEntity[])[0];
  if (!txn) {
    throw new Error('The transaction to replace was not found.');
  }
  if (txn.is_parent || txn.is_child) {
    throw new Error('That transaction is already split — pick a plain one.');
  }
  return txn;
}

/**
 * Enter one paycheck: create the split transaction for the given date. Any
 * of the line groups can be overridden for this paycheck only (Quicken's
 * "Enter" dialog); omitted groups use the saved template amounts. When
 * `replaceTransactionId` is given, the paycheck split is written onto that
 * existing register row (converting it in place) instead of adding a new one —
 * this is how "replace the deposit already in the register" works.
 */
export async function generatePaycheck({
  configId,
  date,
  earnings,
  pretax,
  taxes,
  aftertax,
  deposits,
  replaceTransactionId,
}: {
  configId: string;
  date: string;
  earnings?: PaycheckLine[];
  pretax?: PaycheckLine[];
  taxes?: PaycheckLine[];
  aftertax?: PaycheckLine[];
  deposits?: PaycheckDeposit[];
  replaceTransactionId?: string;
}): Promise<{ transactionId: string; breakdown: PaycheckBreakdown }> {
  const row = await db.first<PaycheckConfigRow>(
    'SELECT * FROM paycheck_configs WHERE id = ? AND tombstone = 0',
    [configId],
  );
  if (!row) {
    throw new Error('Paycheck not found — set it up first.');
  }
  const config = fromRow(row);

  const resolved = {
    earnings: earnings ?? config.earnings,
    pretax: pretax ?? config.pretax,
    taxes: taxes ?? config.taxes,
    aftertax: aftertax ?? config.aftertax,
    deposits: deposits ?? config.deposits,
  };
  // Per-paycheck edits can introduce new lines; make sure they have
  // categories too.
  await ensureLineCategories(resolved);

  const breakdown = computeBreakdown(resolved);
  if (breakdown.net <= 0 || breakdown.primaryDeposit < 0) {
    throw new Error('This paycheck does not add up — check the amounts.');
  }

  // Replacing an existing deposit keeps that row's id, account, date and
  // cleared/imported state so the bank match and reconciliation survive; we
  // just relabel it and turn it into the split parent.
  const existing = replaceTransactionId
    ? await loadPlainTransaction(replaceTransactionId)
    : null;
  const parent: TransactionEntity = existing
    ? ({
        ...existing,
        amount: breakdown.primaryDeposit,
        payee: config.payeeId ?? existing.payee,
        notes: config.name,
        is_parent: true,
        category: undefined,
        ...(config.scheduleId ? { schedule: config.scheduleId } : {}),
      } as TransactionEntity)
    : ({
        id: uuidv4(),
        account: config.accountId,
        date,
        amount: breakdown.primaryDeposit,
        payee: config.payeeId ?? undefined,
        notes: config.name,
        is_parent: true,
        cleared: false,
        ...(config.scheduleId ? { schedule: config.scheduleId } : {}),
      } as TransactionEntity);

  const parts: Array<{
    amount: number;
    category?: string;
    payee?: string;
    notes: string;
  }> = [];
  for (const line of resolved.earnings) {
    if (line.amount) {
      parts.push({
        amount: Math.round(line.amount),
        category: line.category ?? undefined,
        notes: line.name,
      });
    }
  }
  for (const line of [
    ...resolved.pretax,
    ...resolved.taxes,
    ...resolved.aftertax,
  ]) {
    if (line.amount) {
      parts.push({
        amount: -Math.round(line.amount),
        category: line.category ?? undefined,
        notes: line.name,
      });
    }
  }
  for (const deposit of resolved.deposits) {
    if (!deposit.amount) {
      continue;
    }
    const transferPayee = await db.first<{ id: string }>(
      'SELECT id FROM payees WHERE transfer_acct = ? AND tombstone = 0',
      [deposit.accountId],
    );
    if (!transferPayee) {
      throw new Error('Could not find the transfer payee for a deposit account.');
    }
    parts.push({
      amount: -Math.round(deposit.amount),
      payee: transferPayee.id,
      notes: 'Deposit',
    });
  }

  const children = parts.map((part, i) =>
    makeChild(parent, {
      amount: part.amount,
      category: part.category,
      ...(part.payee ? { payee: part.payee } : {}),
      notes: part.notes,
      sort_order: 0 - i,
    }),
  );

  const checked = recalculateSplit({ ...parent, subtransactions: children });
  if (checked.error) {
    throw new Error('Paycheck split does not sum to the net deposit.');
  }

  if (existing) {
    await batchUpdateTransactions({
      updated: [
        {
          id: existing.id,
          amount: parent.amount,
          payee: parent.payee,
          notes: parent.notes,
          is_parent: true,
          category: null,
          ...(config.scheduleId ? { schedule: config.scheduleId } : {}),
        },
      ] as unknown as Partial<TransactionEntity>[],
      added: children,
    });
  } else {
    await batchUpdateTransactions({ added: [parent, ...children] });
  }

  return { transactionId: parent.id, breakdown };
}
