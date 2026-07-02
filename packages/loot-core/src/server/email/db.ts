import * as lootFs from '#platform/server/fs';
import * as sqlite from '#platform/server/sqlite';

/**
 * Sidecar SQLite database for the email-receipts pipeline. This is
 * deliberately NOT the synced budget database: raw email metadata,
 * extractions, and match bookkeeping are local-machine state (mirroring the
 * companion service's tables) and must never enter the CRDT sync stream. The
 * only writes to the budget itself go through batchUpdateTransactions in
 * match.ts.
 */

const DB_FILE = 'email-receipts.sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS email_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT,
  from_addr TEXT,
  subject TEXT,
  email_date TEXT,
  classified TEXT NOT NULL,
  body TEXT,
  -- Set when the user dismisses an unmatched receipt from the review queue.
  -- Only hides it from the queue; the matcher keeps checking it, so it
  -- re-surfaces if a bank transaction posts later and becomes a candidate.
  dismissed INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extractions (
  message_id TEXT PRIMARY KEY REFERENCES email_messages(message_id),
  model TEXT,
  output_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS match_proposals (
  id INTEGER PRIMARY KEY,
  message_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  score REAL NOT NULL,
  merchant_score REAL NOT NULL,
  date_gap_days INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'review',
  applied_split INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  UNIQUE (message_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS rejected_pairs (
  message_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  rejected_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (message_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

type SidecarDb = Awaited<ReturnType<typeof sqlite.openDatabase>>;

let db: SidecarDb | null = null;

export async function getEmailDb(): Promise<SidecarDb> {
  if (db) {
    return db;
  }
  const dataDir = lootFs.getDataDir();
  if (!dataDir) {
    throw new Error('Email receipts require the data directory to be set');
  }
  db = await sqlite.openDatabase(lootFs.join(dataDir, DB_FILE));
  sqlite.execQuery(db, SCHEMA);
  migrate(db);
  return db;
}

// Idempotent column adds for DBs created by an earlier build. SQLite has no
// "ADD COLUMN IF NOT EXISTS", so we swallow the duplicate-column error.
function migrate(database: SidecarDb): void {
  const adds = [
    'ALTER TABLE email_messages ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0',
  ];
  for (const sql of adds) {
    try {
      sqlite.execQuery(database, sql);
    } catch {
      // Column already exists.
    }
  }
}

/** Tests point the module at an in-memory database. */
export async function openEmailDbForTesting(): Promise<SidecarDb> {
  await sqlite.init();
  db = await sqlite.openDatabase(':memory:');
  sqlite.execQuery(db, SCHEMA);
  return db;
}

export function closeEmailDb(): void {
  if (db) {
    sqlite.closeDatabase(db);
    db = null;
  }
}

// SQLite (and the platform layer's runtime validation) accept null params,
// but the declared platform types don't - cast at this boundary only.
type SqlParams = (string | number)[];

export function run(
  database: SidecarDb,
  sql: string,
  params: (string | number | null)[] = [],
): void {
  sqlite.runQuery(database, sql, params as SqlParams, false);
}

export function all<T>(
  database: SidecarDb,
  sql: string,
  params: (string | number | null)[] = [],
): T[] {
  return sqlite.runQuery(database, sql, params as SqlParams, true) as T[];
}

export function first<T>(
  database: SidecarDb,
  sql: string,
  params: (string | number | null)[] = [],
): T | null {
  const rows = all<T>(database, sql, params);
  return rows.length > 0 ? rows[0] : null;
}

export async function getMeta(key: string): Promise<string | null> {
  const database = await getEmailDb();
  const row = first<{ value: string | null }>(
    database,
    'SELECT value FROM meta WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string | null): Promise<void> {
  const database = await getEmailDb();
  run(
    database,
    'INSERT INTO meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value],
  );
}
