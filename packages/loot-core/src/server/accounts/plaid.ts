import { fetch } from '#platform/server/fetch';
import * as lootFs from '#platform/server/fs';
import { logger } from '#platform/server/log';
import * as secureStore from '#platform/server/secure-store';
import { BankSyncError } from '#server/errors';
import type {
  PlaidAccount,
  PlaidEnv,
  PlaidHostedLink,
  PlaidItem,
  PlaidLinkPoll,
  PlaidStatus,
} from '#types/models';

const PLAID_HOSTS: Record<PlaidEnv, string> = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

// Investments and loans are net-worth-only (off-budget); depository and
// credit are the spendable/owed accounts you budget against.
const OFFBUDGET_TYPES = new Set(['investment', 'loan', 'brokerage']);

export function isOffBudgetPlaidType(type: string): boolean {
  return OFFBUDGET_TYPES.has(type);
}

const CONFIG_FILE = 'plaid.json';
const CLIENT_SECRET_KEY = 'plaid-client-secret';
const accessTokenKey = (itemId: string) => `plaid-access-token-${itemId}`;
// Plaid's /transactions/sync cursor is per-item, but Actual syncs one account
// at a time; each account keeps its own position in the item's stream so one
// account's sync can never skip past another account's transactions.
const cursorKey = (itemId: string, acctId: string) =>
  `plaid-cursor-${itemId}-${acctId}`;

type PlaidConfigFile = {
  clientId?: string;
  env?: string;
  // Only present transiently: migrated into the secure store (and stripped
  // from the file) on first read.
  secret?: string;
};

type PlaidConfig = {
  clientId: string;
  env: PlaidEnv;
  secret: string;
};

function getConfigPath(): string {
  const dataDir = lootFs.getDataDir();
  if (!dataDir) {
    throw new BankSyncError(
      'Plaid requires the data directory to be set',
      'PLAID_NOT_CONFIGURED',
      'PLAID_NOT_CONFIGURED',
    );
  }
  return lootFs.join(dataDir, CONFIG_FILE);
}

async function readConfigFile(): Promise<PlaidConfigFile | null> {
  const configPath = getConfigPath();
  if (!(await lootFs.exists(configPath))) {
    return null;
  }
  try {
    const parsed = JSON.parse(await lootFs.readFile(configPath));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Plaid config is not a JSON object');
    }
    return parsed;
  } catch (err) {
    logger.error(`Could not parse Plaid config at ${configPath}`, err);
    return null;
  }
}

async function getClientSecret(
  fileConfig: PlaidConfigFile | null,
): Promise<string | null> {
  if (!(await secureStore.isAvailable())) {
    return null;
  }

  // One-time migration: a secret dropped into plaid.json moves into the
  // OS-encrypted store and is stripped from the plain file.
  if (fileConfig?.secret) {
    await secureStore.setSecret(CLIENT_SECRET_KEY, fileConfig.secret);
    const { secret: _secret, ...rest } = fileConfig;
    await lootFs.writeFile(getConfigPath(), JSON.stringify(rest, null, 2));
    delete fileConfig.secret;
  }

  return secureStore.getSecret(CLIENT_SECRET_KEY);
}

async function getPlaidConfig(): Promise<PlaidConfig | null> {
  const fileConfig = await readConfigFile();
  const secret = await getClientSecret(fileConfig);

  const env = fileConfig?.env === 'production' ? 'production' : 'sandbox';
  if (!fileConfig?.clientId || !secret) {
    return null;
  }

  return { clientId: fileConfig.clientId, env, secret };
}

export async function getPlaidStatus(): Promise<PlaidStatus> {
  const available = await secureStore.isAvailable();
  if (!available) {
    return { available: false, configured: false, env: null };
  }
  const config = await getPlaidConfig();
  const fileConfig = config ? null : await readConfigFile();
  return {
    available,
    configured: config != null,
    env: config?.env ?? (fileConfig?.env === 'production' ? 'production' : null),
  };
}

