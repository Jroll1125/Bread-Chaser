import { v4 as uuidv4 } from 'uuid';

import { fetch } from '#platform/server/fetch';
import * as lootFs from '#platform/server/fs';
import { renderHtmlToPdf } from '#platform/server/html-to-pdf';
import { logger } from '#platform/server/log';
import * as oauthLoopback from '#platform/server/oauth-loopback';
import * as secureStore from '#platform/server/secure-store';
import {
  addAttachmentBuffer,
  deleteAttachmentsForSource,
} from '#server/attachments/app';
import { aqlQuery } from '#server/aql';
import { q } from '#shared/query';
import type {
  EmailMatchProposal,
  EmailReceiptsConnectPoll,
  EmailReceiptsConnectStart,
  EmailReceiptsStatus,
  EmailReceiptsSyncResult,
  EmailReviewItem,
  ReceiptExtraction,
} from '#types/models';

import { all, first, getEmailDb, getMeta, run, setMeta } from './db';
import {
  classify,
  extractReceipt,
  LlmUnavailableError,
  parseReceiptJson,
  pingLlm,
} from './extract';
import {
  applyProposal,
  type EmailMessageRow,
  findCandidates,
  recordProposal,
  rejectProposal,
  renderReceiptEmailHtml,
  toEmailMatchProposal,
  unapplyProposal,
} from './match';

/**
 * The Email Receipts provider: connect Ben's Gmail read-only, pull receipt
 * emails via the Gmail REST API (plain fetch, no googleapis), extract them
 * with a local LLM, and match them against the real ledger. Mirrors the
 * Plaid slice's shape: config file in the data dir, secrets in the
 * OS-encrypted secure store, handlers registered on the accounts app.
 */

const CONFIG_FILE = 'email-receipts.json';
const CLIENT_SECRET_KEY = 'gmail-oauth-client-secret';
const REFRESH_TOKEN_KEY = 'gmail-oauth-refresh-token';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const DEFAULT_LLM_ENDPOINT = 'http://localhost:11434';
const DEFAULT_LLM_MODEL = 'qwen2.5:7b';
const DEFAULT_HISTORY_DAYS = 720;
const DEFAULT_MAX_MESSAGES = 2000;
// When incrementalSync is on, each sync queries from the last scan's start
// time minus this margin (rather than the full historyDays window). The
// overlap re-lists a few already-seen messages (harmless — they dedupe on
// Gmail id) so nothing that arrived around the previous sync is missed.
const INCREMENTAL_OVERLAP_DAYS = 3;
// Bounds for the UI-configurable lookback so the Gmail `newer_than:Nd` query
// stays sane: at least a day, at most ~10 years.
const MIN_HISTORY_DAYS = 1;
const MAX_HISTORY_DAYS = 3650;

type EmailReceiptsConfigFile = {
  clientId?: string;
  // Only present transiently: migrated into the secure store (and stripped
  // from the file) on first read, same as plaid.json's secret.
  clientSecret?: string;
  gmailQuery?: string;
  senderAllow?: string[];
  senderDeny?: string[];
  llmEndpoint?: string;
  llmModel?: string;
  historyDays?: number;
  maxMessagesPerSync?: number;
  // Off by default: Ben wants to see everything land in review before it
  // touches the ledger while he builds trust in the matcher. Toggled from
  // the Email Receipts card; when on, the narrow slam-dunk gate in
  // syncEmailReceipts still applies on top of this.
  autoApply?: boolean;
  // When true, a sync only pulls mail since the previous successful scan
  // (Gmail `after:` from the stored watermark) instead of re-listing the whole
  // historyDays window every time. Leave off for the initial backfill, then
  // turn on so routine syncs stay fast. Ignored if a custom gmailQuery is set.
  incrementalSync?: boolean;
};

type EmailReceiptsConfig = {
  clientId: string;
  clientSecret: string;
  gmailQuery: string | null;
  senderAllow: string[];
  senderDeny: string[];
  llmEndpoint: string;
  llmModel: string;
  historyDays: number;
  maxMessagesPerSync: number;
  autoApply: boolean;
  incrementalSync: boolean;
};

function getConfigPath(): string {
  const dataDir = lootFs.getDataDir();
  if (!dataDir) {
    throw new Error('Email receipts require the data directory to be set');
  }
  return lootFs.join(dataDir, CONFIG_FILE);
}

