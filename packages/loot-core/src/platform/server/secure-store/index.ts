import type * as T from './index-types';

export const isAvailable: T.IsAvailable = async function () {
  return false;
};

export const getSecret: T.GetSecret = async function () {
  throw new Error('secure-store is only available in the desktop app');
};

export const setSecret: T.SetSecret = async function () {
  throw new Error('secure-store is only available in the desktop app');
};

export const removeSecret: T.RemoveSecret = async function () {
  throw new Error('secure-store is only available in the desktop app');
};
