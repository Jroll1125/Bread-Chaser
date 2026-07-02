import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';

import { downloadPlaidTransactions, savePlaidCursor } from './plaid';
import type { PlaidDownloadResult } from './plaid';
import { syncAccount } from './sync';

vi.mock('./plaid', () => ({
  downloadPlaidTransactions: vi.fn(),
  savePlaidCursor: vi.fn(),
}));

async function setupPlaidAccount() {
  db.runQuery(
    'INSERT INTO banks (id, bank_id, name, tombstone) VALUES (?, ?, ?, 0)',
    ['bank1', 'plaid-item-1', 'Plaid Sandbox'],
  );
  await db.insertAccount({
    id: 'acct1',
    name: 'Checking',
    bank: 'bank1',
    account_id: 'ext-1',
    account_sync_source: 'plaid',
  });
  await db.insertPayee({ name: '', transfer_acct: 'acct1' });
}

function makeDownload(
  transactions: PlaidDownloadResult['download']['transactions'],
  nextCursor: string,
): PlaidDownloadResult {
  return {
    download: {
      transactions,
      accountBalance: [
        {
          balanceAmount: { amount: '110', currency: 'USD' },
          balanceType: 'expected' as const,
        },
      ],
      startingBalance: 11000,
    },
    nextCursor,
  };
}

const transaction = {
  transactionId: 'plaid:t1',
  booked: true,
  amount: -12.5,
  transactionAmount: { amount: '-12.5', currency: 'USD' },
  date: '2026-06-15',
  payeeName: 'Coffee Shop',
  imported_payee: 'COFFEE SHOP #42',
  notes: 'COFFEE SHOP #42',
};

beforeEach(async () => {
  vi.clearAllMocks();
  await global.emptyDatabase()();
  await loadMappings();
});

describe('plaid syncAccount dispatch', () => {
  it('imports transactions, seeds the starting balance, and saves the cursor after committing', async () => {
    await setupPlaidAccount();
    vi.mocked(downloadPlaidTransactions).mockResolvedValue(
      makeDownload([transaction], 'cursor-next'),
    );

    const result = await syncAccount(
      undefined,
      undefined,
      'acct1',
      'ext-1',
      'plaid-item-1',
    );

    expect(vi.mocked(downloadPlaidTransactions)).toHaveBeenCalledWith(
      'plaid-item-1',
      'ext-1',
      expect.any(String),
    );

    // Starting balance is seeded so the ledger reconciles to Plaid's current
    // balance: initial = current - sum(posted) = 11000 - (-1250) = 12250.
    const rows = db.runQuery<{ amount: number; financial_id: string | null }>(
      'SELECT amount, financial_id FROM transactions WHERE acct = ? AND tombstone = 0 ORDER BY amount',
      ['acct1'],
      true,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ amount: -1250, financial_id: 'plaid:t1' });
    expect(rows[1]).toEqual({ amount: 12250, financial_id: null });
    expect(result.added).toHaveLength(2);

    expect(vi.mocked(savePlaidCursor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(savePlaidCursor)).toHaveBeenCalledWith(
      'plaid-item-1',
      'ext-1',
      'cursor-next',
    );
  });

  it('does not save the cursor when the import fails', async () => {
    await setupPlaidAccount();
    // A transaction with no date makes normalizeBankSyncTransactions throw
    // after the download succeeded - the cursor must not advance past data
    // that was never imported.
    vi.mocked(downloadPlaidTransactions).mockResolvedValue(
      makeDownload(
        [{ ...transaction, date: null as unknown as string }],
        'cursor-next',
      ),
    );

    await expect(
      syncAccount(undefined, undefined, 'acct1', 'ext-1', 'plaid-item-1'),
    ).rejects.toThrow();

    expect(vi.mocked(savePlaidCursor)).not.toHaveBeenCalled();
  });

  it('does not save the cursor when the download itself fails', async () => {
    await setupPlaidAccount();
    vi.mocked(downloadPlaidTransactions).mockRejectedValue(
      new Error('ITEM_LOGIN_REQUIRED'),
    );

    await expect(
      syncAccount(undefined, undefined, 'acct1', 'ext-1', 'plaid-item-1'),
    ).rejects.toThrow('ITEM_LOGIN_REQUIRED');

    expect(vi.mocked(savePlaidCursor)).not.toHaveBeenCalled();
  });
});