async function requirePlaidConfig(): Promise<PlaidConfig> {
  const config = await getPlaidConfig();
  if (!config) {
    throw new BankSyncError(
      'Plaid is not configured. Create plaid.json (clientId, env, secret) in the data directory.',
      'PLAID_NOT_CONFIGURED',
      'PLAID_NOT_CONFIGURED',
    );
  }
  return config;
}

// Plaid's rate limits (e.g. /transactions/sync: 50/min per Item in
// Production) are per-minute rolling windows with no Retry-After header, so
// a fixed wait just past a minute is the simplest correct backoff. This
// matters most for a first full sync across several accounts on one item -
// each account pages through its own history via /transactions/sync with no
// artificial pacing between calls, and that legitimate volume (proportional
// to actual transaction count, not redundant calls) can cross the per-item
// cap well before the last account is reached.
const RATE_LIMIT_RETRY_WAIT_MS = 65_000;
const RATE_LIMIT_MAX_RETRIES = 2;

async function plaidFetch<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const { clientId, env, secret } = await requirePlaidConfig();

  for (let attempt = 0; ; attempt++) {
    logger.log('Plaid request:', env, path);
    const res = await fetch(PLAID_HOSTS[env] + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, secret, ...body }),
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new BankSyncError(
        `Plaid returned a non-JSON response (${res.status}) for ${path}`,
        'PLAID_ERROR',
        String(res.status),
      );
    }

    if (!res.ok || data?.error_code) {
      if (
        data?.error_type === 'RATE_LIMIT_EXCEEDED' &&
        attempt < RATE_LIMIT_MAX_RETRIES
      ) {
        logger.warn(
          `Plaid rate limit on ${path} (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES + 1}); ` +
            `waiting ${RATE_LIMIT_RETRY_WAIT_MS / 1000}s and retrying`,
        );
        await new Promise(resolve =>
          setTimeout(resolve, RATE_LIMIT_RETRY_WAIT_MS),
        );
        continue;
      }

      // Plaid's error_type/error_code (e.g. ITEM_ERROR / ITEM_LOGIN_REQUIRED)
      // already match the categories handleSyncError maps to statuses like
      // reauth-required.
      throw new BankSyncError(
        data?.error_message ?? `Plaid request failed (${res.status})`,
        data?.error_type ?? 'PLAID_ERROR',
        data?.error_code ?? String(res.status),
      );
    }

    return data as T;
  }
}

type PlaidApiAccount = {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
};

function mapAccount(account: PlaidApiAccount): PlaidAccount {
  return {
    account_id: account.account_id,
    name: account.name,
    official_name: account.official_name,
    mask: account.mask,
    type: account.type,
    subtype: account.subtype,
    balances: {
      current: account.balances.current,
      available: account.balances.available,
      limit: account.balances.limit,
      iso_currency_code: account.balances.iso_currency_code,
    },
  };
}

async function requireAccessToken(itemId: string): Promise<string> {
  const token = await secureStore.getSecret(accessTokenKey(itemId));
  if (!token) {
    // Missing token maps to the reauth-required bank_sync_status.
    throw new BankSyncError(
      `No Plaid access token stored for item ${itemId}. Re-connect the bank.`,
      'ITEM_ERROR',
      'ITEM_LOGIN_REQUIRED',
    );
  }
  return token;
}

// Plaid fixes an Item's available transaction history at creation time (the
// initial /transactions/sync pull), not per-sync - days_requested here only
// affects links created from this point on. An already-linked Item can't be
// backfilled further; getting more history for an existing bank requires
// unlinking and relinking it (which mints a new Item).
const PRODUCTION_DAYS_REQUESTED = 730; // ~2 years; actual depth is bank-dependent

/**
 * Create a Plaid Hosted Link session. The returned URL is opened in the
 * system browser (Hosted Link handles OAuth institutions like Chase, which
 * refuse to authenticate inside embedded app windows); completion is picked
 * up by polling pollHostedLink.
 */
