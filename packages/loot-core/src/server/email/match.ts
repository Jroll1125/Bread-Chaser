import * as dateFns from 'date-fns';

import { renderHtmlToPdf } from '#platform/server/html-to-pdf';
import { logger } from '#platform/server/log';
import { aqlQuery } from '#server/aql';
import {
  addAttachmentBuffer,
  hasAttachmentForSource,
} from '#server/attachments/app';
import * as db from '#server/db';
import { batchUpdateTransactions } from '#server/transactions';
import { q } from '#shared/query';
import { makeChild, recalculateSplit } from '#shared/transactions';
import type {
  EmailMatchProposal,
  ReceiptExtraction,
  TransactionEntity,
} from '#types/models';

import { all, first, getEmailDb, run } from './db';

/**
 * Matches extracted receipts against the REAL budget ledger (the
 * transactions the Plaid provider already imported) and applies the
 * unambiguous ones. Matching logic is ported from the companion's
 * dedup/matcher.ts; applying writes through batchUpdateTransactions so every
 * change is CRDT-safe and undoable.
 */

// Receipt emails usually predate the bank posting (order -> settlement lag),
// occasionally trail it. Same asymmetric window as the companion: the bank
// transaction may post up to 5 days after the receipt date, or up to 2 days
// before it.
const WINDOW_BEFORE = 5;
const WINDOW_AFTER = 2;

// Ported from the companion's dedup/matcher.ts.
const NOISE = [
  /\bSQ\s*\*/gi,
  /\bTST\*\s*/gi,
  /\bPAYPAL\s*\*/gi,
  /\bPP\*/gi,
  /\bPOS\s+DEBIT\b/gi,
  /\bDEBIT\s+CARD\b/gi,
  /\bpurchase\b/gi,
  /#\d+/g,
  /\b\d{3,}\b/g,
  /\*+/g,
];