async function readConfigFile(): Promise<EmailReceiptsConfigFile | null> {
  const configPath = getConfigPath();
  if (!(await lootFs.exists(configPath))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await lootFs.readFile(configPath));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('email-receipts config is not a JSON object');
    }
    return parsed;
  } catch (err) {
    logger.error(`Could not parse email-receipts config at ${configPath}`, err);
    return null;
  }
}

async function getClientSecret(
  fileConfig: EmailReceiptsConfigFile | null,
): Promise<string | null> {
  if (!(await secureStore.isAvailable())) {
    return null;
  }
  // One-time migration: a clientSecret dropped into email-receipts.json moves
  // into the OS-encrypted store and is stripped from the plain file.
  if (fileConfig?.clientSecret) {
    await secureStore.setSecret(CLIENT_SECRET_KEY, fileConfig.clientSecret);
    const { clientSecret: _secret, ...rest } = fileConfig;
    await lootFs.writeFile(getConfigPath(), JSON.stringify(rest, null, 2));
    delete fileConfig.clientSecret;
  }
  return secureStore.getSecret(CLIENT_SECRET_KEY);
}

/**
 * In-app setup: store the Google OAuth client credentials without the user
 * hand-editing email-receipts.json. clientId lands in the plain config file
 * (alongside any llmEndpoint/model overrides already there); clientSecret
 * goes straight into the OS-encrypted secure store and never touches disk in
 * the clear.
 */
export async function configureEmailReceipts({
  clientId,
  clientSecret,
}: {
  clientId: string;
  clientSecret: string;
}): Promise<void> {
  if (!(await secureStore.isAvailable())) {
    throw new Error(
      'Secure storage is unavailable; email receipts need the desktop app.',
    );
  }
  const trimmedId = clientId.trim();
  const trimmedSecret = clientSecret.trim();
  if (!trimmedId || !trimmedSecret) {
    throw new Error('Both the client ID and client secret are required.');
  }

  await writeConfigFile({ clientId: trimmedId });
  await secureStore.setSecret(CLIENT_SECRET_KEY, trimmedSecret);
}

/** Merges a patch into email-receipts.json, always stripping the transient clientSecret field. */
async function writeConfigFile(
  patch: Partial<EmailReceiptsConfigFile>,
): Promise<void> {
  const existing = (await readConfigFile()) ?? {};
  const { clientSecret: _drop, ...rest } = existing;
  await lootFs.writeFile(
    getConfigPath(),
    JSON.stringify({ ...rest, ...patch }, null, 2),
  );
}

/**
 * Whether an unambiguous receipt match applies itself automatically or
 * always waits in the review queue. Off by default - a personal-finance app
 * shouldn't touch the ledger unsupervised until its owner trusts it.
 */
export async function setAutoApply(autoApply: boolean): Promise<void> {
  await writeConfigFile({ autoApply });
}

export async function setHistoryDays(historyDays: number): Promise<void> {
  if (!Number.isFinite(historyDays)) {
    throw new Error('History days must be a number.');
  }
  const clamped = Math.min(
    MAX_HISTORY_DAYS,
    Math.max(MIN_HISTORY_DAYS, Math.round(historyDays)),
  );
  await writeConfigFile({ historyDays: clamped });
}

async function getConfig(): Promise<EmailReceiptsConfig | null> {
  const fileConfig = await readConfigFile();
  const clientSecret = await getClientSecret(fileConfig);
  if (!fileConfig?.clientId || !clientSecret) {
    return null;
  }
  return {
    clientId: fileConfig.clientId,
    clientSecret,
    gmailQuery: fileConfig.gmailQuery ?? null,
    senderAllow: fileConfig.senderAllow ?? [],
    senderDeny: fileConfig.senderDeny ?? [],
    llmEndpoint: fileConfig.llmEndpoint ?? DEFAULT_LLM_ENDPOINT,
    llmModel: fileConfig.llmModel ?? DEFAULT_LLM_MODEL,
    historyDays: fileConfig.historyDays ?? DEFAULT_HISTORY_DAYS,
    maxMessagesPerSync: fileConfig.maxMessagesPerSync ?? DEFAULT_MAX_MESSAGES,
    autoApply: fileConfig.autoApply ?? false,
    incrementalSync: fileConfig.incrementalSync ?? false,
  };
}