export async function createHostedLink(): Promise<PlaidHostedLink> {
  const res = await plaidFetch<{
    link_token: string;
    hosted_link_url: string;
  }>('/link/token/create', {
    user: { client_user_id: 'bread-chaser' },
    client_name: 'Bread Chaser',
    products: ['transactions'],
    country_codes: ['US'],
    language: 'en',
    transactions: { days_requested: PRODUCTION_DAYS_REQUESTED },
    hosted_link: {},
  });
  return { linkToken: res.link_token, url: res.hosted_link_url };
}

export async function pollHostedLink(
  linkToken: string,
): Promise<PlaidLinkPoll> {
  const res = await plaidFetch<{
    link_sessions?: Array<{
      results?: {
        item_add_results?: Array<{
          public_token?: string;
          institution?: { name?: string };
        }>;
      };
    }>;
  }>('/link/token/get', { link_token: linkToken });

  const result = res.link_sessions?.[0]?.results?.item_add_results?.[0];
  if (result?.public_token) {
    return {
      status: 'completed',
      publicToken: result.public_token,
      institution: result.institution?.name ?? null,
    };
  }
  return { status: 'pending' };
}

/**
 * Exchange a Link public_token for an access token (stored OS-encrypted) and
 * return the item with its accounts.
 */
export async function exchangePublicToken(
  publicToken: string,
  institution: string | null,
): Promise<PlaidItem> {
  const ex = await plaidFetch<{ access_token: string; item_id: string }>(
    '/item/public_token/exchange',
    { public_token: publicToken },
  );
  await secureStore.setSecret(accessTokenKey(ex.item_id), ex.access_token);
  const accounts = await getItemAccounts(ex.item_id);
  return { item_id: ex.item_id, institution, accounts };
}

/** Sandbox-only: create a fake item without the Plaid Link browser flow. */
export async function createSandboxItem(
  institutionId = 'ins_109508',
): Promise<PlaidItem> {
  const pt = await plaidFetch<{ public_token: string }>(
    '/sandbox/public_token/create',
    {
      institution_id: institutionId,
      initial_products: ['transactions'],
      options: { transactions: { days_requested: 90 } },
    },
  );
  return exchangePublicToken(pt.public_token, `Plaid Sandbox (${institutionId})`);
}

// /accounts/get and the item's historical-backfill readiness (below) are
// per-ITEM, but loot-core's sync dispatch calls syncAccount once per
// account (#server/accounts/sync.ts). Without caching, an item with N
// accounts makes N redundant /accounts/get calls - and, worse, N
// independent history-ready polling loops - on every "sync all" pass. Plaid
// rate-limits /accounts/get to 15/min per Item in Production, which a
// 5-account credit union item blows through immediately without this.
// Process-lifetime cache is fine here: it only needs to survive one sync
// batch, and a restart just costs one extra check cycle per item.
const ACCOUNTS_CACHE_TTL_MS = 45_000;
const accountsCache = new Map<
  string,
  { accounts: PlaidApiAccount[]; expires: number }
>();

async function getItemAccountsRaw(
  itemId: string,
  token: string,
): Promise<PlaidApiAccount[]> {
  const cached = accountsCache.get(itemId);
  if (cached && cached.expires > Date.now()) {
    return cached.accounts;
  }
  const res = await plaidFetch<{ accounts: PlaidApiAccount[] }>(
    '/accounts/get',
    { access_token: token },
  );
  accountsCache.set(itemId, {
    accounts: res.accounts,
    expires: Date.now() + ACCOUNTS_CACHE_TTL_MS,
  });
  return res.accounts;
}

export async function getItemAccounts(
  itemId: string,
): Promise<PlaidAccount[]> {
  const token = await requireAccessToken(itemId);
  const accounts = await getItemAccountsRaw(itemId, token);
  return accounts.map(mapAccount);
}

