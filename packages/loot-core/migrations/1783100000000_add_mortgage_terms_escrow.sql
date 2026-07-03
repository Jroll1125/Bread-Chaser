BEGIN TRANSACTION;

-- Loan terms, so the account page can draw an amortization schedule, payoff
-- date, and progress. All nullable: a config saved before this migration keeps
-- working, and these get filled in when the user enters full terms.
ALTER TABLE mortgage_configs ADD COLUMN original_principal INTEGER;
ALTER TABLE mortgage_configs ADD COLUMN start_date TEXT;
ALTER TABLE mortgage_configs ADD COLUMN term_months INTEGER;
ALTER TABLE mortgage_configs ADD COLUMN pi_payment INTEGER;

-- Escrow (taxes + insurance + PMI) changes over time — every annual escrow
-- analysis can move it. Store it as effective-dated periods instead of a single
-- amount on the config, so a payment split picks the amount in force on its
-- date and past splits stay correct. Mirrors the CRDT-synced shape of
-- mortgage_configs (tombstone column, per-account index).
CREATE TABLE mortgage_escrow_periods
  (id TEXT PRIMARY KEY,
   account_id TEXT,
   effective_date TEXT,
   property_tax_monthly INTEGER,
   home_insurance_monthly INTEGER,
   pmi_monthly INTEGER,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX mortgage_escrow_periods_account_id
  ON mortgage_escrow_periods(account_id);

COMMIT;
