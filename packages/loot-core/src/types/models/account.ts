import type { BankSyncProviders } from './bank-sync';

// User-facing account types, stored in the existing (previously unused)
// accounts.type column. Plaid pre-populates these on link (see
// plaidTypeToAccountType); the user can change them from the account menu.
export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit-card'
  | 'cash'
  | 'investment'
  | 'mortgage'
  | 'loan'
  | 'other';

export type AccountEntity = {
  id: string;
  name: string;
  offbudget: 0 | 1;
  closed: 0 | 1;
  sort_order: number;
  last_reconciled: string | null;
  tombstone: 0 | 1;
  // Null until set; one of ACCOUNT_TYPES. Purely informational today except
  // that 'mortgage' unlocks the mortgage-payment tools.
  type: AccountType | null;

  // Sync fields
  account_id: string | null;
  bank: string | null;
  bankName: string | null;
  bankId: string | null;
  mask: string | null; // end of bank account number
  official_name: string | null;
  balance_current: number | null;
  balance_available: number | null;
  balance_limit: number | null;
  account_sync_source: AccountSyncSource | null;
  last_sync: string | null;
  bank_sync_status: BankSyncStatus | null;
};

export type AccountSyncSource = BankSyncProviders;

export type BankSyncStatus =
  | 'ok'
  | 'pending'
  | 'sync-requested'
  | 'failed'
  | 'reauth-required'
  | 'attention-required'
  | 'rate-limit-exceeded'
  | 'timed-out'
  | 'account-missing';
