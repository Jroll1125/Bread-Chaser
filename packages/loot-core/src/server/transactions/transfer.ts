// @ts-strict-ignore
import * as db from '#server/db';

import { runRules } from './transaction-rules';

async function getPayee(acct) {
  return db.first<db.DbPayee>('SELECT * FROM payees WHERE transfer_acct = ?', [
    acct,
  ]);
}

async function getTransferredAccount(transaction) {
  if (transaction.payee) {
    const result = await db.first<Pick<db.DbViewPayee, 'transfer_acct'>>(
      'SELECT transfer_acct FROM v_payees WHERE id = ?',
      [transaction.payee],
    );

    return result?.transfer_acct || null;
  }
  return null;
}

async function clearCategory(transaction, transferAcct) {
  const { offbudget: fromOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transaction.account]);
  const { offbudget: toOffBudget } = await db.first<
    Pick<db.DbAccount, 'offbudget'>
  >('SELECT offbudget FROM accounts WHERE id = ?', [transferAcct]);

  // If the transfer is between two on budget or two off budget accounts,
  // we should clear the category, because the category is not relevant
  if (fromOffBudget === toOffBudget) {
    await db.updateTransaction({ id: transaction.id, category: null });
    if (transaction.transfer_id) {
      await db.updateTransaction({
        id: transaction.transfer_id,
        category: null,
      });
    }
    return true;
  }
  return false;
}

// Transfer dates arrive as 'yyyy-mm-dd' strings from the client or as raw
// yyyymmdd integers from re-fetched rows; the counterpart window needs the
// integer form either way.
function transferDateInt(date) {
  return typeof date === 'number'
    ? date
    : parseInt(String(date).replace(/-/g, ''), 10);
}

function shiftDateInt(dateInt, days) {
  const y = Math.floor(dateInt / 10000);
  const m = Math.floor((dateInt % 10000) / 100) - 1;
  const d = dateInt % 100;
  const shifted = new Date(y, m, d + days);
  return (
    shifted.getFullYear() * 10000 +
    (shifted.getMonth() + 1) * 100 +
    shifted.getDate()
  );
}

const COUNTERPART_WINDOW_DAYS = 4;

// When both legs of a transfer were imported from their banks, the target
// account already holds the other side. A plain, unlinked transaction there
// with the exact opposite amount within a few days is that counterpart —
// link to it instead of minting a duplicate mirror.
async function findTransferCounterpart(transaction, transferredAccount) {
  if (!transaction.amount || transaction.date == null) {
    return null;
  }
  const center = transferDateInt(transaction.date);
  return db.first<{ id: string }>(
    `SELECT id FROM transactions
      WHERE acct = ? AND tombstone = 0
        AND isParent = 0 AND isChild = 0
        AND amount = ?
        AND transferred_id IS NULL
        AND (starting_balance_flag IS NULL OR starting_balance_flag = 0)
        AND date >= ? AND date <= ?
      ORDER BY ABS(date - ?) LIMIT 1`,
    [
      transferredAccount,
      -transaction.amount,
      shiftDateInt(center, -COUNTERPART_WINDOW_DAYS),
      shiftDateInt(center, COUNTERPART_WINDOW_DAYS),
      center,
    ],
  );
}

export async function addTransfer(transaction, transferredAccount) {
  if (transaction.is_parent) {
    // For split transactions, we should create transfers using child transactions.
    // This is to ensure that the amounts received by the transferred account
    // reflects the amounts in the child transactions and not the parent transaction
    // amount which is the total amount.
    return null;
  }

  const { id: fromPayee } = await db.first<Pick<db.DbPayee, 'id'>>(
    'SELECT id FROM payees WHERE transfer_acct = ?',
    [transaction.account],
  );

  const counterpart = await findTransferCounterpart(
    transaction,
    transferredAccount,
  );
  if (counterpart) {
    await db.updateTransaction({
      id: counterpart.id,
      payee: fromPayee,
      transfer_id: transaction.id,
    });
    await db.updateTransaction({
      id: transaction.id,
      transfer_id: counterpart.id,
    });
    const categoryCleared = await clearCategory(
      { ...transaction, transfer_id: counterpart.id },
      transferredAccount,
    );
    return {
      id: transaction.id,
      transfer_id: counterpart.id,
      ...(categoryCleared ? { category: null } : {}),
    };
  }

  const transferTransaction = {
    account: transferredAccount,
    amount: -transaction.amount,
    payee: fromPayee,
    date: transaction.date,
    transfer_id: transaction.id,
    notes: transaction.notes || null,
    schedule: transaction.schedule,
    cleared: false,
  };
  const { notes, cleared, schedule } = await runRules(transferTransaction);
  const matchedSchedule = schedule ?? transaction.schedule;

  const id = await db.insertTransaction({
    ...transferTransaction,
    notes,
    cleared,
    schedule: matchedSchedule,
  });

  await db.updateTransaction({
    id: transaction.id,
    transfer_id: id,
    ...(matchedSchedule ? { schedule: matchedSchedule } : {}),
  });
  const categoryCleared = await clearCategory(transaction, transferredAccount);

  return {
    id: transaction.id,
    transfer_id: id,
    ...(categoryCleared ? { category: null } : {}),
  };
}

export async function removeTransfer(transaction) {
  const transferTrans = await db.getTransaction(transaction.transfer_id);

  // Perform operations on the transfer transaction only
  // if it is found. For example: when users delete both
  // (in & out) transfer transactions at the same time -
  // transfer transaction will not be found.
  if (transferTrans) {
    if (transferTrans.is_child || transferTrans.imported_id) {
      // A child transaction can't be deleted without invalidating its whole
      // split, and an adopted bank-imported counterpart is a real ledger row
      // (deleting it would break the account against the bank, and a later
      // sync would just re-import it). Turn either back into a normal
      // transaction instead.
      await db.updateTransaction({
        id: transaction.transfer_id,
        transfer_id: null,
        payee: null,
      });
    } else {
      await db.deleteTransaction({ id: transaction.transfer_id });
    }
  }
  await db.updateTransaction({ id: transaction.id, transfer_id: null });
  return { id: transaction.id, transfer_id: null };
}

export async function updateTransfer(transaction, transferredAccount) {
  const payee = await getPayee(transaction.account);

  await db.updateTransaction({
    id: transaction.transfer_id,
    account: transferredAccount,
    // Make sure to update the payee on the other side in case the
    // user moved this transaction into another account
    payee: payee.id,
    notes: transaction.notes,
    amount: -transaction.amount,
    schedule: transaction.schedule,
  });

  const categoryCleared = await clearCategory(transaction, transferredAccount);
  if (categoryCleared) {
    return { id: transaction.id, category: null };
  }
}

export async function onInsert(transaction) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transferredAccount) {
    return addTransfer(transaction, transferredAccount);
  }
}

export async function onDelete(transaction) {
  if (transaction.transfer_id) {
    await removeTransfer(transaction);
  }
}

export async function onUpdate(transaction) {
  const transferredAccount = await getTransferredAccount(transaction);

  if (transaction.is_parent) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && !transaction.transfer_id) {
    return addTransfer(transaction, transferredAccount);
  }

  if (!transferredAccount && transaction.transfer_id) {
    return removeTransfer(transaction);
  }

  if (transferredAccount && transaction.transfer_id) {
    return updateTransfer(transaction, transferredAccount);
  }
}
