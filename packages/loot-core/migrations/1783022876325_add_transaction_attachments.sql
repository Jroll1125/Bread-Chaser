BEGIN TRANSACTION;

CREATE TABLE transaction_attachments
  (id TEXT PRIMARY KEY,
   transaction_id TEXT,
   file_name TEXT,
   content_type TEXT,
   size_bytes INTEGER,
   source TEXT,
   source_key TEXT,
   key_meta TEXT,
   created_at INTEGER,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX transaction_attachments_transaction_id
  ON transaction_attachments(transaction_id);

COMMIT;
