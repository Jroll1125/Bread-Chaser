import { createServer, type IncomingMessage, type ServerResponse } from 'http';

import type * as T from './index-types';

// One server per process; recreated on each initApp (server restart).
let server: ReturnType<typeof createServer> | null = null;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise(resolve => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  getKey: () => Promise<string | null>,
  dispatch: T.Dispatch,
): Promise<void> {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;

  if (method === 'OPTIONS') {
    json(res, 204, {});
    return;
  }
  if (path === '/health') {
    json(res, 200, { ok: true, app: 'Bread Chaser' });
    return;
  }

  // Auth: Bearer token or X-API-Key against the stored key. No stored key means
  // the feature is off (opt-in via "Generate API key" in the UI).
  const storedKey = await getKey();
  const authHeader = req.headers.authorization ?? '';
  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : ((req.headers['x-api-key'] as string | undefined) ?? '');
  if (!storedKey || provided !== storedKey) {
    json(res, 401, { error: 'Unauthorized' });
    return;
  }

  try {
    const body = method === 'GET' ? {} : await readBody(req);

    if (method === 'GET' && path === '/accounts') {
      json(res, 200, await dispatch('api/accounts-get', undefined));
      return;
    }
    if (method === 'GET' && path === '/categories') {
      json(res, 200, await dispatch('api/categories-get', { grouped: false }));
      return;
    }
    if (method === 'GET' && path === '/transactions') {
      json(
        res,
        200,
        await dispatch('api/transactions-get', {
          accountId: url.searchParams.get('accountId') ?? undefined,
          startDate: url.searchParams.get('startDate') ?? undefined,
          endDate: url.searchParams.get('endDate') ?? undefined,
        }),
      );
      return;
    }
    if (method === 'POST' && path === '/transactions/update') {
      const updates = (
        Array.isArray(body.updates) ? body.updates : [body]
      ) as Array<{ id: string; fields: Record<string, unknown> }>;
      for (const u of updates) {
        await dispatch('api/transaction-update', { id: u.id, fields: u.fields });
      }
      json(res, 200, { updated: updates.length });
      return;
    }
    if (method === 'POST' && path === '/transactions/import') {
      json(
        res,
        200,
        await dispatch('api/transactions-import', {
          accountId: body.accountId,
          transactions: body.transactions,
          isPreview: !!body.dryRun,
          opts: body.opts ?? {},
        }),
      );
      return;
    }
    if (method === 'POST' && path === '/transactions/delete') {
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]) as string[];
      for (const id of ids) {
        await dispatch('api/transaction-delete', { id });
      }
      json(res, 200, { deleted: ids.length });
      return;
    }
    if (method === 'POST' && path === '/query') {
      json(res, 200, await dispatch('query', body.query));
      return;
    }

    json(res, 404, { error: 'Not found' });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

export const startLocalApi: T.StartLocalApi = ({ port, getKey, dispatch }) => {
  if (server) {
    try {
      server.close();
    } catch {
      // ignore
    }
    server = null;
  }
  const created = createServer((req, res) => {
    void handle(req, res, getKey, dispatch);
  });
  created.on('error', () => {
    // e.g. EADDRINUSE while a prior instance finishes closing; the API is just
    // unavailable until the next restart. Never crash the server over it.
  });
  created.listen(port, '127.0.0.1');
  server = created;
};
