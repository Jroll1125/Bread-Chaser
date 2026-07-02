import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';
import type { ReceiptExtraction, TransactionEntity } from '#types/models';

import { closeEmailDb, openEmailDbForTesting } from './db';
import {
  applyProposal,
  cleanMerchant,
  findCandidates,
  merchantSimilarity,
  recordProposal,
  rejectProposal,
  unapplyProposal,
} from './match';

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
  await openEmailDbForTesting();
  await db.insertAccount({ id: 'one', name: 'Checking' });
  await db.insertPayee({ id: 'transfer-one', name: '', transfer_acct: 'one' });
});

afterEach(() => {
  closeEmailDb();
});

let txnCounter = 0;
async function insertTxn(
  date: string,
  amount: number,
  payeeName?: string,
): Promise<string> {
  const id = `txn-${txnCounter++}`;
  let payee: string | undefined;
  if (payeeName) {
    payee = await db.insertPayee({ name: payeeName });
  }
  const txn: TransactionEntity = {
    id,
    account: 'one',
    date,
    amount,
    ...(payee ? { payee } : {}),
  };
  await batchUpdateTransactions({ added: [txn] });
  return id;
}

function makeReceipt(
  overrides: Partial<ReceiptExtraction> = {},
): ReceiptExtraction {
  return {
    is_receipt: true,
    direction: 'purchase',
    merchant: 'DoorDash',
    amount_cents: 3185,
    currency: 'USD',
    date: '2025-06-10',
    order_id: null,
    line_items: [],
    category_hint: null,
    ...overrides,
  };
}

function getAllTransactions() {
  return db.all<
    db.DbViewTransactionInternal & { payee_name: db.DbPayee['name'] | null }
  >(
    `SELECT t.*, p.name as payee_name
       FROM v_transactions_internal t
       LEFT JOIN payees p ON p.id = t.payee
       ORDER BY date DESC, amount DESC, id`,
  );
}

describe('cleanMerchant + similarity', () => {
  test('strips gateway noise and normalizes Amazon', () => {
    expect(cleanMerchant('SQ *BLUE BOTTLE COFFEE #123')).toBe(
      'blue bottle coffee',
    );
    expect(cleanMerchant('AMZN Mktp US*1A2B3C')).toBe('amazon us 1a2b3c');
    expect(
      merchantSimilarity('Amazon.com', 'AMZN Mktp US'),
    ).toBeGreaterThanOrEqual(0.5);
  });

  test('unrelated merchants score low', () => {
    expect(merchantSimilarity('DoorDash', 'Interra Credit Union')).toBe(0);
  });
});

describe('findCandidates', () => {
  test('matches exact signed amount within the -5/+2 day window only', async () => {
    // Receipt dated 2025-06-10 for $31.85. Bank may post up to 5 days after
    // or 2 days before.
    const inWindowLate = await insertTxn('2025-06-15', -3185); // gap +5: ok
    const inWindowEarly = await insertTxn('2025-06-08', -3185); // gap -2: ok
    await insertTxn('2025-06-16', -3185); // gap +6: out
    await insertTxn('2025-06-07', -3185); // gap -3: out
    await insertTxn('2025-06-10', -3186); // wrong amount: out

    const candidates = await findCandidates('msg-1', makeReceipt());
    expect(candidates.map(c => c.id).sort()).toEqual(
      [inWindowLate, inWindowEarly].sort(),
    );
    const late = candidates.find(c => c.id === inWindowLate);
    expect(late?.dateGapDays).toBe(5);
  });

  test('refunds match positive ledger amounts', async () => {
    const refundTxn = await insertTxn('2025-06-11', 3185);
    await insertTxn('2025-06-11', -3185);

    const candidates = await findCandidates(
      'msg-2',
      makeReceipt({ direction: 'refund' }),
    );
    expect(candidates.map(c => c.id)).toEqual([refundTxn]);
  });

  test('rejected pairs are never re-proposed', async () => {
    const txnId = await insertTxn('2025-06-11', -3185);

    const before = await findCandidates('msg-3', makeReceipt());
    expect(before.map(c => c.id)).toEqual([txnId]);

    const proposalId = await recordProposal('msg-3', before[0], 'review');
    await rejectProposal(proposalId);

    const after = await findCandidates('msg-3', makeReceipt());
    expect(after).toEqual([]);

    // ...but only for that message; other receipts can still match it.
    const otherMessage = await findCandidates('msg-4', makeReceipt());
    expect(otherMessage.map(c => c.id)).toEqual([txnId]);
  });

  test('transactions claimed by an applied receipt are excluded', async () => {
    const txnId = await insertTxn('2025-06-11', -3185, 'VENMO');

    const candidates = await findCandidates('msg-5', makeReceipt());
    const proposalId = await recordProposal('msg-5', candidates[0], 'review');
    await applyProposal(proposalId, makeReceipt(), { auto: true });

    const otherMessage = await findCandidates('msg-6', makeReceipt());
    expect(otherMessage).toEqual([]);
    expect(otherMessage.find(c => c.id === txnId)).toBeUndefined();
  });
});

