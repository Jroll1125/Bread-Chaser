import { classify, validateExtraction } from './extract';

describe('email classify', () => {
  test('excludes brokerage trade confirmations despite "order" wording', () => {
    expect(
      classify('Robinhood <notifications@robinhood.com>', 'Your order has been executed'),
    ).toBe('excluded');
    expect(
      classify('Edward Jones <no-reply@edwardjones.com>', 'Trade confirmation'),
    ).toBe('excluded');
  });

  test('excludes promos and marketing blasts', () => {
    expect(classify('APMEX <deals@apmex.com>', 'Flash Sale ends tonight')).toBe(
      'excluded',
    );
    expect(classify('Some Store <news@store.com>', '25% off everything')).toBe(
      'excluded',
    );
  });

  test('excludes ship/deliver notices', () => {
    expect(
      classify('1A Auto <support@1aauto.com>', 'Your order has shipped'),
    ).toBe('excluded');
    expect(
      classify('1A Auto <support@1aauto.com>', 'Your package was delivered'),
    ).toBe('excluded');
  });

  test('classifies real receipts', () => {
    expect(
      classify('DoorDash <no-reply@doordash.com>', 'Order Confirmation for Ben'),
    ).toBe('receipt');
    expect(
      classify('Google Play <googleplay-noreply@google.com>', 'Your Google Play Order Receipt'),
    ).toBe('receipt');
    expect(classify('Venmo <venmo@venmo.com>', 'You paid Papa Roux')).toBe(
      'receipt',
    );
  });

  test('unknown mail is other (never reaches the model)', () => {
    expect(
      classify('Some Newsletter <hello@substack.com>', 'This week in racing'),
    ).toBe('other');
  });

  test('config deny list beats the built-in receipt patterns', () => {
    expect(
      classify('DoorDash <no-reply@doordash.com>', 'Order Confirmation', {
        deny: ['doordash.com'],
      }),
    ).toBe('excluded');
  });

  test('config allow list promotes unknown senders', () => {
    expect(
      classify('Tiny Shop <orders@tinyshop.io>', 'Thanks!', {
        allow: ['tinyshop.io'],
      }),
    ).toBe('receipt');
  });
});

describe('extraction quarantine', () => {
  const valid = {
    is_receipt: true,
    direction: 'purchase',
    merchant: 'Google Play',
    amount_cents: 2799,
    currency: 'USD',
    date: '2025-06-10',
    order_id: 'GPA.123',
    line_items: [
      { description: 'App One', amount_cents: 999 },
      { description: 'App Two', amount_cents: 1800 },
    ],
    category_hint: null,
  };

  test('valid extraction passes', () => {
    const result = validateExtraction(JSON.stringify(valid));
    expect(result.status).toBe('ok');
    expect(result.receipt?.merchant).toBe('Google Play');
    expect(result.receipt?.line_items).toHaveLength(2);
  });

  test('non-JSON model output is quarantined', () => {
    expect(validateExtraction('Sure! Here is the receipt: ...').status).toBe(
      'quarantined',
    );
  });

  test('schema-invalid output is quarantined', () => {
    expect(
      validateExtraction(
        JSON.stringify({ ...valid, amount_cents: 'twenty dollars' }),
      ).status,
    ).toBe('quarantined');
  });

  test('is_receipt=false creates nothing', () => {
    const result = validateExtraction(
      JSON.stringify({ is_receipt: false }),
    );
    expect(result.status).toBe('not_receipt');
    expect(result.receipt).toBeNull();
  });

  test('is_receipt=true with missing core fields is quarantined', () => {
    expect(
      validateExtraction(JSON.stringify({ ...valid, merchant: '' })).status,
    ).toBe('quarantined');
    expect(
      validateExtraction(JSON.stringify({ ...valid, amount_cents: 0 })).status,
    ).toBe('quarantined');
    expect(
      validateExtraction(JSON.stringify({ ...valid, date: '' })).status,
    ).toBe('quarantined');
  });

  test('malformed dates are quarantined', () => {
    expect(
      validateExtraction(JSON.stringify({ ...valid, date: 'June 10, 2025' }))
        .status,
    ).toBe('quarantined');
  });
});