export function cleanMerchant(raw: string): string {
  let s = (raw || '').toLowerCase();
  // "AMZN Mktp" IS the merchant (Amazon), not gateway noise - normalize it so
  // the descriptor and an "Amazon.com" receipt share a token; stripping it
  // would leave only order-code garbage and floor the similarity score.
  s = s.replace(/\bamzn(\s+mktp)?\b/gi, 'amazon');
  for (const re of NOISE) {
    s = s.replace(re, ' ');
  }
  return s
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Token-set overlap in [0, 1]. A ranking signal only - never a gate, because
 * payment routing regularly hides the merchant (DoorDash paid via Venmo shows
 * "VENMO" at the bank). The companion used fuzzball's token_set_ratio; this
 * is a dependency-free stand-in with the same intent.
 */
export function merchantSimilarity(a: string, b: string): number {
  const ta = new Set(cleanMerchant(a).split(' ').filter(Boolean));
  const tb = new Set(cleanMerchant(b).split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }
  let common = 0;
  for (const token of ta) {
    if (tb.has(token)) {
      common++;
    }
  }
  return (2 * common) / (ta.size + tb.size);
}

export type LedgerCandidate = {
  id: string;
  date: string;
  amount: number;
  payee: string | null;
  payee_name: string | null;
  imported_payee: string | null;
  notes: string | null;
  is_parent: boolean;
  reconciled: boolean;
  transfer_id: string | null;
};

/** The signed ledger amount a receipt implies (outflow negative). */
export function receiptSignedAmount(receipt: ReceiptExtraction): number {
  return receipt.direction === 'refund'
    ? Math.abs(receipt.amount_cents)
    : -Math.abs(receipt.amount_cents);
}

/**
 * Hard gate: exact signed amount within the date window, on a plain
 * transaction (no transfers, no existing splits, nothing already claimed by
 * another receipt). Returns candidates ranked by merchant similarity then
 * date proximity.
 */
export async function findCandidates(
  messageId: string,
  receipt: ReceiptExtraction,
): Promise<Array<LedgerCandidate & { merchantScore: number; dateGapDays: number; score: number }>> {
  const amount = receiptSignedAmount(receipt);
  const windowStart = dateFns.format(
    dateFns.subDays(dateFns.parseISO(receipt.date), WINDOW_AFTER),
    'yyyy-MM-dd',
  );
  const windowEnd = dateFns.format(
    dateFns.addDays(dateFns.parseISO(receipt.date), WINDOW_BEFORE),
    'yyyy-MM-dd',
  );

  // Match on the ABSOLUTE amount, not the signed one: the local model
  // regularly flips charge vs. refund (e.g. reads a "NASCAR MOBILE $5.34"
  // charge as a +5.34 refund), which would otherwise miss the real −5.34
  // transaction sitting on the exact same day. The apply path takes its
  // sign from the matched transaction, so a sign-tolerant match still
  // produces correctly-signed splits.
  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        $or: [{ amount }, { amount: -amount }],
        date: { $gte: windowStart, $lte: windowEnd },
      })
      .select([
        'id',
        'date',
        'amount',
        'payee',
        { payee_name: 'payee.name' },
        'imported_payee',
        'notes',
        'is_parent',
        'reconciled',
        'transfer_id',
      ])
      .options({ splits: 'grouped' }),
  );

  const database = await getEmailDb();
  const claimed = new Set(
    all<{ transaction_id: string }>(
      database,
      `SELECT transaction_id FROM match_proposals
        WHERE status IN ('applied', 'auto_applied')`,
    ).map(row => row.transaction_id),
  );
  const rejected = new Set(
    all<{ transaction_id: string }>(
      database,
      'SELECT transaction_id FROM rejected_pairs WHERE message_id = ?',
      [messageId],
    ).map(row => row.transaction_id),
  );

  const candidates = (data as LedgerCandidate[])
    .filter(
      t =>
        !t.is_parent &&
        t.transfer_id == null &&
        !claimed.has(t.id) &&
        !rejected.has(t.id),
    )
    .map(t => {
      const gap = dateFns.differenceInCalendarDays(
        dateFns.parseISO(t.date),
        dateFns.parseISO(receipt.date),
      );
      const merchantScore = Math.max(
        merchantSimilarity(receipt.merchant, t.payee_name ?? ''),
        merchantSimilarity(receipt.merchant, t.imported_payee ?? ''),
      );
      const dateScore = 1 - Math.min(Math.abs(gap), 7) / 7;
      // Same weights as the companion: exact amount already gated, so its
      // 0.15 is a constant credit.
      const score = 0.6 * merchantScore + 0.25 * dateScore + 0.15;
      return { ...t, merchantScore, dateGapDays: gap, score };
    })
    // The aql date range above is only a coarse pre-filter; the asymmetric
    // window is enforced here, like the companion's dateWindowOk.
    .filter(
      t => t.dateGapDays >= -WINDOW_AFTER && t.dateGapDays <= WINDOW_BEFORE,
    )
    .sort((a, b) => b.score - a.score);

  return candidates;
}

type ProposalRow = {
  id: number;
  message_id: string;
  transaction_id: string;
  score: number;
  merchant_score: number;
  date_gap_days: number;
  status: string;
  applied_split: number;
  snapshot_json: string | null;
  created_at: string;
  applied_at: string | null;
};

export async function getProposalsForMessage(
  messageId: string,
): Promise<ProposalRow[]> {
  const database = await getEmailDb();
  return all<ProposalRow>(
    database,
    'SELECT * FROM match_proposals WHERE message_id = ?',
    [messageId],
  );
}

export async function recordProposal(
  messageId: string,
  candidate: { id: string; merchantScore: number; dateGapDays: number; score: number },
  status: 'review' | 'auto_applied',
): Promise<number> {
  const database = await getEmailDb();
  run(
    database,
    `INSERT INTO match_proposals
       (message_id, transaction_id, score, merchant_score, date_gap_days, status)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id, transaction_id) DO NOTHING`,
    [
      messageId,
      candidate.id,
      candidate.score,
      candidate.merchantScore,
      candidate.dateGapDays,
      status,
    ],
  );
  const row = first<{ id: number }>(
    database,
    'SELECT id FROM match_proposals WHERE message_id = ? AND transaction_id = ?',
    [messageId, candidate.id],
  );
  if (!row) {
    throw new Error('Failed to record match proposal');
  }
  return row.id;
}

