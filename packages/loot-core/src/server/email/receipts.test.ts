import { buildGmailQuery } from './receipts';

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
