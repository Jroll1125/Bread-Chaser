---
category: Bugfix
authors: [AI]
---

Fix Plaid syncs silently discarding transactions older than 90 days: the provider-generic sync start date clamps to ~90 days (a GoCardless limitation), which filtered a 730-day Plaid history request down to 90 days on every sync - including asynchronously-delivered historical backfill. Plaid now uses its own 730-day window. Also prevents the bank-link modal from stacking overlapping link attempts while the initial link/sync is still running