async function getLedgerTransaction(
  id: string,
): Promise<TransactionEntity | null> {
  const { data } = await aqlQuery(
    q('transactions').filter({ id }).select('*').options({ splits: 'grouped' }),
  );
  return (data as TransactionEntity[])[0] ?? null;
}

async function findOrCreatePayee(name: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  const existing = await db.getPayeeByName(trimmed);
  if (existing) {
    return existing.id;
  }
  return db.insertPayee({ name: trimmed });
}

function appendNote(existing: string | null, note: string): string {
  if (!existing) {
    return note;
  }
  return existing.includes(note) ? existing : `${existing} | ${note}`;
}

function receiptNote(receipt: ReceiptExtraction): string {
  const order = receipt.order_id ? ` #${receipt.order_id}` : '';
  return `Receipt: ${receipt.merchant}${order}`;
}

type ApplySnapshot = {
  payee: string | null;
  notes: string | null;
  category: string | null;
  childIds: string[];
};

// TransactionEntity types category/notes as `string | undefined`, but the db
// layer needs an explicit null to CLEAR a field (undefined means "leave it").
// This is the same shape reconcileTransactions passes.
type TransactionUpdate = Omit<
  Partial<TransactionEntity>,
  'category' | 'notes'
> & {
  category?: string | null;
  notes?: string | null;
};

function asUpdates(updates: TransactionUpdate[]): Partial<TransactionEntity>[] {
  return updates as unknown as Partial<TransactionEntity>[];
}

/**
 * Apply one receipt to one ledger transaction. With 2+ line items the
 * transaction becomes an itemized split (children sum exactly to the parent;
 * any tax/fees remainder gets its own child); otherwise it's enriched in
 * place (payee, notes, order number). The pre-apply state is snapshotted on
 * the proposal so the change can be undone.
 */
export async function applyProposal(
  proposalId: number,
  receipt: ReceiptExtraction,
  { auto = false }: { auto?: boolean } = {},
): Promise<void> {
  const database = await getEmailDb();
  const proposal = first<ProposalRow>(
    database,
    'SELECT * FROM match_proposals WHERE id = ?',
    [proposalId],
  );
  if (!proposal) {
    throw new Error(`No match proposal ${proposalId}`);
  }
  if (proposal.status === 'applied' || proposal.status === 'auto_applied') {
    return;
  }

  const trans = await getLedgerTransaction(proposal.transaction_id);
  if (!trans || trans.is_parent) {
    throw new Error(
      'The matched transaction no longer exists or is already split',
    );
  }

  // Ground truth for direction is the matched transaction, not the model's
  // extracted `direction` (it sometimes flips charge/refund). This keeps
  // split children agreeing with the parent sign even when candidate
  // matching was sign-tolerant.
  const sign = trans.amount < 0 ? -1 : 1;
  const payeeId = await findOrCreatePayee(receipt.merchant);
  const note = receiptNote(receipt);

  const snapshot: ApplySnapshot = {
    payee: trans.payee ?? null,
    notes: trans.notes ?? null,
    category: trans.category ?? null,
    childIds: [],
  };

  // Sign comes from the matched transaction, so each child (sign * |item|)
  // always agrees with the parent sign. The one
  // way an itemized split can go wrong is if the items OVERSHOOT the parent
  // (the model read a discount as a positive line, or hallucinated an item):
  // then the balancing remainder flips sign, producing a nonsensical
  // opposite-direction "Tax & fees" child. That signals an unreliable
  // extraction, so we don't split it - we enrich instead (and the enriched
  // receipt still surfaces in the review log for a human to eyeball).
  const lineItemsTotal = receipt.line_items.reduce(
    (acc, item) => acc + sign * Math.abs(item.amount_cents),
    0,
  );
  const remainder = trans.amount - lineItemsTotal;
  const remainderOk =
    remainder === 0 || Math.sign(remainder) === Math.sign(trans.amount);
  const makeSplit = receipt.line_items.length >= 2 && remainderOk;

  if (makeSplit) {
    const parent: TransactionEntity = {
      ...trans,
      is_parent: true,
      category: undefined,
      ...(payeeId ? { payee: payeeId } : {}),
      notes: appendNote(trans.notes ?? null, note),
    };
    const children = receipt.line_items.map((item, idx) =>
      makeChild(parent, {
        amount: sign * Math.abs(item.amount_cents),
        notes: item.description,
        category: null,
        sort_order: 0 - idx,
      }),
    );
    if (remainder !== 0) {
      children.push(
        makeChild(parent, {
          amount: remainder,
          notes: 'Tax & fees',
          category: null,
          sort_order: 0 - children.length,
        }),
      );
    }
    // recalculateSplit validates the children sum to the parent; with the
    // remainder child that must always hold.
    const { subtransactions: _sub, ...checkedParent } = recalculateSplit({
      ...parent,
      subtransactions: children,
    });
    if (checkedParent.error) {
      throw new Error('Split children do not sum to the parent amount');
    }

    snapshot.childIds = children.map(c => c.id);
    const parentUpdate: TransactionUpdate = {
      id: trans.id,
      is_parent: true,
      category: null,
      ...(payeeId ? { payee: payeeId } : {}),
      notes: checkedParent.notes,
    };
    await batchUpdateTransactions({
      updated: asUpdates([parentUpdate]),
      added: children,
    });
  } else {
    const update: TransactionUpdate = {
      id: trans.id,
      ...(payeeId ? { payee: payeeId } : {}),
      notes: appendNote(trans.notes ?? null, note),
    };
    await batchUpdateTransactions({ updated: asUpdates([update]) });
  }

  run(
    database,
    `UPDATE match_proposals
        SET status = ?, applied_split = ?, snapshot_json = ?,
            applied_at = datetime('now')
      WHERE id = ?`,
    [
      auto ? 'auto_applied' : 'applied',
      makeSplit ? 1 : 0,
      JSON.stringify(snapshot),
      proposalId,
    ],
  );
  logger.log(
    `[email-receipts] ${auto ? 'auto-' : ''}applied receipt ` +
      `"${receipt.merchant}" to transaction ${trans.id}` +
      (makeSplit ? ` as a ${receipt.line_items.length}-item split` : ''),
  );

  await attachReceiptEmail(proposal.message_id, trans.id);
}

