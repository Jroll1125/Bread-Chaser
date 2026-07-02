export type PlaidAccount = {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  balances: {
    current: number | null;
    available: number | null;
    limit: number | null;
    iso_currency_code: string | null;
  };
};

export type PlaidItem = {
  item_id: string;
  institution: string | null;
  accounts: PlaidAccount[];
};

export type PlaidEnv = 'sandbox' | 'production';

export type PlaidStatus = {
  // secure-store (OS keychain) is present - i.e. running in the desktop app
  available: boolean;
  // client id + secret are set up
  configured: boolean;
  env: PlaidEnv | null;
  // The public Plaid client id (never the secret), for prefilling the in-app
  // setup form. Null when not set.
  clientId: string | null;
};

export type PlaidHostedLink = {
  linkToken: string;
  url: string;
};

export type PlaidLinkPoll =
  | { status: 'pending' }
  | { status: 'completed'; publicToken: string; institution: string | null };
