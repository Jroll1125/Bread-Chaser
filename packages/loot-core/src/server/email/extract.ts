import { z } from 'zod';

import { fetch } from '#platform/server/fetch';
import { logger } from '#platform/server/log';
import type { ReceiptExtraction } from '#types/models';

/**
 * Receipt extraction runs entirely on the local machine: email bodies go to a
 * local LLM endpoint (Ollama by default) and nowhere else. The model is a
 * schema-constrained extractor - its output is validated JSON only, it takes
 * no actions, and email content is data, never instructions. Anything that
 * fails validation is quarantined rather than guessed at.
 *
 * Ported from the companion service's llm/haiku.ts, swapping the paid API for
 * a local endpoint.
 */

// Zod schema ported field-for-field from the companion's ReceiptSchema.
// (The repo's tsconfig isn't globally strict, which degrades z.infer to
// all-optional - so validated data is normalized into ReceiptExtraction
// explicitly below instead of relying on inference.)
export const ReceiptSchema = z.object({
  is_receipt: z.boolean(),
  direction: z.enum(['purchase', 'refund']).default('purchase'),
  merchant: z.string().default(''),
  amount_cents: z.number().int().default(0),
  currency: z.string().default('USD'),
  date: z.string().default(''),
  order_id: z.string().nullable().default(null),
  line_items: z
    .array(z.object({ description: z.string(), amount_cents: z.number().int() }))
    .default([]),
  category_hint: z.string().nullable().default(null),
});

function normalizeReceipt(
  data: z.infer<typeof ReceiptSchema>,
): ReceiptExtraction {
  return {
    is_receipt: data.is_receipt ?? false,
    direction: data.direction === 'refund' ? 'refund' : 'purchase',
    merchant: data.merchant ?? '',
    amount_cents: data.amount_cents ?? 0,
    currency: data.currency ?? 'USD',
    date: data.date ?? '',
    order_id: data.order_id ?? null,
    line_items: (data.line_items ?? []).map(item => ({
      description: item.description ?? '',
      amount_cents: item.amount_cents ?? 0,
    })),
    category_hint: data.category_hint ?? null,
  };
}

// JSON schema handed to Ollama's `format` parameter so the model can only
// emit this shape (Ollama constrains decoding to the schema).
const RECEIPT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    is_receipt: { type: 'boolean' },
    direction: { type: 'string', enum: ['purchase', 'refund'] },
    merchant: { type: 'string' },
    amount_cents: { type: 'integer' },
    currency: { type: 'string' },
    date: { type: 'string' },
    order_id: { type: ['string', 'null'] },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount_cents: { type: 'integer' },
        },
        required: ['description', 'amount_cents'],
      },
    },
    category_hint: { type: ['string', 'null'] },
  },
  required: ['is_receipt'],
};

const PROMPT =
  'Extract the receipt/order from the email below into JSON. Amounts are ' +
  'INTEGER CENTS. If the email is NOT a receipt, order, charge, or refund ' +
  'confirmation (e.g. marketing, newsletter, shipping-only update, ' +
  'brokerage trade confirmation), set is_receipt=false and leave the other ' +
  'fields empty - do NOT invent values. Use direction="refund" when money ' +
  'is returning to the user. date is YYYY-MM-DD. Include line_items only ' +
  'when the email itemizes individual charges. Email body:\n\n';

const LLM_INPUT_CAP = 12_000;
const LLM_TIMEOUT_MS = 120_000;
const LLM_PING_TIMEOUT_MS = 2_500;

export type EmailClass = 'receipt' | 'excluded' | 'other';

// Non-spending mail that would otherwise look like an order: brokerage
// "order executed" confirmations, promos, and ship/deliver notices. Checked
// BEFORE the receipt patterns because e.g. Robinhood's subjects contain the
// word "order".
const EXCLUDE_SENDERS =
  /robinhood|edward\s*jones|fidelity|vanguard|schwab|e\*?trade/i;
const EXCLUDE_SUBJECTS =
  /order executed|trade confirmation|has shipped|was shipped|shipped:|out for delivery|was delivered|has been delivered|delivery update|on its way|tracking number|arriving|% off|flash sale|last chance|black friday|cyber monday|deal(s)? (end|of)|clearance/i;

const RECEIPT_SENDERS =
  /doordash|venmo|google play|googleplay|1a\s*auto|1aauto|iracing|carfax|enterprise|amazon|paypal|apple|uber|lyft|grubhub|walmart|target|ebay|etsy|steam/i;