type EmailMessageRow = {
  subject: string | null;
  from_addr: string | null;
  email_date: string | null;
  body: string | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderReceiptEmailHtml(
  msg: EmailMessageRow,
  messageId?: string,
): string {
  const body = msg.body ?? '';
  // The pipeline stores whichever of text/html or text/plain it decoded;
  // wrap plain text so it stays readable in a browser.
  const looksLikeHtml = /<\s*(html|body|div|table|p|br|span|td)\b/i.test(body);
  const bodyHtml = looksLikeHtml
    ? body
    : `<pre style="white-space: pre-wrap; font-family: inherit;">${escapeHtml(body)}</pre>`;

  const headerRows = [
    ['Subject', msg.subject],
    ['From', msg.from_addr],
    ['Date', msg.email_date],
  ]
    .filter(([, value]) => value)
    .map(
      ([label, value]) =>
        `<div><strong>${label}:</strong> ${escapeHtml(String(value))}</div>`,
    )
    .join('\n');

  // A way back to the source: Gmail resolves its message ids in this URL
  // form for the signed-in account.
  const gmailLink = messageId
    ? `<div><strong>Email:</strong> <a href="https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}">Open in Gmail</a></div>`
    : '';

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8"></head><body>',
    `<div style="border-bottom: 1px solid #ccc; padding-bottom: 8px; margin-bottom: 12px; font-family: sans-serif; font-size: 13px;">${headerRows}${gmailLink}</div>`,
    bodyHtml,
    '</body></html>',
  ].join('\n');
}

/**
 * Attach the source receipt email (rendered to .html) to the matched
 * transaction. Idempotent (keyed on the Gmail message id) and deliberately
 * non-fatal: the ledger apply has already succeeded, so a sync-server
 * hiccup here must not fail the whole apply.
 */
