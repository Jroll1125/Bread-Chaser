-- Quicken-style paycheck templates: named line items for earnings, pre-tax
-- deductions, taxes, and after-tax deductions (all JSON arrays of
-- {name, category, amount}), plus secondary deposit accounts
-- ({accountId, amount}) — the remainder of net pay lands in the primary
-- account as the split parent. qualified_ot tracks the non-taxable
-- "Qualified OT" figure informationally.
CREATE TABLE paycheck_configs (
  id TEXT PRIMARY KEY,
  name TEXT,
  payee_id TEXT,
  account_id TEXT,
  schedule_id TEXT,
  earnings_json TEXT,
  pretax_json TEXT,
  taxes_json TEXT,
  aftertax_json TEXT,
  deposits_json TEXT,
  qualified_ot INTEGER DEFAULT 0,
  tombstone INTEGER DEFAULT 0
);
