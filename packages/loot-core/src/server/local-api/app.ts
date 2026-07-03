import { v4 as uuidv4 } from 'uuid';

import * as secureStore from '#platform/server/secure-store';
import { createApp } from '#server/app';

// A localhost-only HTTP API for programmatic bulk edits (the Lunch-Money-style
// "mass change transactions" workflow). Off until the user generates a key —
// with no key stored, the server 401s everything. The key lives in the OS
// keychain via secure-store, same as the Plaid/Gmail secrets.

export const LOCAL_API_PORT = 5008;
const KEY_NAME = 'local-api-key';

export async function getApiKey(): Promise<string | null> {
  try {
    return await secureStore.getSecret(KEY_NAME);
  } catch {
    return null;
  }
}

async function localApiStatus(): Promise<{
  port: number;
  url: string;
  hasKey: boolean;
}> {
  const key = await getApiKey();
  return {
    port: LOCAL_API_PORT,
    url: `http://localhost:${LOCAL_API_PORT}`,
    hasKey: !!key,
  };
}

async function localApiGenerateKey(): Promise<{ key: string }> {
  // 256 bits of key from two UUIDs — no node crypto so it also builds for the
  // browser bundle (where this handler is inert but still compiled).
  const key = (uuidv4() + uuidv4()).replace(/-/g, '');
  await secureStore.setSecret(KEY_NAME, key);
  return { key };
}

async function localApiGetKey(): Promise<{ key: string | null }> {
  return { key: await getApiKey() };
}

async function localApiRevokeKey(): Promise<'ok'> {
  await secureStore.removeSecret(KEY_NAME);
  return 'ok';
}

export type LocalApiHandlers = {
  'local-api-status': typeof localApiStatus;
  'local-api-generate-key': typeof localApiGenerateKey;
  'local-api-get-key': typeof localApiGetKey;
  'local-api-revoke-key': typeof localApiRevokeKey;
};

export const app = createApp<LocalApiHandlers>();
app.method('local-api-status', localApiStatus);
app.method('local-api-generate-key', localApiGenerateKey);
app.method('local-api-get-key', localApiGetKey);
app.method('local-api-revoke-key', localApiRevokeKey);
