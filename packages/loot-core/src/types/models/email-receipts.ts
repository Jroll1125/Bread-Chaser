export type EmailReceiptsStatus = {
  // secure-store (OS keychain) is present - i.e. running in the desktop app
  available: boolean;
  // Google OAuth client id + secret are set up
  configured: boolean;
  // a Gmail refresh token is stored and usable
  connected: boolean;
  // the refresh token lapsed (Google "Testing" apps expire them every ~7
  // days) - the card shows a Reconnect state instead of Connect
  needsReconnect: boolean;
  email: string | null;
  llm: {
    endpoint: string;
    model: string;
    connected: boolean;
  };
  pendingReview: number;
  lastSync: string | null;
};

export type EmailReceiptLineItem = {
  description: string;
  amount_cents: number;
};

/**
 * What the local model extracts from one receipt email. Kept field-for-field
 * compatible with the companion service's schema so its quarantine semantics
 * carry over: an extraction is only usable when is_receipt is true AND
 * merchant, amount_cents, and date are all present.
 */
export type ReceiptExtraction = {
  is_receipt: boolean;
  direction: 'purchase' | 'refund';
  merchant: string;
  /** Order TOTAL in integer cents, always positive; direction carries sign. */
  amount_cents: number;
  currency: string;
  /** YYYY-MM-DD */
  date: string;
  order_id: string | null;
  line_items: EmailReceiptLineItem[];
  category_hint: string | null;
};

export type EmailProposalStatus =
  | 'review'
  | 'auto_applied'
  | 'applied'
  | 'rejected';

/**
 * One receipt<->ledger-transaction pairing. Unmatched receipts (zero
 * candidates) appear in the review queue as EmailReviewItem entries with no
 * proposal attached.
 */
export type EmailMatchProposal = {
  id: number;
  messageId: string;
  transactionId: string;
  score: number;
  merchantScore: number;
  dateGapDays: number;
  status: EmailProposalStatus;
  appliedSplit: boolean;
  appliedAt: string | null;
  // Denormalized for display in the review modal
  transactionDate: string;
  transactionAmount: number;
  transactionPayee: string | null;
};

export type EmailReviewItem = {
  messageId: string;
  from: string | null;
  subject: string | null;
  emailDate: string | null;
  receipt: ReceiptExtraction;
  proposals: EmailMatchProposal[];
};

export type EmailReceiptsSyncResult = {
  scanned: number;
  classifiedOut: number;
  extracted: number;
  quarantined: number;
  autoApplied: number;
  queuedForReview: number;
  unmatched: number;
  // The local model endpoint was unreachable; extraction is retried on the
  // next sync and nothing was sent off-machine.
  llmUnavailable: boolean;
};

export type EmailReceiptsConnectStart = {
  url: string;
};

export type EmailReceiptsConnectPoll =
  | { status: 'pending' }
  | { status: 'completed'; email: string }
  | { status: 'error'; message: string };
