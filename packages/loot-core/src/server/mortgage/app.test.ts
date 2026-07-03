import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';
import { q } from '#shared/query';
import type { TransactionEntity } from '#types/models';

import { saveMortgageConfig, splitMortgagePayment } from './app';

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

  await db.insertAccount({ id: 'chk', name: 'Checking', offbudget: 0 });
  await db.insertPayee({ name: '', transfer_acct: 'chk' });
  await db.insertAccount({ id: 'mtg', name: 'Mortgage', offbudget: 1 });
  await db.insertPayee({ name: '', transfer_acct: 'mtg' });

  // Mortgage starting balance: -$400,000.
  await batchUpdateTransactions({
    added: [
      {
        id: 'mtg-start',
        account: 'mtg',
        amount: -40_000_000,
        date: '2026-01-01',
        starting_balance_flag: true,
      } as TransactionEntity,
    ],
  });
});

async function mortgageBalance(): Promise<number> {
  const row = await db.first<{ b: number }>(
    "SELECT sum(amount) AS b FROM transactions WHERE acct = 'mtg' AND isParent = 0 AND tombstone = 0",
  );
  return row?.b ?? 0;
}

async function getSplit(id: string) {
  const { data } = await aqlQuery(
    q('transactions').filter({ id }).select('*').options({ splits: 'grouped' }),
  );
  return (data as TransactionEntity[])[0];
}

describe('mortgage split', () => {
  it('breaks a payment into interest/escrow/principal and pays down the loan', async () => {
    await saveMortgageConfig({
      accountId: 'mtg',
      annualInterestRate: 0.06,
      propertyTaxMonthly: 50_000, // $500
      homeInsuranceMonthly: 10_000, // $100
      pmiMonthly: 0,
    });

    // Monthly payment on checking: $2,800.
    await batchUpdateTransactions({
      added: [
        {
          id: 'pay1',
          account: 'chk',
          amount: -280_000,
          date: '2026-02-01',
        } as TransactionEntity,
      ],
    });

    const res = await splitMortgagePayment({
      transactionId: 'pay1',
      mortgageAccountId: 'mtg',
    });

    // interest = $400,000 * 6% / 12 = $2,000; escrow = $600; principal = $200.
    expect(res).toEqual({
      principal: 20_000,
      interest: 200_000,
      propertyTax: 50_000,
      homeInsurance: 10_000,
      pmi: 0,
    });

    const parent = await getSplit('pay1');
    expect(parent.is_parent).toBe(true);
    // interest + tax + insurance + principal (pmi=0 is skipped).
    expect(parent.subtransactions).toHaveLength(4);
    const childSum = (parent.subtransactions ?? []).reduce(
      (acc, c) => acc + c.amount,
      0,
    );
    expect(childSum).toBe(-280_000);

    // Principal transferred into the mortgage account pays it down by $200.
    expect(await mortgageBalance()).toBe(-40_000_000 + 20_000);
  });

  it('rejects a payment smaller than interest + escrow', async () => {
    await saveMortgageConfig({
      accountId: 'mtg',
      annualInterestRate: 0.06,
      propertyTaxMonthly: 50_000,
      homeInsuranceMonthly: 10_000,
      pmiMonthly: 0,
    });
    await batchUpdateTransactions({
      added: [
        {
          id: 'small',
          account: 'chk',
          amount: -100_000, // $1,000 < $2,600 interest+escrow
          date: '2026-02-01',
        } as TransactionEntity,
      ],
    });
    await expect(
      splitMortgagePayment({ transactionId: 'small', mortgageAccountId: 'mtg' }),
    ).rejects.toThrow(/smaller than interest/i);
  });

  it('requires the interest rate as a fraction', async () => {
    await expect(
      saveMortgageConfig({
        accountId: 'mtg',
        annualInterestRate: 6.5,
        propertyTaxMonthly: 0,
        homeInsuranceMonthly: 0,
        pmiMonthly: 0,
      }),
    ).rejects.toThrow(/fraction/i);
  });
});
