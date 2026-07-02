import * as fs from 'fs';
import { join } from 'path';

import * as lootFs from '#platform/server/fs';
import { logger } from '#platform/server/log';

import type * as T from './index-types';

// loot-core's server runs in an Electron utilityProcess, which only exposes
// the net and systemPreferences modules - safeStorage lives in the main
// process. Encryption is bridged over process.parentPort: this side sends
// secure-store-request messages, desktop-electron's main process answers with
// secure-store-response. Only encrypt/decrypt cross the bridge; the encrypted
// store file itself is owned here.
type ParentPort = {
  on(
    event: 'message',
    listener: (ev: {
      data: {
        type?: string;
        id?: number;
        result?: unknown;
        error?: string | null;
      };
    }) => void,
  ): void;
  postMessage(msg: unknown): void;
};

function getParentPort(): ParentPort {
  return (process as unknown as { parentPort: ParentPort }).parentPort;
}

const BRIDGE_TIMEOUT_MS = 5000;
let nextRequestId = 1;
const pendingRequests = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (err: Error) => void }
>();
let listenerInstalled = false;

function ensureListener() {
  if (listenerInstalled) {
    return;
  }
  listenerInstalled = true;
  getParentPort().on('message', ({ data }) => {
    if (data?.type !== 'secure-store-response' || typeof data.id !== 'number') {
      return;
    }
    const pending = pendingRequests.get(data.id);
    if (!pending) {
      return;
    }
    pendingRequests.delete(data.id);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(data.result);
    }
  });
}

function bridgeRequest(op: string, payload?: string): Promise<unknown> {
  ensureListener();
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`secure-store bridge timed out on ${op}`));
    }, BRIDGE_TIMEOUT_MS);
    pendingRequests.set(id, {
      resolve: value => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: err => {
        clearTimeout(timeout);
        reject(err);
      },
    });
    getParentPort().postMessage({ type: 'secure-store-request', id, op, payload });
  });
}

function getStorePath(): string {
  const dataDir = lootFs.getDataDir();
  if (!dataDir) {
    throw new Error('secure-store requires the data directory to be set');
  }
  return join(dataDir, 'secure-store.json');
}

// name -> base64 of the OS-encrypted (DPAPI on Windows) secret value.
let store: Record<string, string> | null = null;

// Serializes disk writes so an older snapshot can never clobber a newer one.
let pendingSave: Promise<void> = Promise.resolve();
let writeCounter = 0;

function loadStore(): Record<string, string> {
  if (store) {
    return store;
  }

  let contents: string;
  try {
    contents = fs.readFileSync(getStorePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      logger.error('Could not read secure store, starting empty', err);
    }
    store = {};
    return store;
  }

  try {
    const parsed = JSON.parse(contents);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Secure store is not a JSON object');
    }
    store = parsed as Record<string, string>;
    return store;
  } catch (err) {
    // Don't silently discard secrets: keep the unreadable file around for
    // recovery and start empty.
    const backupPath = `${getStorePath()}.corrupt`;
    try {
      fs.writeFileSync(backupPath, contents, 'utf8');
      logger.error(
        `Could not parse secure store; backed up the corrupt file to ${backupPath} and started empty`,
        err,
      );
    } catch (backupErr) {
      logger.error(
        'Could not parse secure store, and failed to back up the corrupt file; starting empty',
        backupErr,
      );
    }
    store = {};
    return store;
  }
}

function saveStore(): Promise<void> {
  pendingSave = pendingSave.then(writeStore, writeStore);
  return pendingSave;
}

async function writeStore(): Promise<void> {
  const storePath = getStorePath();
  // Write to a unique temp file and atomically rename it into place so the
  // store is always either the old or the new complete contents.
  const tmpPath = `${storePath}.${process.pid}.${writeCounter++}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(store), 'utf8');
    await fs.promises.rename(tmpPath, storePath);
  } catch (err) {
    try {
      await fs.promises.rm(tmpPath, { force: true });
    } catch {}
    throw err;
  }
}

export const isAvailable: T.IsAvailable = async function () {
  try {
    return (await bridgeRequest('is-available')) === true;
  } catch {
    return false;
  }
};

export const getSecret: T.GetSecret = async function (name) {
  const encrypted = loadStore()[name];
  if (encrypted == null) {
    return null;
  }
  // A decryption failure (e.g. the OS user's key changed) is surfaced rather
  // than treated as "no secret" so callers can tell the user to re-connect.
  return (await bridgeRequest('decrypt', encrypted)) as string;
};

export const setSecret: T.SetSecret = async function (name, value) {
  const encrypted = (await bridgeRequest('encrypt', value)) as string;
  loadStore()[name] = encrypted;
  return saveStore();
};

export const removeSecret: T.RemoveSecret = async function (name) {
  delete loadStore()[name];
  return saveStore();
};