describe('applyProposal', () => {
  test('itemized receipt applies as a split whose children sum to the parent', async () => {
    const txnId = await insertTxn('2025-06-11', -2799, 'Google Play');
    const receipt = makeReceipt({
      merchant: 'Google Play',
      amount_cents: 2799,
      order_id: 'GPA.123',
      line_items: [
        { description: 'App One', amount_cents: 999 },
        { description: 'App Two', amount_cents: 1500 },
      ],
    });

    const candidates = await findCandidates('msg-split', receipt);
    const proposalId = await recordProposal(
      'msg-split',
      candidates[0],
      'review',
    );
    await applyProposal(proposalId, receipt, { auto: true });

    const rows = getAllTransactions().filter(t => t.tombstone === 0);
    const parent = rows.find(t => t.id === txnId);
    const children = rows.filter(t => t.parent_id === txnId);

    expect(parent?.is_parent).toBe(1);
    expect(parent?.category).toBeNull();
    expect(children).toHaveLength(3); // 2 items + tax/fees remainder
    expect(children.reduce((acc, c) => acc + (c.amount ?? 0), 0)).toBe(-2799);
    const remainder = children.find(c => c.notes === 'Tax & fees');
    expect(remainder?.amount).toBe(-300);
    expect(parent?.notes).toContain('GPA.123');
  });

  test('total-only receipt enriches payee and notes without splitting', async () => {
    const txnId = await insertTxn('2025-06-11', -3185, 'VENMO');
    const receipt = makeReceipt({ order_id: 'DD-42' });

    const candidates = await findCandidates('msg-enrich', receipt);
    const proposalId = await recordProposal(
      'msg-enrich',
      candidates[0],
      'review',
    );
    await applyProposal(proposalId, receipt);

    const rows = getAllTransactions();
    const txn = rows.find(t => t.id === txnId);
    expect(txn?.is_parent).toBe(0);
    expect(txn?.amount).toBe(-3185); // enrichment never changes the balance
    expect(txn?.payee_name).toBe('DoorDash');
    expect(txn?.notes).toContain('DD-42');
  });

  test('unapply restores the snapshot and removes children', async () => {
    const txnId = await insertTxn('2025-06-11', -2799, 'Google Play');
    const receipt = makeReceipt({
      merchant: 'Google Play Store',
      amount_cents: 2799,
      line_items: [
        { description: 'App One', amount_cents: 999 },
        { description: 'App Two', amount_cents: 1800 },
      ],
    });

    const candidates = await findCandidates('msg-undo', receipt);
    const proposalId = await recordProposal('msg-undo', candidates[0], 'review');
    await applyProposal(proposalId, receipt, { auto: true });
    await unapplyProposal(proposalId);

    const rows = getAllTransactions().filter(t => t.tombstone === 0);
    const txn = rows.find(t => t.id === txnId);
    expect(txn?.is_parent).toBe(0);
    expect(txn?.payee_name).toBe('Google Play');
    expect(rows.filter(t => t.parent_id === txnId)).toHaveLength(0);

    // Undone, so the transaction is matchable again.
    const again = await findCandidates('msg-undo-2', receipt);
    expect(again.map(c => c.id)).toEqual([txnId]);
  });
});