/** Credit/loan balances are amounts OWED, so they're negative in Actual. */
function signedBalanceCents(account: PlaidApiAccount): number {
  const raw = account.balances.current ?? 0;
  const signed =
    account.type === 'credit' || account.type === 'loan' ? -Math.abs(raw) : raw;
  return Math.round(signed * 100);
}

type PlaidApiTransaction = {
  transaction_id: string;
  account_id: string;
  // Positive for outflow (opposite of Actual's convention).
  amount: number;
  iso_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
};

type TransactionsSyncResponse = {
  added: PlaidApiTransaction[];
  modified: PlaidApiTransaction[];
  removed: Array<{ transaction_id: string; account_id?: string }>;
  next_cursor: string;
  has_more: boolean;
  transactions_update_status?: string;
};

// A wider transactions.days_requested window (up to 730 days) takes Plaid
// longer to backfill from the institution than the old 90-day default did -
// long enough that the previous 90s timeout routinely gave up before
// HISTORICAL_UPDATE_COMPLETE, silently downgrading a 2-year request to
// whatever partial snapshot existed at the 90s mark. A coarser poll interval
// keeps this well under Plaid's per-item rate limit even at a longer
// deadline (5min / 8s ≈ 8 calls/min, vs. a 15/min cap).
const HISTORY_READY_TIMEOUT_MS = 5 * 60_000;
const HISTORY_READY_POLL_INTERVAL_MS = 8_000;

/**
 * After an item is first linked, Plaid prepares its transaction history
 * asynchronously. Importing a partial window would poison the starting
 * balance (initial = current - sum(posted) only holds if we saw every posted
 * transaction), so the first sync waits for the full history window.
 */
async function waitForHistoryReady(token: string): Promise<void> {
  const deadline = Date.now() + HISTORY_READY_TIMEOUT_MS;
  while (true) {
    const probe = await plaidFetch<TransactionsSyncResponse>(
      '/transactions/sync',
      { access_token: token, count: 1 },
    );
    if (probe.transactions_update_status === 'HISTORICAL_UPDATE_COMPLETE') {
      return;
    }
    if (Date.now() > deadline) {
      logger.warn(
        `Plaid history not ready after ${HISTORY_READY_TIMEOUT_MS / 1000}s ` +
          `(status: ${probe.transactions_update_status}); importing what ` +
          'exists - the starting balance may need a manual fix',
      );
      return;
    }
    await new Promise(resolve =>
      setTimeout(resolve, HISTORY_READY_POLL_INTERVAL_MS),
    );
  }
}

// Historical-backfill readiness is also an item-level fact, not a per-account
// one - dedupe the wait itself so N accounts on one item share a single
// polling loop instead of running N in parallel/succession.
const historyReadyPromises = new Map<string, Promise<void>>();

function waitForHistoryReadyOnce(
  itemId: string,
  token: string,
): Promise<void> {
  let promise = historyReadyPromises.get(itemId);
  if (!promise) {
    promise = waitForHistoryReady(token);
    historyReadyPromises.set(itemId, promise);
  }
  return promise;
}

// The shape normalizeBankSyncTransactions consumes (loot-core's providers all
// feed it a superset of GoCardlessTransaction; the dispatch is untyped).
type PlaidSyncTransaction = {
  transactionId: string;
  booked: boolean;
  amount: number;
  transactionAmount: { amount: string; currency: string };
  date: string;
  payeeName: string;
  imported_payee: string;
  notes: string | null;
};

function mapTransaction(t: PlaidApiTransaction): PlaidSyncTransaction {
  // Plaid reports outflow as positive; Actual wants negative.
  const amount = -t.amount;
  return {
    transactionId: `plaid:${t.transaction_id}`,
    booked: true,
    amount,
    transactionAmount: {
      amount: String(amount),
      currency: t.iso_currency_code ?? 'USD',
    },
    date: t.authorized_date ?? t.date,
    payeeName: t.merchant_name || t.name,
    // The raw bank descriptor - payee rules match on this.
    imported_payee: t.name,
    notes: t.name,
  };
}

