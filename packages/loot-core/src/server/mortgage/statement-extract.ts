// Read a mortgage statement's "Explanation Of Amount Due" with the local LLM
// (Ollama), mirroring the email-receipts extractor. We ask ONLY for the
// interest and tax-and-insurance (escrow) portions plus dates and the balance —
// never the principal or the payment total, because those are the fields the
// model misreads on these boxed statements. Principal is derived from the
// matched transaction (payment − interest − escrow), so a scrambled principal
// can't corrupt a split. Verified 9/9 exact against real Interra statements.

const LLM_TIMEOUT_MS = 90_000;
const LLM_INPUT_CAP = 8_000;

const STATEMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    interest: { type: 'number' },
    taxAndInsurance: { type: 'number' },
    statementDate: { type: 'string' },
    dueDate: { type: 'string' },
    principalBalance: { type: 'number' },
  },
  required: [
    'interest',
    'taxAndInsurance',
    'statementDate',
    'dueDate',
    'principalBalance',
  ],
};

const PROMPT =
  'From the mortgage statement below, read the "Explanation Of Amount Due" ' +
  'section (the CURRENT amount due) and extract:\n' +
  '- interest: the Interest portion of the amount due\n' +
  '- taxAndInsurance: the Tax and Insurance (escrow) portion of the amount due\n' +
  '- statementDate, dueDate (the payment due date, NOT the late-charge date)\n' +
  '- principalBalance: the current Principal Balance\n' +
  'Ignore "Paid Last Month", "Paid Year to Date", and "Past Payment Breakdown". ' +
  'Amounts are plain dollar numbers.\n\nSTATEMENT:\n';

export type StatementExtraction = {
  interest: number; // cents
  taxAndInsurance: number; // cents
  principalBalance: number | null; // cents
  statementDate: string | null; // yyyy-mm-dd
  dueDate: string | null; // yyyy-mm-dd
};

// Everything from the disclosures boilerplate on is noise; drop it and cap the
// input so a long statement can't blow the context.
function trimStatement(text: string): string {
  const idx = text.indexOf('Loan Statement Disclosures');
  return (idx > 0 ? text.slice(0, idx) : text).slice(0, LLM_INPUT_CAP);
}

function dollarsToCents(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value * 100);
}

// Statements label dates a few different ways ("July 16, 2026", "07/16/26",
// "2026-07-16"); normalize whatever the model returns to yyyy-mm-dd.
export function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const iso = value.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    return `${iso[1]}-${iso[2]}-${iso[3]}`;
  }
  const mdy = value.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (mdy) {
    const [, mo, da, yrRaw] = mdy;
    const yr = yrRaw.length === 2 ? `20${yrRaw}` : yrRaw;
    return `${yr}-${mo.padStart(2, '0')}-${da.padStart(2, '0')}`;
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    const y = parsed.getFullYear();
    const m = String(parsed.getMonth() + 1).padStart(2, '0');
    const d = String(parsed.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return null;
}

// Validation half, split out so tests can hit it without a running model.
export function validateStatement(rawOutput: string): StatementExtraction | null {
  let parsed: {
    interest?: unknown;
    taxAndInsurance?: unknown;
    principalBalance?: unknown;
    statementDate?: unknown;
    dueDate?: unknown;
  };
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return null;
  }
  const interest = dollarsToCents(parsed.interest);
  const taxAndInsurance = dollarsToCents(parsed.taxAndInsurance);
  if (interest == null || interest <= 0) {
    return null;
  }
  if (taxAndInsurance == null || taxAndInsurance < 0) {
    return null;
  }
  return {
    interest,
    taxAndInsurance,
    principalBalance: dollarsToCents(parsed.principalBalance),
    statementDate: normalizeDate(parsed.statementDate),
    dueDate: normalizeDate(parsed.dueDate),
  };
}

export async function extractStatement(
  statementText: string,
  { endpoint, model }: { endpoint: string; model: string },
): Promise<StatementExtraction | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: STATEMENT_JSON_SCHEMA,
        options: { temperature: 0 },
        messages: [
          { role: 'user', content: PROMPT + trimStatement(statementText) },
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      `Local AI at ${endpoint} is unavailable. Is Ollama running? (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    throw new Error(
      `Local AI returned HTTP ${res.status} — is the model "${model}" pulled?`,
    );
  }

  const data = (await res.json()) as { message?: { content?: string } };
  return validateStatement(data?.message?.content ?? '');
}
