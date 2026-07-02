---
category: Bugfix
authors: [AI]
---

Fix Plaid syncing multiple accounts on the same institution to blow through Plaid's per-Item rate limit: /accounts/get and the historical-backfill readiness check are now cached/shared per item instead of repeated once per account. Also extends the readiness wait from 90s to 5 minutes so a 2-year history request has time to actually finish backfilling before syncing proceeds
