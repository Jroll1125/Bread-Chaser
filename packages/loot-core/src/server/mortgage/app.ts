import { v4 as uuidv4 } from 'uuid';

import { aqlQuery } from '#server/aql';
import { createApp } from '#server/app';
import * as db from '#server/db';
import { mutator } from '#server/mutators';
import { batchUpdateTransactions } from '#server/transactions';
import { undoable } from '#server/undo';
import { q } from '#shared/query';
import { makeChild, recalculateSplit } from '#shared/transactions';
import type { TransactionEntity } from '#types/models';

/**
 * Mortgage tracking. A mortgage-type account can have loan terms attached
 * (rate + monthly escrow: property tax, home insurance, PMI). A monthly
 * payment on the funding (checking) account can then be split into
 * Interest / Property Tax / Home Insurance / PMI categories plus a Principal
 * transfer into the mortgage account, which is what actually pays it down.
 * The escrow/interest category running totals become "paid so far".
 *
 * The loan balance itself stays owned by the servicer (via Plaid); use the
 * account's built-in Reconcile to snap it to the real number.
 */

type MortgageConfigRow = {
  id: string;
  account_id: string;
  annual_interest_rate: number;
  property_tax_monthly: number;
  home_insurance_monthly: number;
  pmi_monthly: number;
  interest_category: string | null;
  property_tax_category: string | null;
  home_insurance_category: string | null;
  pmi_category: string | null;
  tombstone: number;
};

export type MortgageConfig = {
  accountId: string;
  annualInterestRate: number;
  propertyTaxMonthly: number;
  homeInsuranceMonthly: number;
  pmiMonthly: number;
};

export type MortgageSplitResult = {
  principal: number;
  interest: number;
  propertyTax: number;
  homeInsurance: number;
  pmi: number;
};

export type MortgageHandlers = {
  'mortgage-get-config': typeof getMortgageConfig;
  'mortgage-save-config': typeof saveMortgageConfig;
  'mortgage-split-payment': typeof splitMortgagePayment;
};

export const app = createApp<MortgageHandlers>();
app.method('mortgage-get-config', getMortgageConfig);
app.method('mortgage-save-config', mutator(saveMortgageConfig));
app.method('mortgage-split-payment', mutator(undoable(splitMortgagePayment)));

async function getConfigRow(
  accountId: string,
): Promise<MortgageConfigRow | null> {
  return db.first<MortgageConfigRow>(
    'SELECT * FROM mortgage_configs WHERE account_id = ? AND tombstone = 0',
    [accountId],
  );
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
    propertyTaxMonthly: row.property_tax_monthly,
    homeInsuranceMonthly: row.home_insurance_monthly,
    pmiMonthly: row.pmi_monthly,
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
  propertyTaxMonthly,
  homeInsuranceMonthly,
  pmiMonthly,
}: MortgageConfig): Promise<'ok'> {
  if (!(annualInterestRate >= 0 && annualInterestRate < 1)) {
    throw new Error('Enter the interest rate as a fraction, e.g. 0.065 for 6.5%.');
  }
  const existing = await getConfigRow(accountId);
  const cats = await ensureCategories(existing);

  const fields = {
    annual_interest_rate: annualInterestRate,
    property_tax_monthly: Math.round(propertyTaxMonthly),
    home_insurance_monthly: Math.round(homeInsuranceMonthly),
    pmi_monthly: Math.round(pmiMonthly),
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

async function currentPrincipal(accountId: string): Promise<number> {
  const row = await db.first<{ balance: number | null }>(
    `SELECT sum(amount) AS balance FROM transactions
      WHERE acct = ? AND isParent = 0 AND tombstone = 0`,
    [accountId],
  );
  return Math.abs(row?.balance ?? 0);
}

export async function splitMortgagePayment({
  transactionId,
  mortgageAccountId,
}: {
  transactionId: string;
  mortgageAccountId: string;
}): Promise<MortgageSplitResult> {
  const config = await getConfigRow(mortgageAccountId);
  if (!config) {
    throw new Error('Set up the mortgage terms for this account first.');
  }

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

  const paymentAbs = Math.abs(txn.amount);
  const principalOutstanding = await currentPrincipal(mortgageAccountId);
  const interest = Math.round(
    (principalOutstanding * config.annual_interest_rate) / 12,
  );
  const propertyTax = config.property_tax_monthly ?? 0;
  const homeInsurance = config.home_insurance_monthly ?? 0;
  const pmi = config.pmi_monthly ?? 0;
  const principal = paymentAbs - interest - propertyTax - homeInsurance - pmi;
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
    throw new Error('Could not find the transfer payee for the mortgage account.');
  }

  // Payments are negative (money leaving the funding account); keep every
  // child the same sign so they sum to the parent.
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
  }> = [
    { amount: sign * interest, category: config.interest_category, notes: 'Interest' },
  ];
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