const RECEIPT_SUBJECTS =
  /receipt|your order|order confirmation|order number|payment confirmation|you paid|payment to|thanks for your (order|purchase)|purchase confirmation|invoice|refund/i;

/**
 * Cheap sender/subject pre-filter so obvious non-receipts never reach the
 * model. `allow`/`deny` come from email-receipts.json and win over the
 * built-in lists (deny beats allow).
 */
export function classify(
  from: string,
  subject: string,
  { allow = [], deny = [] }: { allow?: string[]; deny?: string[] } = {},
): EmailClass {
  const f = (from || '').toLowerCase();
  const s = (subject || '').toLowerCase();

  if (deny.some(entry => entry && f.includes(entry.toLowerCase()))) {
    return 'excluded';
  }
  if (EXCLUDE_SENDERS.test(f) || EXCLUDE_SUBJECTS.test(s)) {
    return 'excluded';
  }
  if (allow.some(entry => entry && f.includes(entry.toLowerCase()))) {
    return 'receipt';
  }
  if (RECEIPT_SENDERS.test(f) || RECEIPT_SUBJECTS.test(s)) {
    return 'receipt';
  }
  return 'other';
}

/** Thrown when the local endpoint is unreachable: skip and retry next sync. */
export class LlmUnavailableError extends Error {
  constructor(endpoint: string, cause?: unknown) {
    super(
      `Local model endpoint ${endpoint} is unreachable` +
        (cause instanceof Error ? `: ${cause.message}` : ''),
    );
    this.name = 'LlmUnavailableError';
  }
}

export async function pingLlm(endpoint: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_PING_TIMEOUT_MS);
    try {
      const res = await fetch(`${endpoint}/api/tags`, {
        signal: controller.signal,
      });
      return res.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

export type ExtractionResult =
  | { status: 'ok'; receipt: ReceiptExtraction }
  | { status: 'not_receipt'; receipt: null }
  | { status: 'quarantined'; receipt: null };

/**
 * Ask the local model for a structured extraction and validate it. The
 * quarantine gates are the companion's: schema-invalid output, or
 * is_receipt=true with merchant/amount/date missing, produce no receipt (the
 * raw email stays stored, so a better model can re-extract later).
 */
export async function extractReceipt(
  emailPlainText: string,
  { endpoint, model }: { endpoint: string; model: string },
): Promise<ExtractionResult> {
  let res;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      res = await fetch(`${endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          format: RECEIPT_JSON_SCHEMA,
          options: { temperature: 0 },
          messages: [
            {
              role: 'user',
              content: PROMPT + emailPlainText.slice(0, LLM_INPUT_CAP),
            },
          ],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    throw new LlmUnavailableError(endpoint, err);
  }

  if (!res.ok) {
    // A running endpoint that errors (e.g. model not pulled) reads as
    // unavailable too: nothing to quarantine, retry after the user fixes it.
    throw new LlmUnavailableError(endpoint, new Error(`HTTP ${res.status}`));
  }

  const data = (await res.json()) as { message?: { content?: string } };
  return validateExtraction(data?.message?.content ?? '');
}

/** Validation half of extractReceipt, separated so tests can hit it directly. */
export function validateExtraction(rawOutput: string): ExtractionResult {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawOutput);
  } catch {
    logger.warn('[email-receipts] model output was not JSON, quarantining');
    return { status: 'quarantined', receipt: null };
  }

  const parsed = ReceiptSchema.safeParse(parsedJson);
  if (!parsed.success) {
    logger.warn(
      '[email-receipts] extraction failed validation, quarantining',
      parsed.error.issues,
    );
    return { status: 'quarantined', receipt: null };
  }
  if (!parsed.data.is_receipt) {
    return { status: 'not_receipt', receipt: null };
  }
  if (
    !parsed.data.merchant ||
    !parsed.data.amount_cents ||
    !parsed.data.date ||
    !/^\d{4}-\d{2}-\d{2}$/.test(parsed.data.date)
  ) {
    logger.warn(
      '[email-receipts] is_receipt=true but core fields missing, quarantining',
    );
    return { status: 'quarantined', receipt: null };
  }
  return { status: 'ok', receipt: normalizeReceipt(parsed.data) };
}

/**
 * Re-read a receipt that was stored as JSON (extractions.output_json).
 * Returns null when the stored payload doesn't validate.
 */
export function parseReceiptJson(json: string): ReceiptExtraction | null {
  try {
    const parsed = ReceiptSchema.safeParse(JSON.parse(json));
    if (!parsed.success || !parsed.data.is_receipt) {
      return null;
    }
    return normalizeReceipt(parsed.data);
  } catch {
    return null;
  }
}
