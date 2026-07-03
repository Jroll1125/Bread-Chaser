import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';
import type { TransactionEntity } from '#types/models';

import {
  computeBreakdown,
  findPaycheckMatch,
  generatePaycheck,
  getPaycheckConfigs,
  savePaycheckConfig,
} from './app';

// Declared untyped in mocks/setup.ts; this file is strict.
const emptyDatabase = (
  global as unknown as {
    emptyDatabase: (avoidUpdate?: boolean) => () => Promise<void>;
  }
).emptyDatabase;

beforeEach(async () => {
  await emptyDatabase()();
  await loadMappings();
  await loadRules();

  await db.insertCategoryGroup({ id: 'income-grp', name: 'Income', is_income: 1 });
  await db.insertAccount({ id: 'checking', name: 'Flex Checking', offbudget: 0 });
  await db.insertPayee({ name: '', transfer_acct: 'checking' });
  await db.insertAccount({ id: 'savings', name: 'Member Share Savings', offbudget: 0 });
  await db.insertPayee({ name: '', transfer_acct: 'savings' });
});

// Ben's real stub: gross 2,694.86; taxes 870.16; net 1,824.70; split
// 912.35 / 912.35 across checking and savings.
const EARNINGS = [
  { name: 'Hourly+Bonus', category: null, amount: 267_480 },
  { name: 'Hourly+Bonus Overtime', category: null, amount: 2_006 },
];
const TAXES = [
  { name: 'County Tax', category: null, amount: 4_447 },
  { name: 'Federal Tax', category: null, amount: 50_500 },
  { name: 'Social Security (FICA)', category: null, amount: 16_709 },
  { name: 'Medicare Tax', category: null, amount: 3_907 },
  { name: 'State Tax', category: null, amount: 11_453 },
];
const DEPOSITS = [{ accountId: 'savings', amount: 91_235 }];

function baseConfigInput() {
  return {
    name: 'Rock Run Industries',
    payeeName: 'Rock Run Industries',
    accountId: 'checking',
    earnings: structuredClone(EARNINGS),
    pretax: [],
    taxes: structuredClone(TAXES),
    aftertax: [],
    deposits: structuredClone(DEPOSITS),
    qualifiedOt: 1_910,
    frequency: 'weekly' as const,
    nextDate: '2026-04-10',
  };
}

