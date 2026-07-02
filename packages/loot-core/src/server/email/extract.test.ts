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

  // Real subjects observed in Ben's inbox, 2026-06/07.
  test('Amazon Ordered:/Shipped:/Delivered: subject formats', () => {
    expect(
      classify('auto-confirm@amazon.com', 'Ordered: "Pennzoil Platinum Full..." and 2 more items'),
    ).toBe('receipt');
    expect(
      classify('shipment-tracking@amazon.com', 'Shipped: "Pennzoil Platinum Full..." and 2 more items'),
    ).toBe('excluded');
    expect(
      classify('order-update@amazon.com', 'Delivered: "Pennzoil Platinum Full..." and 2 more items'),
    ).toBe('excluded');
    expect(
      classify('return@amazon.com', 'Advance refund issued for Fast Auto Keys New For Select GM....'),
    ).toBe('receipt');
    expect(
      classify('return@amazon.com', 'Dropoff confirmed for Fast Auto Keys New For Select GM...'),
    ).toBe('excluded');
  });

  test('recurring non-spend mail from receipt senders is excluded', () => {
    expect(
      classify('noreply@news.paypal.com', 'Confirmed: Benjamin, you’ve been invited to apply for the PayPal Cashback Mastercard®'),
    ).toBe('excluded');
    expect(
      classify('venmo@venmo.com', 'Your May 2026 transaction history'),
    ).toBe('excluded');
    expect(
      classify('noreply@service.paypal.com', 'Benjamin Yoder, your May account statement is available.'),
    ).toBe('excluded');
    expect(classify('CARFAX@no-reply.carfax.com', 'Rate this car!')).toBe(
      'excluded',
    );
    expect(
      classify('noreply@mg.iracing.com', 'Update Your iRacing Payment Method'),
    ).toBe('excluded');
    expect(
      classify('support@iracing.com', 'Feedback for iRacing Support'),
    ).toBe('excluded');
  });

  test('the real receipts still classify as receipts', () => {
    expect(
      classify('venmo@venmo.com', 'Receipt from DoorDash - $78.13'),
    ).toBe('receipt');
    expect(
      classify('noreply@mg.iracing.com', 'iRacing.com Receipt/Invoice'),
    ).toBe('receipt');
    expect(
      classify('service@1aauto.com', '1A Auto Order Confirmation 2MZF09UJMJX'),
    ).toBe('receipt');
    expect(
      classify('googleplay-noreply@google.com', 'Your Google Play Order Receipt from Jun 24, 2026'),
    ).toBe('receipt');
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
