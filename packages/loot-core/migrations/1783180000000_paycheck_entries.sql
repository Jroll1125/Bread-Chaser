-- Per-entered-paycheck record. Most paycheck YTD numbers (per-line earnings,
-- taxes, gross, net) are recovered from the categorized split children, so they
-- need no storage here. Qualified overtime is the exception: it's a non-taxable
-- annotation, not its own money line / category, so it can't be summed from the
-- ledger. We record it per entered check here (linked to the generated split
-- parent) so a running YTD is possible and past checks can be backfilled.
BEGIN TRANSACTION;

CREATE TABLE paycheck_entries (
  id TEXT PRIMARY KEY,
  config_id TEXT,
  transaction_id TEXT,
  date INTEGER,
  qualified_ot INTEGER DEFAULT 0,
  tombstone INTEGER DEFAULT 0
);

COMMIT;