describe('paycheck', () => {
  it('computes the Quicken breakdown to the cent', () => {
    const breakdown = computeBreakdown({
      earnings: EARNINGS,
      pretax: [],
      taxes: TAXES,
      aftertax: [],
      deposits: DEPOSITS,
    });
    expect(breakdown.gross).toBe(269_486);
    expect(breakdown.totalTaxes).toBe(87_016);
    expect(breakdown.net).toBe(182_470);
    expect(breakdown.secondaryDeposits).toBe(91_235);
    expect(breakdown.primaryDeposit).toBe(91_235);
  });

  it('saves a config, creating categories and a linked schedule', async () => {
    const config = await savePaycheckConfig(baseConfigInput());

    // Every line got a category: earnings in the income group, taxes in a
    // Taxes group.
    for (const line of [...config.earnings, ...config.taxes]) {
      expect(line.category).toBeTruthy();
    }
    const salary = await db.first<{ cat_group: string; is_income: number }>(
      'SELECT cat_group, is_income FROM categories WHERE name = ?',
      ['Hourly+Bonus'],
    );
    expect(salary?.cat_group).toBe('income-grp');
    expect(salary?.is_income).toBe(1);

    expect(config.scheduleId).toBeTruthy();
    const schedule = await db.first<{ id: string }>(
      'SELECT id FROM schedules WHERE id = ? AND tombstone = 0',
      [String(config.scheduleId)],
    );
    expect(schedule).toBeTruthy();

    const configs = await getPaycheckConfigs();
    expect(configs).toHaveLength(1);
    expect(configs[0].name).toBe('Rock Run Industries');
  });

  it('generates the split: earnings, taxes, and a savings transfer', async () => {
    const config = await savePaycheckConfig(baseConfigInput());
    const { transactionId, breakdown } = await generatePaycheck({
      configId: config.id,
      date: '2026-04-10',
    });
    expect(breakdown.primaryDeposit).toBe(91_235);

    const parent = await db.first<{
      amount: number;
      isParent: number;
      acct: string;
    }>(
      'SELECT amount, isParent, acct FROM transactions WHERE id = ?',
      [transactionId],
    );
    expect(parent?.amount).toBe(91_235);
    expect(parent?.isParent).toBe(1);
    expect(parent?.acct).toBe('checking');

    // Children sum to the parent; the deposit child is a live transfer.
    const children = await db.all<{
      amount: number;
      transferred_id: string | null;
      notes: string;
    }>(
      'SELECT amount, transferred_id, notes FROM transactions WHERE parent_id = ? AND tombstone = 0',
      [transactionId],
    );
    expect(children.reduce((acc, c) => acc + c.amount, 0)).toBe(91_235);
    const deposit = children.find(c => c.notes === 'Deposit');
    expect(deposit?.amount).toBe(-91_235);
    expect(deposit?.transferred_id).toBeTruthy();

    // The mirror pays the savings account.
    const mirror = await db.first<{ amount: number }>(
      "SELECT amount FROM transactions WHERE acct = 'savings' AND tombstone = 0",
    );
    expect(mirror?.amount).toBe(91_235);
  });

  it('adopts an already-imported savings deposit instead of duplicating', async () => {
    // The bank already delivered the savings half of the paycheck.
    await batchUpdateTransactions({
      added: [
        {
          id: 'imported-dep',
          account: 'savings',
          amount: 91_235,
          date: '2026-04-10',
        } as TransactionEntity,
      ],
    });
    await db.updateTransaction({ id: 'imported-dep', imported_id: 'bank-1' });

    const config = await savePaycheckConfig(baseConfigInput());
    await generatePaycheck({ configId: config.id, date: '2026-04-10' });

    const savingsRows = await db.all<{ id: string; transferred_id: string }>(
      "SELECT id, transferred_id FROM transactions WHERE acct = 'savings' AND tombstone = 0",
    );
    expect(savingsRows).toHaveLength(1);
    expect(savingsRows[0].id).toBe('imported-dep');
    expect(savingsRows[0].transferred_id).toBeTruthy();
  });

  it('finds a plain register deposit to replace', async () => {
    const config = await savePaycheckConfig(baseConfigInput());
    // The net that stays in checking is 91,235 — the bank's own deposit row.
    await batchUpdateTransactions({
      added: [
        {
          id: 'bank-dep',
          account: 'checking',
          amount: 91_235,
          date: '2026-04-10',
        } as TransactionEntity,
      ],
    });

    const match = await findPaycheckMatch({
      configId: config.id,
      date: '2026-04-10',
    });
    expect(match?.transactionId).toBe('bank-dep');
    expect(match?.amount).toBe(91_235);

    // A different date has nothing to replace.
    const none = await findPaycheckMatch({
      configId: config.id,
      date: '2026-04-17',
    });
    expect(none).toBeNull();
  });

  it('replaces the matched deposit in place instead of duplicating', async () => {
    const config = await savePaycheckConfig(baseConfigInput());
    await batchUpdateTransactions({
      added: [
        {
          id: 'bank-dep',
          account: 'checking',
          amount: 91_235,
          date: '2026-04-10',
        } as TransactionEntity,
      ],
    });

    const { transactionId } = await generatePaycheck({
      configId: config.id,
      date: '2026-04-10',
      replaceTransactionId: 'bank-dep',
    });
    expect(transactionId).toBe('bank-dep');

    // The matched row became the split parent — no second checking parent.
    const parents = await db.all<{ id: string }>(
      "SELECT id FROM transactions WHERE acct = 'checking' AND isParent = 1 AND tombstone = 0",
    );
    expect(parents).toHaveLength(1);
    expect(parents[0].id).toBe('bank-dep');

    const children = await db.all<{ amount: number }>(
      'SELECT amount FROM transactions WHERE parent_id = ? AND tombstone = 0',
      ['bank-dep'],
    );
    expect(children.reduce((acc, c) => acc + c.amount, 0)).toBe(91_235);
  });

  it('rejects deposits that exceed net pay', async () => {
    await expect(
      savePaycheckConfig({
        ...baseConfigInput(),
        deposits: [{ accountId: 'savings', amount: 999_999 }],
      }),
    ).rejects.toThrow(/exceed net pay/i);
  });
});
