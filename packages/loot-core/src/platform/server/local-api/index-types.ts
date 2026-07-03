export type Dispatch = (name: string, args: unknown) => Promise<unknown>;

export type StartLocalApiOptions = {
  port: number;
  getKey: () => Promise<string | null>;
  dispatch: Dispatch;
};

// Starts a localhost HTTP API in front of the loaded budget. A no-op on every
// platform except electron.
export declare function startLocalApi(options: StartLocalApiOptions): void;
export type StartLocalApi = typeof startLocalApi;
