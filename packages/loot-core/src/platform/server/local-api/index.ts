import type * as T from './index-types';

// Non-electron platforms don't host the local API server.
export const startLocalApi: T.StartLocalApi = () => {};
