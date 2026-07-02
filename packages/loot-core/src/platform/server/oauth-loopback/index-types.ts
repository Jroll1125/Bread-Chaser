/**
 * A localhost HTTP listener for OAuth authorization-code redirects
 * (`http://127.0.0.1:<port>`). The listener itself lives in the Electron main
 * process - the loot-core server (a utilityProcess) can't reliably own
 * long-lived sockets across restarts - and is driven from here over the same
 * parentPort bridge the secure store uses.
 */

export type LoopbackPoll = {
  code: string | null;
  state: string | null;
  error: string | null;
};

/** Whether a loopback listener can be started on this platform. */
export type IsAvailable = () => Promise<boolean>;

/**
 * Start (or restart) the listener and return the port it is bound to. The
 * caller builds the provider's auth URL with
 * `redirect_uri=http://127.0.0.1:<port>`.
 */
export type StartLoopback = () => Promise<number>;

/**
 * Report what the listener has captured so far: `code` once the provider
 * redirected with ?code=..., `error` if it redirected with ?error=... Both
 * null while still waiting.
 */
export type PollLoopback = () => Promise<LoopbackPoll>;

/** Stop the listener without capturing anything. */
export type CancelLoopback = () => Promise<void>;