// Local-AI endpoint/model on their own, reused by other local-AI features (the
// mortgage statement import) so they share the user's one Ollama setup without
// needing Gmail configured.
export async function getLlmSettings(): Promise<{
  endpoint: string;
  model: string;
}> {
  const fileConfig = await readConfigFile();
  return {
    endpoint: fileConfig?.llmEndpoint ?? DEFAULT_LLM_ENDPOINT,
    model: fileConfig?.llmModel ?? DEFAULT_LLM_MODEL,
  };
}

async function requireConfig(): Promise<EmailReceiptsConfig> {
  const config = await getConfig();
  if (!config) {
    throw new Error(
      'Email receipts are not configured. Create email-receipts.json ' +
        '(clientId, clientSecret) in the data directory.',
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// OAuth (Google "Desktop app" client, loopback redirect)
// ---------------------------------------------------------------------------

let pendingConnect: { port: number; state: string } | null = null;
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function startGmailConnect(): Promise<EmailReceiptsConnectStart> {
  const config = await requireConfig();
  const port = await oauthLoopback.startLoopback();
  const state = uuidv4();
  pendingConnect = { port, state };

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(port),
    response_type: 'code',
    scope: GMAIL_SCOPE,
    // A refresh token is only issued with offline access and (for repeat
    // consents on a Testing-status app) an explicit consent prompt.
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return { url: `${GOOGLE_AUTH_URL}?${params.toString()}` };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

async function tokenRequest(
  body: Record<string, string>,
): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  return (await res.json()) as TokenResponse;
}

export async function pollGmailConnect(): Promise<EmailReceiptsConnectPoll> {
  if (!pendingConnect) {
    return { status: 'error', message: 'No Gmail connection in progress' };
  }

  const poll = await oauthLoopback.pollLoopback();
  if (poll.error) {
    pendingConnect = null;
    await oauthLoopback.cancelLoopback();
    return { status: 'error', message: `Google sign-in failed: ${poll.error}` };
  }
  if (!poll.code) {
    return { status: 'pending' };
  }
  if (poll.state !== pendingConnect.state) {
    pendingConnect = null;
    await oauthLoopback.cancelLoopback();
    return {
      status: 'error',
      message: 'Google sign-in returned a mismatched state; try again',
    };
  }

  const config = await requireConfig();
  const token = await tokenRequest({
    code: poll.code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: redirectUri(pendingConnect.port),
    grant_type: 'authorization_code',
  });
  pendingConnect = null;

  if (!token.access_token || !token.refresh_token) {
    return {
      status: 'error',
      message:
        token.error_description ??
        token.error ??
        'Google did not return a refresh token',
    };
  }

  await secureStore.setSecret(REFRESH_TOKEN_KEY, token.refresh_token);
  cachedAccessToken = {
    token: token.access_token,
    expiresAt: Date.now() + ((token.expires_in ?? 3600) - 60) * 1000,
  };
  await setMeta('needs_reconnect', null);

  const profile = (await gmailFetch('/profile')) as {
    emailAddress?: string;
  };
  const email = profile.emailAddress ?? '';
  await setMeta('email', email);
  logger.log(`[email-receipts] connected Gmail account ${email}`);
  return { status: 'completed', email };
}

export async function disconnectGmail(): Promise<void> {
  await secureStore.removeSecret(REFRESH_TOKEN_KEY);
  cachedAccessToken = null;
  pendingConnect = null;
  await setMeta('email', null);
  await setMeta('needs_reconnect', null);
}

async function getAccessToken(): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }
  const config = await requireConfig();
  const refreshToken = await secureStore.getSecret(REFRESH_TOKEN_KEY);
  if (!refreshToken) {
    throw new Error('Gmail is not connected');
  }
  const token = await tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  if (!token.access_token) {
    if (token.error === 'invalid_grant') {
      // Testing-status OAuth apps expire refresh tokens after ~7 days; the
      // card shows Reconnect until Ben re-authorizes.
      await setMeta('needs_reconnect', '1');
      throw new Error(
        'The Gmail authorization expired (Google test apps lapse weekly). ' +
          'Use Reconnect on the Email Receipts card.',
      );
    }
    throw new Error(
      `Could not refresh the Gmail token: ${token.error_description ?? token.error ?? 'unknown error'}`,
    );
  }
  cachedAccessToken = {
    token: token.access_token,
    expiresAt: Date.now() + ((token.expires_in ?? 3600) - 60) * 1000,
  };
  return token.access_token;
}

async function gmailFetch(path: string): Promise<unknown> {
  let token = await getAccessToken();
  let res = await fetch(`${GMAIL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    cachedAccessToken = null;
    token = await getAccessToken();
    res = await fetch(`${GMAIL_API}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
  if (!res.ok) {
    throw new Error(`Gmail request failed (${res.status}) for ${path}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Message fetching + decoding
// ---------------------------------------------------------------------------

type GmailHeader = { name: string; value: string };
type GmailPart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
};
type GmailMessage = {
  id: string;
  threadId?: string;
  payload?: GmailPart & { headers?: GmailHeader[] };
};

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf8');
}

function findPart(
  part: GmailPart | undefined,
  mimeType: string,
): string | null {
  if (!part) {
    return null;
  }
  if (part.mimeType === mimeType && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) {
      return found;
    }
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Prefer the text/plain part; fall back to de-tagged text/html. */
export function decodeMessageBody(message: GmailMessage): string {
  const plain = findPart(message.payload, 'text/plain');
  if (plain) {
    return plain;
  }
  const html = findPart(message.payload, 'text/html');
  if (html) {
    return stripHtml(html);
  }
  return '';
}

/**
 * The RAW text/html part, kept verbatim (unlike decodeMessageBody, which
 * strips tags for the LLM). Used to render the attached PDF so it looks like
 * the real email. Null when the message is plain-text only.
 */
export function decodeMessageHtml(message: GmailMessage): string | null {
  const html = findPart(message.payload, 'text/html');
  return html ? html.slice(0, HTML_CAP) : null;
}

/**
 * Re-render the attached PDF for every already-applied receipt from the real
 * email HTML, replacing the old plain-text-blob attachment so it reads like
 * the actual message. Receipts synced before body_html existed are re-fetched
 * from Gmail once to recover their HTML (needs a live connection); ones synced
 * after just re-render offline. Safe to re-run: an attachment is only replaced
 * once its new PDF has rendered, so a failure never drops the existing file.
 */
export async function rebuildEmailAttachments(): Promise<{
  total: number;
  rebuilt: number;
  refetched: number;
  failed: number;
}> {
  const database = await getEmailDb();
  const rows = all<{ message_id: string; transaction_id: string }>(
    database,
    `SELECT message_id, transaction_id FROM match_proposals
      WHERE status IN ('applied', 'auto_applied')`,
  );

  let rebuilt = 0;
  let refetched = 0;
  let failed = 0;

  for (const { message_id, transaction_id } of rows) {
    try {
      let msg = first<EmailMessageRow>(
        database,
        `SELECT subject, from_addr, email_date, body, body_html
           FROM email_messages WHERE message_id = ?`,
        [message_id],
      );
      if (!msg) {
        failed++;
        continue;
      }

      // Receipts synced before body_html existed: recover the real HTML from
      // Gmail once and persist it back into the sidecar.
      if (!msg.body_html || !msg.body_html.trim()) {
        const message = (await gmailFetch(
          `/messages/${message_id}?format=full`,
        )) as GmailMessage;
        const html = decodeMessageHtml(message);
        run(
          database,
          'UPDATE email_messages SET body_html = ? WHERE message_id = ?',
          [html, message_id],
        );
        msg = { ...msg, body_html: html };
        refetched++;
      }

      const pdf = await renderHtmlToPdf(renderReceiptEmailHtml(msg, message_id));
      if (!pdf) {
        // No PDF render bridge (non-desktop) — leave the existing attachment.
        failed++;
        continue;
      }

      const datePart = (msg.email_date ?? '').slice(0, 10);
      await deleteAttachmentsForSource(transaction_id, message_id);
      await addAttachmentBuffer({
        transactionId: transaction_id,
        data: pdf,
        fileName: `receipt-email${datePart ? '-' + datePart : ''}.pdf`,
        contentType: 'application/pdf',
        source: 'email',
        sourceKey: message_id,
      });
      rebuilt++;
    } catch (err) {
      logger.warn(
        `[email-receipts] could not rebuild attachment for ${message_id}`,
        err,
      );
      failed++;
    }
  }

  logger.log(
    `[email-receipts] rebuilt ${rebuilt}/${rows.length} email attachments ` +
      `(${refetched} re-fetched from Gmail, ${failed} failed)`,
  );
  return { total: rows.length, rebuilt, refetched, failed };
}

function getHeader(message: GmailMessage, name: string): string {
  return (
    message.payload?.headers?.find(
      h => h.name.toLowerCase() === name.toLowerCase(),
    )?.value ?? ''
  );
}

function headerDateToDay(value: string): string | null {
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

const BODY_CAP = 64_000;
// Raw HTML for the attached PDF. Generous vs BODY_CAP (the LLM input) since
// receipt emails carry markup/inline styles; still bounded so a pathological
// message can't bloat the sidecar or overflow the render bridge's data: URL.
const HTML_CAP = 2_000_000;

export function buildGmailQuery(
  historyDays: number,
  sinceEpochSec: number | null,
): string {
  // Gmail `after:` takes unix seconds. Fall back to the rolling window on the
  // first incremental run (no watermark yet) or when incrementalSync is off.
  const timeClause =
    sinceEpochSec != null
      ? `after:${sinceEpochSec}`
      : `newer_than:${historyDays}d`;
  return (
    `${timeClause} ` +
    '(subject:(receipt OR order OR payment OR purchase OR invoice OR refund) ' +
    'OR from:(doordash OR venmo OR google OR 1aauto OR iracing OR carfax ' +
    'OR enterprise OR amazon OR paypal OR apple))'
  );
}

// ---------------------------------------------------------------------------
// Sync pipeline
// ---------------------------------------------------------------------------

type MessageRow = {
  message_id: string;
  from_addr: string | null;
  subject: string | null;
  email_date: string | null;
  classified: string;
  body: string | null;
};

type ExtractionRow = {
  message_id: string;
  model: string | null;
  output_json: string;
  status: string;
};

function parseStoredReceipt(row: ExtractionRow): ReceiptExtraction | null {
  return parseReceiptJson(row.output_json);
}

export async function syncEmailReceipts(): Promise<EmailReceiptsSyncResult> {
  const config = await requireConfig();
  const database = await getEmailDb();
  const result: EmailReceiptsSyncResult = {
    scanned: 0,
    classifiedOut: 0,
    extracted: 0,
    quarantined: 0,
    autoApplied: 0,
    queuedForReview: 0,
    unmatched: 0,
    llmUnavailable: false,
  };

  // Watermark for incremental syncs: record when THIS scan began, and (when
  // incrementalSync is on and we have a prior watermark) query forward from it
  // instead of re-listing the whole historyDays window.
  const scanStartedAt = new Date().toISOString();
  let sinceEpochSec: number | null = null;
  if (config.incrementalSync && !config.gmailQuery) {
    const lastScanAt = await getMeta('last_scan_at');
    if (lastScanAt) {
      const overlapMs = INCREMENTAL_OVERLAP_DAYS * 24 * 60 * 60 * 1000;
      sinceEpochSec = Math.floor((Date.parse(lastScanAt) - overlapMs) / 1000);
    }
  }

  // 1) List candidate messages.
  const query =
    config.gmailQuery ?? buildGmailQuery(config.historyDays, sinceEpochSec);
  const ids: string[] = [];
  let pageToken: string | null = null;
  while (ids.length < config.maxMessagesPerSync) {
    const params = new URLSearchParams({
      q: query,
      maxResults: String(
        Math.min(100, config.maxMessagesPerSync - ids.length),
      ),
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    const page = (await gmailFetch(`/messages?${params.toString()}`)) as {
      messages?: Array<{ id: string }>;
      nextPageToken?: string;
    };
    ids.push(...(page.messages ?? []).map(m => m.id));
    pageToken = page.nextPageToken ?? null;
    if (!pageToken || (page.messages ?? []).length === 0) {
      break;
    }
  }
  result.scanned = ids.length;

  // 2) Fetch + classify + persist new messages (idempotent on Gmail id).
  for (const id of ids) {
    const existing = first<{ message_id: string }>(
      database,
      'SELECT message_id FROM email_messages WHERE message_id = ?',
      [id],
    );
    if (existing) {
      continue;
    }
    const message = (await gmailFetch(
      `/messages/${id}?format=full`,
    )) as GmailMessage;
    const from = getHeader(message, 'From');
    const subject = getHeader(message, 'Subject');
    const emailDate = headerDateToDay(getHeader(message, 'Date'));
    const classified = classify(from, subject, {
      allow: config.senderAllow,
      deny: config.senderDeny,
    });
    const body =
      classified === 'receipt'
        ? decodeMessageBody(message).slice(0, BODY_CAP)
        : null;
    const bodyHtml =
      classified === 'receipt' ? decodeMessageHtml(message) : null;
    run(
      database,
      `INSERT INTO email_messages
         (message_id, thread_id, from_addr, subject, email_date, classified,
          body, body_html)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        message.threadId ?? null,
        from || null,
        subject || null,
        emailDate,
        classified,
        body,
        bodyHtml,
      ],
    );
    if (classified !== 'receipt') {
      result.classifiedOut++;
    }
  }

  // 3) Extract receipts that don't have an extraction yet, via the local
  //    model. If the endpoint is down we skip the whole phase and retry next
  //    sync - content never goes anywhere else.
  const toExtract = all<MessageRow>(
    database,
    `SELECT m.* FROM email_messages m
      LEFT JOIN extractions e ON e.message_id = m.message_id
      WHERE m.classified = 'receipt' AND e.message_id IS NULL`,
  );
  for (const message of toExtract) {
    if (!message.body || !message.body.trim()) {
      run(
        database,
        `INSERT INTO extractions (message_id, model, output_json, status)
         VALUES (?, ?, '{}', 'quarantined')`,
        [message.message_id, config.llmModel],
      );
      result.quarantined++;
      continue;
    }
    try {
      const extraction = await extractReceipt(message.body, {
        endpoint: config.llmEndpoint,
        model: config.llmModel,
      });
      run(
        database,
        `INSERT INTO extractions (message_id, model, output_json, status)
         VALUES (?, ?, ?, ?)`,
        [
          message.message_id,
          config.llmModel,
          JSON.stringify(extraction.receipt ?? {}),
          extraction.status,
        ],
      );
      if (extraction.status === 'ok') {
        result.extracted++;
      } else if (extraction.status === 'quarantined') {
        result.quarantined++;
      }
    } catch (err) {
      if (err instanceof LlmUnavailableError) {
        logger.warn(
          '[email-receipts] local model unavailable; skipping extraction until next sync',
        );
        result.llmUnavailable = true;
        break;
      }
      throw err;
    }
  }

  // 4) Match extractions that aren't settled yet against the ledger. This
  //    also re-checks older receipts whose bank transaction may only have
  //    posted since the last sync.
  const toMatch = all<ExtractionRow>(
    database,
    `SELECT e.* FROM extractions e
      WHERE e.status = 'ok'
        AND NOT EXISTS (
          SELECT 1 FROM match_proposals p
           WHERE p.message_id = e.message_id
             AND p.status IN ('applied', 'auto_applied')
        )`,
  );
  for (const row of toMatch) {
    const receipt = parseStoredReceipt(row);
    if (!receipt) {
      continue;
    }
    const candidates = await findCandidates(row.message_id, receipt);
    const existingProposals = all<{ id: number }>(
      database,
      `SELECT id FROM match_proposals WHERE message_id = ? AND status = 'review'`,
      [row.message_id],
    );

    if (candidates.length === 0) {
      if (existingProposals.length === 0) {
        result.unmatched++;
      }
      continue;
    }

    // The deliberately narrow auto-apply gate: exactly one ledger transaction
    // matches on exact signed amount in the window, extraction passed
    // quarantine (status ok), nothing about this receipt was queued before,
    // and the transaction isn't reconciled. Everything else goes to review.
    // config.autoApply is the master switch (off by default) - even a
    // slam-dunk match only applies itself once the user has opted in.
    if (
      config.autoApply &&
      candidates.length === 1 &&
      existingProposals.length === 0 &&
      !candidates[0].reconciled
    ) {
      const proposalId = await recordProposal(
        row.message_id,
        candidates[0],
        'review',
      );
      await applyProposal(proposalId, receipt, { auto: true });
      result.autoApplied++;
    } else {
      let queued = false;
      for (const candidate of candidates) {
        await recordProposal(row.message_id, candidate, 'review');
        queued = true;
      }
      if (queued && existingProposals.length === 0) {
        result.queuedForReview++;
      }
    }
  }

  await setMeta('last_sync', new Date().toISOString());
  // Advance the incremental watermark only on a completed sync; a mid-sync
  // throw leaves it untouched so the next run re-covers the same span.
  await setMeta('last_scan_at', scanStartedAt);
  logger.log(
    `[email-receipts] sync (${sinceEpochSec != null ? 'incremental' : 'full window'}): ` +
      `${result.scanned} scanned, ` +
      `${result.extracted} extracted, ${result.autoApplied} auto-applied, ` +
      `${result.queuedForReview} queued, ${result.unmatched} unmatched` +
      (result.llmUnavailable ? ' (local model offline)' : ''),
  );
  return result;
}

// ---------------------------------------------------------------------------
// Status + review queue
// ---------------------------------------------------------------------------

export async function getEmailReceiptsStatus(): Promise<EmailReceiptsStatus> {
  const available = await secureStore.isAvailable();
  const fileConfig = available ? await readConfigFile() : null;
  const llmEndpoint = fileConfig?.llmEndpoint ?? DEFAULT_LLM_ENDPOINT;
  const llmModel = fileConfig?.llmModel ?? DEFAULT_LLM_MODEL;

  if (!available) {
    return {
      available: false,
      configured: false,
      connected: false,
      needsReconnect: false,
      email: null,
      llm: { endpoint: llmEndpoint, model: llmModel, connected: false },
      pendingReview: 0,
      lastSync: null,
      autoApply: fileConfig?.autoApply ?? false,
      historyDays: fileConfig?.historyDays ?? DEFAULT_HISTORY_DAYS,
    };
  }

  const config = await getConfig();
  const refreshToken = config
    ? await secureStore.getSecret(REFRESH_TOKEN_KEY)
    : null;
  const needsReconnect = (await getMeta('needs_reconnect')) === '1';
  const email = await getMeta('email');
  const lastSync = await getMeta('last_sync');

  const database = await getEmailDb();
  // A receipt counts as "pending review" when it has a usable extraction,
  // isn't already applied, and is either not dismissed OR has a live match
  // proposal waiting (a dismissed receipt re-surfaces once a candidate posts).
  const pendingRow = first<{ count: number }>(
    database,
    `SELECT COUNT(*) AS count FROM extractions e
      JOIN email_messages m ON m.message_id = e.message_id
      WHERE e.status = 'ok'
        AND NOT EXISTS (
          SELECT 1 FROM match_proposals p
           WHERE p.message_id = e.message_id
             AND p.status IN ('applied', 'auto_applied')
        )
        AND (
          m.dismissed = 0
          OR EXISTS (
            SELECT 1 FROM match_proposals p
             WHERE p.message_id = e.message_id AND p.status = 'review'
          )
        )`,
  );

  return {
    available,
    configured: config != null,
    connected: refreshToken != null && !needsReconnect,
    needsReconnect: refreshToken != null && needsReconnect,
    email,
    llm: {
      endpoint: llmEndpoint,
      model: llmModel,
      connected: await pingLlm(llmEndpoint),
    },
    pendingReview: pendingRow?.count ?? 0,
    lastSync,
    autoApply: config?.autoApply ?? false,
    historyDays: config?.historyDays ?? DEFAULT_HISTORY_DAYS,
  };
}

async function proposalTransactions(
  transactionIds: string[],
): Promise<
  Map<string, { date: string; amount: number; payee_name: string | null }>
> {
  if (transactionIds.length === 0) {
    return new Map();
  }
  const { data } = await aqlQuery(
    q('transactions')
      .filter({ id: { $oneof: transactionIds } })
      .select(['id', 'date', 'amount', { payee_name: 'payee.name' }])
      .options({ splits: 'grouped' }),
  );
  return new Map(
    (
      data as Array<{
        id: string;
        date: string;
        amount: number;
        payee_name: string | null;
      }>
    ).map(t => [t.id, t]),
  );
}

export async function getReviewItems(): Promise<{
  pending: EmailReviewItem[];
  applied: EmailReviewItem[];
}> {
  const database = await getEmailDb();

  const rows = all<ExtractionRow & MessageRow & { dismissed: number }>(
    database,
    `SELECT e.message_id, e.model, e.output_json, e.status,
            m.from_addr, m.subject, m.email_date, m.dismissed
       FROM extractions e
       JOIN email_messages m ON m.message_id = e.message_id
      WHERE e.status = 'ok'
      ORDER BY m.email_date DESC`,
  );

  const proposalRows = all<{
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
  }>(
    database,
    `SELECT * FROM match_proposals WHERE status IN ('review', 'applied', 'auto_applied')`,
  );

  const transactions = await proposalTransactions(
    proposalRows.map(p => p.transaction_id),
  );

  const byMessage = new Map<string, EmailMatchProposal[]>();
  for (const row of proposalRows) {
    const list = byMessage.get(row.message_id) ?? [];
    list.push(
      toEmailMatchProposal(row, transactions.get(row.transaction_id) ?? null),
    );
    byMessage.set(row.message_id, list);
  }

  const pending: EmailReviewItem[] = [];
  const applied: EmailReviewItem[] = [];
  for (const row of rows) {
    const receipt = parseStoredReceipt(row);
    if (!receipt) {
      continue;
    }
    const proposals = byMessage.get(row.message_id) ?? [];
    const item: EmailReviewItem = {
      messageId: row.message_id,
      from: row.from_addr,
      subject: row.subject,
      emailDate: row.email_date,
      receipt,
      proposals,
    };
    if (
      proposals.some(
        p => p.status === 'applied' || p.status === 'auto_applied',
      )
    ) {
      applied.push(item);
    } else if (
      row.dismissed === 1 &&
      !proposals.some(p => p.status === 'review')
    ) {
      // Dismissed and still nothing to act on - stay hidden until a bank
      // transaction posts and gives it a candidate.
      continue;
    } else {
      pending.push(item);
    }
  }
  return { pending, applied };
}

export async function applyMatch({
  proposalId,
  payeeName,
}: {
  proposalId: number;
  payeeName?: string;
}): Promise<void> {
  const database = await getEmailDb();
  const proposal = first<{ message_id: string }>(
    database,
    'SELECT message_id FROM match_proposals WHERE id = ?',
    [proposalId],
  );
  if (!proposal) {
    throw new Error(`No match proposal ${proposalId}`);
  }
  const extraction = first<ExtractionRow>(
    database,
    'SELECT * FROM extractions WHERE message_id = ?',
    [proposal.message_id],
  );
  const receipt = extraction ? parseStoredReceipt(extraction) : null;
  if (!receipt) {
    throw new Error('The extraction for this match is no longer readable');
  }
  await applyProposal(proposalId, receipt, { payeeName });
}

/**
 * Link a receipt to a transaction the user picked by hand, bypassing the
 * automatic matcher. Records a full-confidence proposal for the pair and
 * applies it through the normal apply path (split/enrich + attach email),
 * so undo, snapshots, and idempotency all behave exactly like an automatic
 * match.
 */
export async function linkManualMatch({
  messageId,
  transactionId,
  payeeName,
}: {
  messageId: string;
  transactionId: string;
  payeeName?: string;
}): Promise<void> {
  const proposalId = await recordProposal(
    messageId,
    { id: transactionId, merchantScore: 1, dateGapDays: 0, score: 1 },
    'review',
  );
  await applyMatch({ proposalId, payeeName });
}

export async function rejectMatch({
  proposalId,
  messageId,
}: {
  proposalId?: number;
  messageId?: string;
}): Promise<void> {
  if (proposalId != null) {
    await rejectProposal(proposalId);
    return;
  }
  if (messageId) {
    // Dismiss an unmatched receipt from the review queue. This only hides it
    // (a message-level flag) - the matcher keeps checking it on every sync,
    // so if the bank charge posts a day later the receipt re-surfaces with
    // its new candidate instead of being lost. (Contrast rejectProposal,
    // which durably suppresses a specific message<->transaction pairing.)
    const database = await getEmailDb();
    run(
      database,
      `UPDATE email_messages SET dismissed = 1 WHERE message_id = ?`,
      [messageId],
    );
  }
}

export async function unapplyMatch({
  proposalId,
}: {
  proposalId: number;
}): Promise<void> {
  await unapplyProposal(proposalId);
}
