import type * as T from './index-types';

// The browser build has no way to host a localhost redirect listener; OAuth
// connect flows that need one are desktop-only (mirrors how secure-store is
// unavailable outside Electron).
export const isAvailable: T.IsAvailable = async function () {
  return false;
};

export const startLoopback: T.StartLoopback = async function () {
  throw new Error('OAuth loopback is only available in the desktop app');
};

export const pollLoopback: T.PollLoopback = async function () {
  throw new Error('OAuth loopback is only available in the desktop app');
};

export const cancelLoopback: T.CancelLoopback = async function () {
  throw new Error('OAuth loopback is only available in the desktop app');
};
