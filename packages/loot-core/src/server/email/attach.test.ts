import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as asyncStorage from '#platform/server/asyncStorage';
import { app as attachmentsApp } from '#server/attachments/app';
import * as db from '#server/db';
import { loadMappings } from '#server/db/mappings';
import { batchUpdateTransactions } from '#server/transactions';
import { loadRules } from '#server/transactions/transaction-rules';
import type { ReceiptExtraction, TransactionEntity } from '#types/models';

import { closeEmailDb, getEmailDb, openEmailDbForTesting, run } from './db';
import {
  applyProposal,
  recordProposal,
  renderReceiptEmailHtml,
  unapplyProposal,
} from './match';

// The electron secure-store talks to the Electron main process over a
// parentPort bridge that does not exist under vitest.
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

const serverBlobs = new Map<string, Buffer>();
let dataDir: string;

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

beforeEach(async () => {
  await emptyDatabase()();
  await loadMappings();
  await loadRules();
  await openEmailDbForTesting();
  await db.insertAccount({ id: 'one', name: 'Checking' });
  await db.insertPayee({ id: 'transfer-one', name: '', transfer_acct: 'one' });

  dataDir = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'email-attach-test-'));
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
      throw new Error('Unexpected fetch in test: ' + u);
    }),
  );
});

afterEach(() => {
  closeEmailDb();
  vi.unstubAllGlobals();
  nativeFs.rmSync(dataDir, { recursive: true, force: true });
});

async function insertTxn(date: string, amount: number): Promise<string> {
  const id = 'txn-attach-test';
  const txn: TransactionEntity = { id, account: 'one', date, amount };
  await batchUpdateTransactions({ added: [txn] });
  return id;
}

async function insertEmailMessage(messageId: string): Promise<void> {
  const database = await getEmailDb();
  run(
    database,
    `INSERT INTO email_messages
       (message_id, thread_id, from_addr, subject, email_date, classified, body)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      messageId,
      'thread-1',
      'orders@doordash.com',
      'Your DoorDash receipt',
      '2026-06-10T12:00:00Z',
      'receipt',
      'Thanks for your order!\nTotal: $31.85',
    ],
  );
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
    date: '2026-06-10',
    order_id: null,
    line_items: [],
    category_hint: null,
    ...overrides,
  };
}

async function attachmentsFor(txnId: string) {
  return attachmentsApp.handlers['attachments-list']({ transactionId: txnId });
}

describe('email receipt auto-attach', () => {
  it('attaches the rendered source email when a match is applied', async () => {
    const txnId = await insertTxn('2026-06-11', -3185);
    await insertEmailMessage('msg-1');
    const proposalId = await recordProposal(
      'msg-1',
      { id: txnId, merchantScore: 1, dateGapDays: 1, score: 1 },
      'review',
    );

    await applyProposal(proposalId, makeReceipt());

    const attachments = await attachmentsFor(txnId);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].source).toBe('email');
    expect(attachments[0].source_key).toBe('msg-1');
    expect(attachments[0].content_type).toBe('text/html');
    expect(attachments[0].file_name).toBe('receipt-email-2026-06-10.html');
    expect(serverBlobs.size).toBe(1);
  });

  it('is idempotent across unapply and re-apply', async () => {
    const txnId = await insertTxn('2026-06-11', -3185);
    await insertEmailMessage('msg-2');
    const proposalId = await recordProposal(
      'msg-2',
      { id: txnId, merchantScore: 1, dateGapDays: 1, score: 1 },
      'review',
    );

    await applyProposal(proposalId, makeReceipt());
    await unapplyProposal(proposalId);
    await applyProposal(proposalId, makeReceipt());

    const attachments = await attachmentsFor(txnId);
    expect(attachments).toHaveLength(1);
    expect(serverBlobs.size).toBe(1);
  });

  it('does not fail the apply when the attachment upload fails', async () => {
    const txnId = await insertTxn('2026-06-11', -3185);
    await insertEmailMessage('msg-3');
    const proposalId = await recordProposal(
      'msg-3',
      { id: txnId, merchantScore: 1, dateGapDays: 1, score: 1 },
      'review',
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => makeResponse(500, 'server exploded')),
    );

    await expect(applyProposal(proposalId, makeReceipt())).resolves.not.toThrow();
    expect(await attachmentsFor(txnId)).toHaveLength(0);
  });

  it('renders plain-text bodies as readable HTML when no body_html', () => {
    const html = renderReceiptEmailHtml({
      subject: 'Receipt <test>',
      from_addr: 'a@b.com',
      email_date: '2026-06-10',
      body: 'Line 1\nTotal: $5 & tax',
      body_html: null,
    });
    expect(html).toContain('Receipt &lt;test&gt;');
    expect(html).toContain('<pre');
    expect(html).toContain('Total: $5 &amp; tax');
  });

  it('embeds the real email HTML as-is, ignoring the plain body', () => {
    const html = renderReceiptEmailHtml({
      subject: 'Receipt',
      from_addr: 'a@b.com',
      email_date: '2026-06-10',
      body: 'Total: $5',
      body_html: '<div><p>Total: $5</p><img src="https://x/logo.png"></div>',
    });
    // The real message markup renders verbatim (so the PDF looks like the
    // email); the de-tagged plain text is not <pre>-wrapped in this case.
    expect(html).toContain('<div><p>Total: $5</p><img src="https://x/logo.png"></div>');
    expect(html).not.toContain('<pre');
  });
});
