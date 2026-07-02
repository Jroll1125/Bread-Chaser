import { getAccountDb } from '../src/account-db';

export const up = async function () {
  const accountDb = getAccountDb();

  accountDb.exec(`
    CREATE TABLE IF NOT EXISTS attachments
      (id TEXT PRIMARY KEY,
       owner TEXT NOT NULL,
       transaction_id TEXT NOT NULL,
       file_name TEXT,
       content_type TEXT,
       size_bytes INTEGER,
       key_meta TEXT,
       created_at INTEGER,
       deleted INTEGER NOT NULL DEFAULT 0);

    CREATE INDEX IF NOT EXISTS attachments_transaction_id
      ON attachments (transaction_id);
  `);
};

export const down = async function () {
  const accountDb = getAccountDb();

  accountDb.exec(`
    DROP INDEX IF EXISTS attachments_transaction_id;
    DROP TABLE IF EXISTS attachments;
  `);
};
