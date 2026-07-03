import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as asyncStorage from '#platform/server/asyncStorage';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';
import type { TransactionEntity } from '#types/models';

import {
  addAttachmentBuffer,
  addAttachmentData,
  app,
  hasAttachmentForSource,
} from './app';

// The electron secure-store talks to the Electron main process over a
// parentPort bridge that does not exist under vitest; store secrets in
// memory instead.
vi.mock('#platform/server/secure-store', () => {
  const secrets = new Map<string, string>();
  return {
    getSecret: async (name: string) => secrets.get(name) ?? null,
    setSecret: async (name: string, value: string) => {
      secrets.set(name, value);
    },
  };
});

// Declared untyped in mocks/setup.ts; this file is strict.
const emptyDatabase = (
  global as unknown as {
    emptyDatabase: (avoidUpdate?: boolean) => () => Promise<void>;
  }
).emptyDatabase;

// An in-memory stand-in for the sync-server blob store.
const serverBlobs = new Map<string, Buffer>();

function makeResponse(status: number, body: string | Buffer) {
  return {
    ok: status === 200,
    status,
    text: async () => body.toString(),
    arrayBuffer: async () => {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
  };
}

let dataDir: string;

beforeEach(async () => {
  await emptyDatabase()();
  await loadMappings();
  await loadRules();
  await db.insertAccount({ id: 'one', name: 'Checking' });
  await db.insertPayee({ id: 'transfer-one', name: '', transfer_acct: 'one' });

  dataDir = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'attachments-test-'));
  process.env.ACTUAL_DATA_DIR = dataDir;

  vi.mocked(asyncStorage.getItem).mockResolvedValue('test-token' as never);

  serverBlobs.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/attachments/upload')) {
        const headers = (opts?.headers ?? {}) as Record<string, string>;
        const id = headers['X-ACTUAL-ATTACHMENT-ID'];
        serverBlobs.set(id, Buffer.from(opts?.body as Buffer));
        return makeResponse(200, JSON.stringify({ status: 'ok', id }));
      }
      if (u.includes('/attachments/download/')) {
        const id = u.split('/').pop() ?? '';
        const blob = serverBlobs.get(id);
        if (!blob) {
          return makeResponse(400, 'attachment not found');
        }
        return makeResponse(200, blob);
      }
      if (opts?.method === 'DELETE' && u.includes('/attachments/')) {
        const id = u.split('/').pop() ?? '';
        serverBlobs.delete(id);
        return makeResponse(200, JSON.stringify({ status: 'ok' }));
      }
      throw new Error('Unexpected fetch in test: ' + u);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  nativeFs.rmSync(dataDir, { recursive: true, force: true });
});

let txnCounter = 0;
async function insertTxn(date: string, amount: number): Promise<string> {
  const id = `txn-${txnCounter++}`;
  const txn: TransactionEntity = { id, account: 'one', date, amount };
  await batchUpdateTransactions({ added: [txn] });
  return id;
}

