import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { buildGmailQuery, setHistoryDays } from './receipts';

const FILTER_SNIPPET = 'subject:(receipt OR order OR payment';

describe('buildGmailQuery', () => {
  it('uses the rolling historyDays window when there is no watermark', () => {
    const query = buildGmailQuery(720, null);
    expect(query).toContain('newer_than:720d');
    expect(query).not.toContain('after:');
    expect(query).toContain(FILTER_SNIPPET);
  });

  it('queries forward from the watermark in incremental mode', () => {
    const since = 1_700_000_000;
    const query = buildGmailQuery(720, since);
    expect(query).toContain(`after:${since}`);
    expect(query).not.toContain('newer_than');
    expect(query).toContain(FILTER_SNIPPET);
  });

  it('always keeps the receipt sender/subject filter', () => {
    for (const query of [buildGmailQuery(45, null), buildGmailQuery(45, 123)]) {
      expect(query).toContain('from:(doordash');
      expect(query).toContain('paypal OR apple))');
    }
  });
});

describe('setHistoryDays', () => {
  let dir: string;

  beforeEach(() => {
    dir = nativeFs.mkdtempSync(path.join(os.tmpdir(), 'email-history-'));
    process.env.ACTUAL_DATA_DIR = dir;
    nativeFs.writeFileSync(
      path.join(dir, 'email-receipts.json'),
      JSON.stringify({ clientId: 'test' }),
    );
  });

  afterEach(() => {
    nativeFs.rmSync(dir, { recursive: true, force: true });
  });

  function readConfig() {
    return JSON.parse(
      nativeFs.readFileSync(path.join(dir, 'email-receipts.json'), 'utf8'),
    );
  }

  it('persists a whole-day value and leaves other keys intact', async () => {
    await setHistoryDays(365);
    const config = readConfig();
    expect(config.historyDays).toBe(365);
    expect(config.clientId).toBe('test');
  });

  it('clamps values above ~10 years and below a day', async () => {
    await setHistoryDays(9_999_999);
    expect(readConfig().historyDays).toBe(3650);
    await setHistoryDays(0);
    expect(readConfig().historyDays).toBe(1);
  });

  it('rounds fractional inputs', async () => {
    await setHistoryDays(365.7);
    expect(readConfig().historyDays).toBe(366);
  });
});
