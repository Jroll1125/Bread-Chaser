import { aqlQuery } from '#server/aql';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';
import { q } from '#shared/query';
import type { TransactionEntity } from '#types/models';

import {
  getMortgageSummary,
  previewMortgageSplit,
  saveMortgageConfig,
  setEscrowPeriod,
  splitMortgagePayment,
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

async function addPayment(id: string, amount: number, date: string) {
  await batchUpdateTransactions({
    added: [{ id, account: 'chk', amount, date } as TransactionEntity],
  });
}

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
    await saveMortgageConfig({ accountId: 'mtg', annualInterestRate: 0.06 });
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-01-01',
      propertyTaxMonthly: 50_000, // $500
      homeInsuranceMonthly: 10_000, // $100
      pmiMonthly: 0,
    });

    // Monthly payment on checking: $2,800.
    await addPayment('pay1', -280_000, '2026-02-01');

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

  it('uses the escrow amount in force on the payment date', async () => {
    await saveMortgageConfig({ accountId: 'mtg', annualInterestRate: 0.06 });
    // $600/mo through June, then $900/mo from July's analysis onward.
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-01-01',
      propertyTaxMonthly: 50_000,
      homeInsuranceMonthly: 10_000,
      pmiMonthly: 0,
    });
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-07-01',
      propertyTaxMonthly: 70_000,
      homeInsuranceMonthly: 20_000,
      pmiMonthly: 0,
    });

    // An August payment must use the newer $900 escrow.
    await addPayment('aug', -310_000, '2026-08-01');
    const res = await splitMortgagePayment({
      transactionId: 'aug',
      mortgageAccountId: 'mtg',
    });

    expect(res.propertyTax).toBe(70_000);
    expect(res.homeInsurance).toBe(20_000);
    expect(res.interest).toBe(200_000);
    // principal = $3,100 - $2,000 - $900 = $200.
    expect(res.principal).toBe(20_000);
  });

  it('applies per-line overrides from the statement and auto-balances principal', async () => {
    await saveMortgageConfig({ accountId: 'mtg', annualInterestRate: 0.06 });
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-01-01',
      propertyTaxMonthly: 50_000,
      homeInsuranceMonthly: 10_000,
      pmiMonthly: 0,
    });
    await addPayment('pay1', -280_000, '2026-02-01');

    const res = await splitMortgagePayment({
      transactionId: 'pay1',
      mortgageAccountId: 'mtg',
      overrides: { interest: 195_000, propertyTax: 55_000 },
    });

    // Overridden interest + tax; insurance from the period; principal fills the
    // remainder so the split still sums to $2,800.
    expect(res).toEqual({
      interest: 195_000,
      propertyTax: 55_000,
      homeInsurance: 10_000,
      pmi: 0,
      principal: 20_000,
    });
    const parent = await getSplit('pay1');
    const childSum = (parent.subtransactions ?? []).reduce(
      (acc, c) => acc + c.amount,
      0,
    );
    expect(childSum).toBe(-280_000);
  });

  it('previews the default breakdown without splitting the transaction', async () => {
    await saveMortgageConfig({ accountId: 'mtg', annualInterestRate: 0.06 });
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-01-01',
      propertyTaxMonthly: 50_000,
      homeInsuranceMonthly: 10_000,
      pmiMonthly: 0,
    });
    await addPayment('pay1', -280_000, '2026-02-01');

    const preview = await previewMortgageSplit({
      transactionId: 'pay1',
      mortgageAccountId: 'mtg',
    });
    expect(preview).toMatchObject({
      paymentAmount: 280_000,
      date: '2026-02-01',
      interest: 200_000,
      propertyTax: 50_000,
      homeInsurance: 10_000,
      pmi: 0,
      principal: 20_000,
    });

    // Preview must not mutate — the transaction is still plain.
    const txn = await getSplit('pay1');
    expect(txn.is_parent).toBeFalsy();
  });

  it('summarizes interest, escrow, and principal paid to date', async () => {
    await saveMortgageConfig({
      accountId: 'mtg',
      annualInterestRate: 0.06,
      originalPrincipal: 40_000_000,
      startDate: '2026-01-01',
      termMonths: 360,
    });
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-01-01',
      propertyTaxMonthly: 50_000,
      homeInsuranceMonthly: 10_000,
      pmiMonthly: 0,
    });
    await addPayment('pay1', -280_000, '2026-02-01');
    await splitMortgagePayment({
      transactionId: 'pay1',
      mortgageAccountId: 'mtg',
    });

    const summary = await getMortgageSummary({ accountId: 'mtg' });
    expect(summary).toMatchObject({
      balance: 39_980_000,
      originalPrincipal: 40_000_000,
      principalPaid: 20_000,
      interestPaid: 200_000,
      taxPaid: 50_000,
      insurancePaid: 10_000,
      pmiPaid: 0,
      escrowPaid: 60_000,
    });
  });

  it('rejects a payment smaller than interest + escrow', async () => {
    await saveMortgageConfig({ accountId: 'mtg', annualInterestRate: 0.06 });
    await setEscrowPeriod({
      accountId: 'mtg',
      effectiveDate: '2026-01-01',
      propertyTaxMonthly: 50_000,
      homeInsuranceMonthly: 10_000,
      pmiMonthly: 0,
    });
    await addPayment('small', -100_000, '2026-02-01'); // $1,000 < $2,600

    await expect(
      splitMortgagePayment({ transactionId: 'small', mortgageAccountId: 'mtg' }),
    ).rejects.toThrow(/smaller than interest/i);
  });

  it('requires the interest rate as a fraction', async () => {
    await expect(
      saveMortgageConfig({ accountId: 'mtg', annualInterestRate: 6.5 }),
    ).rejects.toThrow(/fraction/i);
  });
});
