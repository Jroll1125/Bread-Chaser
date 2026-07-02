import type * as T from './index-types';

// Same bridge shape as #platform/server/secure-store: this side sends
// oauth-loopback-request messages over process.parentPort and
// desktop-electron's main process (which owns the HTTP listener) answers
// with oauth-loopback-response.
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
    if (
      data?.type !== 'oauth-loopback-response' ||
      typeof data.id !== 'number'
    ) {
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

function bridgeRequest(op: string): Promise<unknown> {
  ensureListener();
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`oauth-loopback bridge timed out on ${op}`));
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
    getParentPort().postMessage({ type: 'oauth-loopback-request', id, op });
  });
}

export const isAvailable: T.IsAvailable = async function () {
  return true;
};

export const startLoopback: T.StartLoopback = async function () {
  const port = await bridgeRequest('start');
  if (typeof port !== 'number') {
    throw new Error('oauth-loopback start did not return a port');
  }
  return port;
};

export const pollLoopback: T.PollLoopback = async function () {
  const raw = await bridgeRequest('poll');
  if (typeof raw !== 'string') {
    return { code: null, state: null, error: null };
  }
  const parsed = JSON.parse(raw) as {
    code?: unknown;
    state?: unknown;
    error?: unknown;
  };
  return {
    code: typeof parsed.code === 'string' ? parsed.code : null,
    state: typeof parsed.state === 'string' ? parsed.state : null,
    error: typeof parsed.error === 'string' ? parsed.error : null,
  };
};

export const cancelLoopback: T.CancelLoopback = async function () {
  await bridgeRequest('cancel');
};
