import type * as T from './index-types';

// Same bridge shape as #platform/server/oauth-loopback: this side sends
// html-to-pdf-request messages over process.parentPort and desktop-electron's
// main process (which can spin up a hidden BrowserWindow and printToPDF)
// answers with html-to-pdf-response carrying the PDF as base64.
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

// Rendering loads a document in a hidden window; give slow emails room.
const BRIDGE_TIMEOUT_MS = 30_000;
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
    if (data?.type !== 'html-to-pdf-response' || typeof data.id !== 'number') {
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

function bridgeRequest(html: string): Promise<unknown> {
  ensureListener();
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('html-to-pdf bridge timed out'));
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
    getParentPort().postMessage({ type: 'html-to-pdf-request', id, html });
  });
}

export const renderHtmlToPdf: T.RenderHtmlToPdf = async function (html) {
  const result = await bridgeRequest(html);
  if (typeof result !== 'string' || result.length === 0) {
    return null;
  }
  return Buffer.from(result, 'base64');
};
