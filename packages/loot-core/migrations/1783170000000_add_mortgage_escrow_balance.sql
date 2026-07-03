BEGIN TRANSACTION;

-- Current escrow balance the servicer holds, read off the mortgage statement.
-- It isn't derivable from the ledger, so it's user-entered on the escrow card
-- and fully adjustable. Nullable: configs saved before this keep working.
ALTER TABLE mortgage_configs ADD COLUMN escrow_balance INTEGER;
ALTER TABLE mortgage_configs ADD COLUMN escrow_balance_as_of TEXT;

COMMIT;