describe('attachments', () => {
  it('adds an attachment, syncs metadata, and encrypts the blob', async () => {
    const txnId = await insertTxn('2026-07-01', -1234);
    const data = Buffer.from('%PDF-1.4 pretend receipt bytes');

    const entity = await addAttachmentBuffer({
      transactionId: txnId,
      data,
      fileName: 'receipt.pdf',
      source: 'file',
    });

    expect(entity.transaction_id).toBe(txnId);
    expect(entity.file_name).toBe('receipt.pdf');
    expect(entity.content_type).toBe('application/pdf');
    expect(entity.size_bytes).toBe(data.length);

    // The blob that reached the "server" must be encrypted, not the
    // plaintext bytes.
    const uploaded = serverBlobs.get(entity.id);
    expect(uploaded).toBeDefined();
    expect(uploaded?.equals(data)).toBe(false);
    expect(uploaded?.includes('PDF')).toBe(false);

    const listed = await app.handlers['attachments-list']({
      transactionId: txnId,
    });
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(entity.id);
  });

  it('attaches base64 data and dedupes on sourceKey', async () => {
    const txnId = await insertTxn('2026-07-01', -1234);
    const data = Buffer.from('%PDF-1.4 statement bytes');

    const first = await addAttachmentData({
      transactionId: txnId,
      fileName: 'statement.pdf',
      dataBase64: data.toString('base64'),
      contentType: 'application/pdf',
      sourceKey: 'mortgage-stmt:acct:2026-06-17',
    });
    expect(first).not.toBeNull();
    expect(first?.size_bytes).toBe(data.length);
    expect(first?.content_type).toBe('application/pdf');

    // Re-importing the same statement must not attach a duplicate.
    const second = await addAttachmentData({
      transactionId: txnId,
      fileName: 'statement.pdf',
      dataBase64: data.toString('base64'),
      contentType: 'application/pdf',
      sourceKey: 'mortgage-stmt:acct:2026-06-17',
    });
    expect(second).toBeNull();

    const listed = await app.handlers['attachments-list']({
      transactionId: txnId,
    });
    expect(listed).toHaveLength(1);
  });

  it('round-trips bytes through download and decrypt', async () => {
    const txnId = await insertTxn('2026-07-01', -500);
    const data = Buffer.from('binary image bytes \x00\x01\x02\xff', 'binary');

    const entity = await addAttachmentBuffer({
      transactionId: txnId,
      data,
      fileName: 'photo.png',
      source: 'file',
    });

    // Remove the local cache so open is forced through the
    // download-and-decrypt path.
    const cacheDir = path.join(dataDir, 'attachments');
    nativeFs.rmSync(cacheDir, { recursive: true, force: true });

    const { path: openedPath, dataUri } = await app.handlers[
      'attachments-open'
    ]({ id: entity.id });

    const roundTripped = nativeFs.readFileSync(openedPath);
    expect(Buffer.from(roundTripped).equals(data)).toBe(true);
    expect(dataUri).toMatch(/^data:image\/png;base64,/);
  });

  it('deletes an attachment: tombstones metadata and removes the blob', async () => {
    const txnId = await insertTxn('2026-07-01', -500);
    const entity = await addAttachmentBuffer({
      transactionId: txnId,
      data: Buffer.from('bytes'),
      fileName: 'receipt.pdf',
      source: 'file',
    });

    await app.handlers['attachments-delete']({ id: entity.id });

    const listed = await app.handlers['attachments-list']({
      transactionId: txnId,
    });
    expect(listed).toHaveLength(0);
    expect(serverBlobs.has(entity.id)).toBe(false);

    // The metadata row is tombstoned, not hard-deleted (CRDT-safe).
    const raw = await db.first<{ tombstone: number }>(
      'SELECT tombstone FROM transaction_attachments WHERE id = ?',
      [entity.id],
    );
    expect(raw?.tombstone).toBe(1);
  });

  it('reports attachment-bearing transaction ids per account', async () => {
    const txnA = await insertTxn('2026-07-01', -100);
    const txnB = await insertTxn('2026-07-02', -200);
    await insertTxn('2026-07-03', -300); // no attachment

    await addAttachmentBuffer({
      transactionId: txnA,
      data: Buffer.from('a'),
      fileName: 'a.pdf',
      source: 'file',
    });
    await addAttachmentBuffer({
      transactionId: txnB,
      data: Buffer.from('b'),
      fileName: 'b.pdf',
      source: 'file',
    });

    const ids = await app.handlers['attachments-for-account']({
      accountId: 'one',
    });
    expect(ids.sort()).toEqual([txnA, txnB].sort());

    const other = await app.handlers['attachments-for-account']({
      accountId: 'nonexistent',
    });
    expect(other).toEqual([]);
  });

  it('tracks source keys for idempotent email attaching', async () => {
    const txnId = await insertTxn('2026-07-01', -100);

    expect(await hasAttachmentForSource(txnId, 'msg-1')).toBe(false);

    await addAttachmentBuffer({
      transactionId: txnId,
      data: Buffer.from('<html>receipt</html>'),
      fileName: 'receipt-email.html',
      source: 'email',
      sourceKey: 'msg-1',
    });

    expect(await hasAttachmentForSource(txnId, 'msg-1')).toBe(true);
    expect(await hasAttachmentForSource(txnId, 'msg-2')).toBe(false);
  });
});
