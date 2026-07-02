import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configurePlaid, getPlaidStatus } from './plaid';

// The electron secure-store talks to the main process over a parentPort
// bridge that does not exist under vitest; keep secrets in memory instead.
// vi.hoisted so the map is reachable from the tests to reset between them.
const { secrets } = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
}));
vi.mock('#platform/server/secure-store', () => ({
  isAvailable: async () => true,
  getSecret: async (name: string) => secrets.get(name) ?? null,
  setSecret: async (name: string, value: string) => {
    secrets.set(name, value);
  },
  removeSecret: async (name: string) => {
    secrets.delete(name);
  },
}));

let dir: string;

beforeEach(() => {
  secrets.clear();
  dir = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'plaid-config-'));
  process.env.ACTUAL_DATA_DIR = dir;
});

afterEach(() => {
  nativeFs.rmSync(dir, { recursive: true, force: true });
});

function readConfig() {
  return JSON.parse(
    nativeFs.readFileSync(path.join(dir, 'plaid.json'), 'utf8'),
  );
}

describe('configurePlaid', () => {
  it('writes clientId + env to the file and the secret to the keychain', async () => {
    await configurePlaid({ clientId: 'cid', secret: 'shh', env: 'production' });

    const config = readConfig();
    expect(config.clientId).toBe('cid');
    expect(config.env).toBe('production');
    // The secret is never written to the plain file.
    expect(config.secret).toBeUndefined();

    const status = await getPlaidStatus();
    expect(status.configured).toBe(true);
    expect(status.env).toBe('production');
    expect(status.clientId).toBe('cid');
  });

  it('keeps the stored secret when none is provided (change env alone)', async () => {
    await configurePlaid({ clientId: 'cid', secret: 'shh', env: 'sandbox' });
    await configurePlaid({ clientId: 'cid', env: 'production' });

    expect(readConfig().env).toBe('production');
    // Still fully configured because the secret was retained.
    expect((await getPlaidStatus()).configured).toBe(true);
  });

  it('requires a secret on first setup', async () => {
    await expect(
      configurePlaid({ clientId: 'cid', env: 'sandbox' }),
    ).rejects.toThrow(/secret is required/i);
    expect((await getPlaidStatus()).configured).toBe(false);
  });

  it('rejects a bad environment', async () => {
    await expect(
      configurePlaid({
        clientId: 'cid',
        secret: 'shh',
        env: 'nope' as never,
      }),
    ).rejects.toThrow(/sandbox or production/i);
  });

  it('requires a client id', async () => {
    await expect(
      configurePlaid({ clientId: '  ', secret: 'shh', env: 'sandbox' }),
    ).rejects.toThrow(/client ID is required/i);
  });
});
