BEGIN TRANSACTION;

CREATE TABLE mortgage_configs
  (id TEXT PRIMARY KEY,
   account_id TEXT,
   annual_interest_rate REAL,
   property_tax_monthly INTEGER,
   home_insurance_monthly INTEGER,
   pmi_monthly INTEGER,
   interest_category TEXT,
   property_tax_category TEXT,
   home_insurance_category TEXT,
   pmi_category TEXT,
   tombstone INTEGER DEFAULT 0);

CREATE INDEX mortgage_configs_account_id
  ON mortgage_configs(account_id);

COMMIT;