async function attachReceiptEmail(
  messageId: string,
  transactionId: string,
): Promise<void> {
  try {
    if (await hasAttachmentForSource(transactionId, messageId)) {
      return;
    }
    const database = await getEmailDb();
    const msg = first<EmailMessageRow>(
      database,
      `SELECT subject, from_addr, email_date, body
         FROM email_messages WHERE message_id = ?`,
      [messageId],
    );
    if (!msg) {
      return;
    }
    const datePart = (msg.email_date ?? '').slice(0, 10);
    const html = renderReceiptEmailHtml(msg, messageId);

    // Prefer a PDF of the rendered email (far more readable than raw HTML);
    // fall back to the HTML itself when no renderer is available.
    let data: Buffer = Buffer.from(html, 'utf8');
    let fileName = `receipt-email${datePart ? '-' + datePart : ''}.html`;
    let contentType = 'text/html';
    try {
      const pdf = await renderHtmlToPdf(html);
      if (pdf) {
        data = pdf;
        fileName = `receipt-email${datePart ? '-' + datePart : ''}.pdf`;
        contentType = 'application/pdf';
      }
    } catch (err) {
      logger.warn(
        '[email-receipts] PDF render failed; attaching HTML instead',
        err,
      );
    }

    await addAttachmentBuffer({
      transactionId,
      data,
      fileName,
      contentType,
      source: 'email',
      sourceKey: messageId,
    });
    logger.log(
      `[email-receipts] attached source email to transaction ${transactionId}`,
    );
  } catch (err) {
    logger.warn('[email-receipts] could not attach the source email', err);
  }
}

/**
 * Reject a proposed pairing. Recorded in rejected_pairs so a re-sync can
 * never resurrect it.
 */
export async function rejectProposal(proposalId: number): Promise<void> {
  const database = await getEmailDb();
  const proposal = first<ProposalRow>(
    database,
    'SELECT * FROM match_proposals WHERE id = ?',
    [proposalId],
  );
  if (!proposal) {
    return;
  }
  run(
    database,
    `INSERT INTO rejected_pairs (message_id, transaction_id)
     VALUES (?, ?) ON CONFLICT DO NOTHING`,
    [proposal.message_id, proposal.transaction_id],
  );
  run(database, `UPDATE match_proposals SET status = 'rejected' WHERE id = ?`, [
    proposalId,
  ]);
}

/** Undo an applied proposal: restore the parent, delete created children. */
export async function unapplyProposal(proposalId: number): Promise<void> {
  const database = await getEmailDb();
  const proposal = first<ProposalRow>(
    database,
    'SELECT * FROM match_proposals WHERE id = ?',
    [proposalId],
  );
  if (
    !proposal ||
    (proposal.status !== 'applied' && proposal.status !== 'auto_applied') ||
    !proposal.snapshot_json
  ) {
    throw new Error('This match is not in an applied state');
  }
  const snapshot = JSON.parse(proposal.snapshot_json) as ApplySnapshot;

  const restore: TransactionUpdate = {
    id: proposal.transaction_id,
    is_parent: false,
    payee: snapshot.payee,
    notes: snapshot.notes,
    category: snapshot.category,
  };
  await batchUpdateTransactions({
    updated: asUpdates([restore]),
    deleted: snapshot.childIds.map(id => ({ id })),
  });

  run(
    database,
    `UPDATE match_proposals
        SET status = 'review', applied_at = NULL, applied_split = 0,
            snapshot_json = NULL
      WHERE id = ?`,
    [proposalId],
  );
}

export function toEmailMatchProposal(
  row: ProposalRow,
  trans: { date: string; amount: number; payee_name: string | null } | null,
): EmailMatchProposal {
  return {
    id: row.id,
    messageId: row.message_id,
    transactionId: row.transaction_id,
    score: row.score,
    merchantScore: row.merchant_score,
    dateGapDays: row.date_gap_days,
    status: row.status as EmailMatchProposal['status'],
    appliedSplit: row.applied_split === 1,
    appliedAt: row.applied_at,
    transactionDate: trans?.date ?? '',
    transactionAmount: trans?.amount ?? 0,
    transactionPayee: trans?.payee_name ?? null,
  };
}
