import { useSyncExternalStore } from 'react';

import { listen, send } from '@actual-app/core/platform/client/connection';

// A tiny shared store of "which transactions have attachments", so every
// visible row can cheaply membership-check without its own query. Refreshed
// on demand (after modal actions) and whenever a sync touches the
// transaction_attachments table (email auto-attach, other devices).

let attachedIds: Set<string> = new Set();
let isStarted = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach(listener => listener());
}

export async function refreshAttachedTransactionIds(): Promise<void> {
  try {
    const ids = await send('attachments-for-account', {});
    attachedIds = new Set(ids);
    emit();
  } catch {
    // The budget may not be loaded yet; a later refresh will succeed.
  }
}

function ensureStarted() {
  if (isStarted) {
    return;
  }
  isStarted = true;
  listen('sync-event', event => {
    if (
      (event.type === 'applied' || event.type === 'success') &&
      event.tables?.includes('transaction_attachments')
    ) {
      void refreshAttachedTransactionIds();
    }
  });
  void refreshAttachedTransactionIds();
}

function subscribe(callback: () => void) {
  ensureStarted();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot() {
  return attachedIds;
}

export function useAttachedTransactionIds(): Set<string> {
  return useSyncExternalStore(subscribe, getSnapshot);
}
