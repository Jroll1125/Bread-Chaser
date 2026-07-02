---
category: Bugfix
authors: [AI]
---

Automatically retry Plaid requests that hit RATE_LIMIT_EXCEEDED, so a first full sync across several accounts on the same bank (which legitimately makes many /transactions/sync calls paging through 2 years of history) recovers on its own instead of leaving the last account in the queue unsynced
