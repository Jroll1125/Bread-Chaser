-- Lunch Money-style category behavior flags.
-- exclude_from_budget: the category is not budgeted — no budget cells, no
--   month totals contribution, hidden from the budget table (still usable on
--   transactions and visible in reports).
-- exclude_from_totals: the category's activity is omitted from report totals
--   and budget group/overall totals (its own numbers still display).
ALTER TABLE categories ADD COLUMN exclude_from_budget INTEGER DEFAULT 0;
ALTER TABLE categories ADD COLUMN exclude_from_totals INTEGER DEFAULT 0;