export type PlaidDownloadResult = {
  download: {
    transactions: PlaidSyncTransaction[];
    accountBalance: Array<{
      balanceAmount: { amount: string; currency: string };
      balanceType: 'expected';
    }>;
    startingBalance: number;
  };
  nextCursor: string | null;
};

/**
 * Cursor-based incremental download for one account, in the shape
 * processBankSyncDownload expects (mirrors downloadSimpleFinTransactions).
 * `startingBalance` is the signed CURRENT balance in integer cents, matching
 * the other providers.
 *
 * The advanced cursor is returned, NOT persisted - the caller persists it via
 * savePlaidCursor only after the transactions are committed, so a crash can
 * never advance the cursor past data that wasn't stored.
 */
export async function downloadPlaidTransactions(
  itemId: string,
  acctId: string,
  since: string,
): Promise<PlaidDownloadResult> {
  const token = await requireAccessToken(itemId);

  logger.log('Pulling transactions from Plaid');

  const accounts = await getItemAccountsRaw(itemId, token);
  const account = accounts.find(a => a.account_id === acctId);
  if (!account) {
    throw new BankSyncError(
      `Plaid item ${itemId} no longer reports account ${acctId}`,
      'ACCOUNT_MISSING',
      'ACCOUNT_MISSING',
    );
  }

  let cursor =
    (await secureStore.getSecret(cursorKey(itemId, acctId))) ?? undefined;
  if (cursor === undefined) {
    await waitForHistoryReadyOnce(itemId, token);
  }
  // Dedupe across pages and across added/modified by transaction id; a later
  // occurrence is a Plaid correction and wins.
  const changed = new Map<string, PlaidApiTransaction>();
  const removed: string[] = [];
  let hasMore = true;
  while (hasMore) {
    const res = await plaidFetch<TransactionsSyncResponse>(
      '/transactions/sync',
      cursor ? { access_token: token, cursor } : { access_token: token },
    );
    for (const t of [...res.added, ...res.modified]) {
      changed.set(t.transaction_id, t);
    }
    for (const r of res.removed) {
      if (r.account_id === undefined || r.account_id === acctId) {
        removed.push(r.transaction_id);
      }
    }
    hasMore = res.has_more;
    cursor = res.next_cursor;
  }

  if (removed.length > 0) {
    // Usually a pending transaction that re-posted under a new id; pending
    // transactions are never imported here, so this only matters if Plaid
    // retracts a POSTED transaction - surface it for a manual ledger fix.
    logger.warn(
      `Plaid removed ${removed.length} transaction(s) for account ${acctId}; ` +
        `if any were already imported, resolve them manually`,
      removed,
    );
  }

  const transactions = [...changed.values()]
    .filter(
      t =>
        t.account_id === acctId &&
        !t.pending &&
        (t.authorized_date ?? t.date) >= since,
    )
    .map(mapTransaction)
    // Newest first: processBankSyncDownload treats the LAST element as the
    // oldest transaction when dating the starting balance.
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const currency = account.balances.iso_currency_code ?? 'USD';
  return {
    download: {
      transactions,
      accountBalance: [
        {
          balanceAmount: {
            amount: String(account.balances.current ?? 0),
            currency,
          },
          balanceType: 'expected',
        },
      ],
      startingBalance: signedBalanceCents(account),
    },
    nextCursor: cursor ?? null,
  };
}

export async function savePlaidCursor(
  itemId: string,
  acctId: string,
  cursor: string | null,
): Promise<void> {
  if (cursor) {
    await secureStore.setSecret(cursorKey(itemId, acctId), cursor);
  }
}

/** Dev/recovery affordance: force the next sync to replay the full window. */
export async function resetPlaidCursor(
  itemId: string,
  acctId: string,
): Promise<void> {
  await secureStore.removeSecret(cursorKey(itemId, acctId));
}
