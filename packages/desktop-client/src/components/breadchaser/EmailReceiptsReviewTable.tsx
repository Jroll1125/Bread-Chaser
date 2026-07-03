import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Trans, useTranslation } from 'react-i18next';

import { format as formatDate, parseISO } from 'date-fns';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { listen, send } from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { integerToCurrency } from '@actual-app/core/shared/util';
import type {
  EmailMatchProposal,
  EmailReviewItem,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { Error as ErrorAlert } from '#components/alerts';
import { useCategories } from '#hooks/useCategories';
import { useDateFormat } from '#hooks/useDateFormat';
import { usePayees } from '#hooks/usePayees';
import { aqlQuery } from '#queries/aqlQuery';

type ReviewLists = {
  pending: EmailReviewItem[];
  applied: EmailReviewItem[];
};

function receiptAmount(item: EmailReviewItem): number {
  return item.receipt.direction === 'refund'
    ? Math.abs(item.receipt.amount_cents)
    : -Math.abs(item.receipt.amount_cents);
}

// Format an ISO (yyyy-mm-dd) date with the user's configured date format, so
// dates here read the same as the transaction register.
function formatReceiptDate(
  date: string | null | undefined,
  dateFormat: string,
): string {
  return date ? formatDate(parseISO(date), dateFormat) : '';
}

function bestProposal(item: EmailReviewItem): EmailMatchProposal | null {
  const open = item.proposals.filter(p => p.status === 'review');
  if (open.length === 0) {
    return null;
  }
  return open.reduce((best, p) => (p.score > best.score ? p : best));
}

// Candidates for hand-linking: anything posted within six weeks of the
// receipt, ranked by how close the amount is (exact matches first).
async function fetchLinkCandidates(
  item: EmailReviewItem,
): Promise<TransactionEntity[]> {
  const date = item.receipt.date;
  if (!date) {
    return [];
  }
  const start = new Date(date + 'T00:00:00');
  const from = new Date(start);
  from.setDate(from.getDate() - 45);
  const to = new Date(start);
  to.setDate(to.getDate() + 45);
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const { data } = await aqlQuery(
    q('transactions')
      .filter({
        is_child: false,
        date: { $gte: fmt(from), $lte: fmt(to) },
      })
      .select(['id', 'date', 'amount', 'payee', 'notes'])
      .options({ splits: 'none' }),
  );
  const target = receiptAmount(item);
  return (data as TransactionEntity[]).sort(
    (a, b) =>
      Math.abs((a.amount ?? 0) - target) - Math.abs((b.amount ?? 0) - target),
  );
}

function LinkPicker({
  item,
  busy,
  onLink,
}: {
  item: EmailReviewItem;
  busy: boolean;
  onLink: (transactionId: string) => void;
}) {
  const { t } = useTranslation();
  const { data: payees = [] } = usePayees();
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';
  const payeeName = useMemo(() => {
    const byId = new Map(payees.map(p => [p.id, p.name] as const));
    return (id: string | null | undefined) => (id ? (byId.get(id) ?? '') : '');
  }, [payees]);

  const [candidates, setCandidates] = useState<TransactionEntity[] | null>(
    null,
  );
  const [search, setSearch] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchLinkCandidates(item).then(rows => {
      if (!cancelled) {
        setCandidates(rows);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [item]);

  const needle = search.trim().toLowerCase();
  const shown = (candidates ?? [])
    .filter(
      txn =>
        !needle ||
        payeeName(txn.payee).toLowerCase().includes(needle) ||
        (txn.notes ?? '').toLowerCase().includes(needle),
    )
    .slice(0, 8);

  return (
    <View
      style={{
        gap: 6,
        padding: '8px 10px',
        backgroundColor: theme.tableRowHeaderBackground,
        borderRadius: 6,
      }}
    >
      <Input
        value={search}
        placeholder={t('Search by payee or notes…')}
        onChangeValue={setSearch}
        style={{ maxWidth: 320 }}
      />
      {candidates == null ? (
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>Loading transactions…</Trans>
        </Text>
      ) : shown.length === 0 ? (
        <Text style={{ color: theme.pageTextSubdued }}>
          <Trans>No transactions near this receipt&apos;s date.</Trans>
        </Text>
      ) : (
        shown.map(txn => (
          <View
            key={txn.id}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <Text
              style={{
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {formatReceiptDate(txn.date, dateFormat)} ·{' '}
              {payeeName(txn.payee) || (txn.notes ?? '-')} ·{' '}
              {integerToCurrency(txn.amount ?? 0)}
            </Text>
            <Button
              variant="primary"
              isDisabled={busy}
              onPress={() => onLink(txn.id)}
            >
              <Trans>Link</Trans>
            </Button>
          </View>
        ))
      )}
    </View>
  );
}

const cell: React.CSSProperties = {
  padding: '6px 10px',
  fontSize: 13,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};
const headCell: React.CSSProperties = {
  ...cell,
  textAlign: 'left',
  fontWeight: 500,
  color: theme.pageTextSubdued,
};

/**
 * The review queue as a first-class table on the Email Receipts page:
 * every extracted receipt awaiting review, its best automatic candidate,
 * and actions — including hand-linking a transaction the matcher missed.
 */
export function EmailReceiptsReviewTable() {
  const { t } = useTranslation();
  const [lists, setLists] = useState<ReviewLists | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkingFor, setLinkingFor] = useState<string | null>(null);
  const [isRebuilding, setIsRebuilding] = useState(false);
  const [rebuildMsg, setRebuildMsg] = useState<string | null>(null);
  // Per-receipt payee override for Apply/Link; defaults to the extracted
  // merchant. Lets the user retarget e.g. a Google Play receipt to onX Maps.
  const [payeeOverrides, setPayeeOverrides] = useState<Record<string, string>>(
    {},
  );
  // Per-receipt category override (category id), applied to the transaction /
  // split children on Apply. Empty string = leave uncategorized.
  const [categoryOverrides, setCategoryOverrides] = useState<
    Record<string, string>
  >({});
  // In-app receipt preview overlay: null when closed.
  const [preview, setPreview] = useState<{
    loading: boolean;
    html: string;
  } | null>(null);
  const { data: payees = [] } = usePayees();
  const { data: categoryData } = useCategories();
  const categoryGroups = categoryData?.grouped ?? [];
  const dateFormat = useDateFormat() || 'MM/dd/yyyy';

  const reload = async () => {
    try {
      setLists(await send('email-receipts-proposals'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reload();
    return listen('sync-event', event => {
      if (
        (event.type === 'applied' || event.type === 'success') &&
        event.tables?.includes('transactions')
      ) {
        void reload();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setIsBusy(true);
    setError(null);
    try {
      await fn();
      setLinkingFor(null);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsBusy(false);
  };

  // Re-render every applied receipt's PDF from the real email HTML (older
  // ones are re-fetched from Gmail). One-shot backfill; also handy anytime.
  const rebuildAttachments = async () => {
    setIsRebuilding(true);
    setError(null);
    setRebuildMsg(null);
    try {
      const res = await send('email-receipts-rebuild-attachments');
      setRebuildMsg(
        t(
          'Rebuilt {{rebuilt}} of {{total}} email PDFs ' +
            '({{refetched}} re-fetched from Gmail, {{failed}} failed).',
          res,
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsRebuilding(false);
  };

  const openPreview = async (messageId: string) => {
    setPreview({ loading: true, html: '' });
    try {
      const res = await send('email-receipts-preview', { messageId });
      setPreview({ loading: false, html: res.html });
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pending = lists?.pending ?? [];
  const applied = lists?.applied ?? [];
  const unmatched = pending.filter(item => !bestProposal(item));
  const payeeFor = (item: EmailReviewItem) =>
    payeeOverrides[item.messageId] ?? item.receipt.merchant;
  const categoryFor = (item: EmailReviewItem) =>
    categoryOverrides[item.messageId] ?? '';
  const fmtDate = (d?: string | null) => formatReceiptDate(d, dateFormat);

  // Shared styling so the payee input and category dropdown match the app's
  // form controls (and each other) instead of looking squished.
  const fieldStyle: React.CSSProperties = {
    width: '100%',
    fontSize: 13,
    padding: 5,
    borderRadius: 4,
    border: '1px solid ' + theme.formInputBorder,
    backgroundColor: theme.tableBackground,
    color: theme.formInputText,
  };

  return (
    <View style={{ gap: 18 }}>
      {error && <ErrorAlert>{error}</ErrorAlert>}

      {/* Autocomplete suggestions for the per-row payee override. */}
      <datalist id="bc-email-payee-options">
        {payees
          .filter(p => p.name && !p.transfer_acct)
          .map(p => (
            <option key={p.id} value={p.name} />
          ))}
      </datalist>

      {preview &&
        createPortal(
          <div
            onClick={() => setPreview(null)}
            style={{
              position: 'fixed',
              inset: 0,
              backgroundColor: 'rgba(0,0,0,0.5)',
              zIndex: 5000,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                backgroundColor: theme.pageBackground,
                borderRadius: 8,
                width: 'min(900px, 100%)',
                height: '90vh',
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
                boxShadow: '0 10px 40px rgba(0,0,0,0.35)',
              }}
            >
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderBottom: '1px solid ' + theme.tableBorder,
                  flexShrink: 0,
                }}
              >
                <Text style={{ fontWeight: 600 }}>
                  <Trans>Receipt preview</Trans>
                </Text>
                <Button variant="bare" onPress={() => setPreview(null)}>
                  {t('Close')}
                </Button>
              </View>
              {preview.loading ? (
                <Text style={{ padding: 20, color: theme.pageTextSubdued }}>
                  <Trans>Loading…</Trans>
                </Text>
              ) : (
                <iframe
                  title={t('Receipt preview')}
                  srcDoc={preview.html}
                  sandbox=""
                  style={{
                    flex: 1,
                    width: '100%',
                    border: 0,
                    backgroundColor: 'white',
                  }}
                />
              )}
            </div>
          </div>,
          document.body,
        )}

      <View style={{ gap: 6 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <Text style={{ fontWeight: 600, fontSize: 15 }}>
            <Trans>Needs review ({{ count: pending.length }})</Trans>
          </Text>
          {unmatched.length > 0 && (
            <Button
              isDisabled={isBusy}
              onPress={() => {
                void act(async () => {
                  for (const item of unmatched) {
                    await send('email-receipts-reject', {
                      messageId: item.messageId,
                    });
                  }
                });
              }}
            >
              <Trans>Dismiss all {{ count: unmatched.length }} unmatched</Trans>
            </Button>
          )}
        </View>

        <View
          style={{
            border: '1px solid ' + theme.tableBorder,
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <View style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                minWidth: 720,
                tableLayout: 'fixed',
                borderCollapse: 'collapse',
              }}
            >
              <colgroup>
                <col style={{ width: '20%' }} />
                <col style={{ width: '15%' }} />
                <col style={{ width: '9%' }} />
                <col style={{ width: '11%' }} />
                <col style={{ width: '21%' }} />
                <col style={{ width: '24%' }} />
              </colgroup>
              <thead>
                <tr
                  style={{ backgroundColor: theme.tableRowHeaderBackground }}
                >
                  <th style={headCell}>{t('Receipt')}</th>
                  <th style={headCell}>{t('Category')}</th>
                  <th style={{ ...headCell, textAlign: 'right' }}>
                    {t('Amount')}
                  </th>
                  <th style={headCell}>{t('Date')}</th>
                  <th style={headCell}>{t('Best match')}</th>
                  <th style={{ ...headCell, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {pending.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{ ...cell, color: theme.pageTextSubdued }}
                    >
                      <Trans>
                        Nothing to review. Receipts show up here after a sync.
                      </Trans>
                    </td>
                  </tr>
                )}
                {pending.map(item => {
                  const best = bestProposal(item);
                  const isLinking = linkingFor === item.messageId;
                  return (
                    <React.Fragment key={item.messageId}>
                      <tr
                        style={{
                          borderTop: '1px solid ' + theme.tableBorder,
                        }}
                      >
                        <td style={cell}>
                          {/* Payee field — app-standard Input (autocompletes
                              existing payees), defaults to the merchant. */}
                          <Input
                            list="bc-email-payee-options"
                            value={payeeFor(item)}
                            disabled={isBusy}
                            placeholder={item.receipt.merchant}
                            aria-label={t('Payee')}
                            onChangeValue={value =>
                              setPayeeOverrides(prev => ({
                                ...prev,
                                [item.messageId]: value,
                              }))
                            }
                            style={{ width: '100%', fontWeight: 500 }}
                          />
                          <div
                            style={{
                              marginTop: 4,
                              color: theme.pageTextSubdued,
                              fontSize: 12,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {item.subject ?? item.from ?? item.messageId}
                          </div>
                        </td>
                        {/* New Category column, between Receipt and Amount. */}
                        <td style={cell}>
                          <select
                            value={categoryFor(item)}
                            disabled={isBusy}
                            aria-label={t('Category')}
                            onChange={e =>
                              setCategoryOverrides(prev => ({
                                ...prev,
                                [item.messageId]: e.target.value,
                              }))
                            }
                            style={fieldStyle}
                          >
                            <option value="">{t('Uncategorized')}</option>
                            {categoryGroups
                              .filter(group => !group.hidden)
                              .map(group => (
                                <optgroup key={group.id} label={group.name}>
                                  {(group.categories ?? [])
                                    .filter(c => !c.hidden)
                                    .map(c => (
                                      <option key={c.id} value={c.id}>
                                        {c.name}
                                      </option>
                                    ))}
                                </optgroup>
                              ))}
                          </select>
                        </td>
                        <td
                          style={{
                            ...cell,
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {integerToCurrency(receiptAmount(item))}
                        </td>
                        <td style={cell}>{fmtDate(item.receipt.date)}</td>
                        <td
                          style={{
                            ...cell,
                            color: best
                              ? theme.pageText
                              : theme.pageTextSubdued,
                          }}
                        >
                          {best
                            ? `${fmtDate(best.transactionDate)} · ${best.transactionPayee ?? '-'} · ${integerToCurrency(best.transactionAmount)}`
                            : t('No match found yet')}
                        </td>
                        <td style={{ ...cell, textAlign: 'right' }}>
                          <View
                            style={{
                              flexDirection: 'row',
                              justifyContent: 'flex-end',
                              gap: 4,
                              flexWrap: 'wrap',
                            }}
                          >
                            {best && (
                              <>
                                <Button
                                  variant="primary"
                                  isDisabled={isBusy}
                                  onPress={() =>
                                    void act(() =>
                                      send('email-receipts-apply', {
                                        proposalId: best.id,
                                        payeeName: payeeFor(item),
                                        categoryId: categoryFor(item) || undefined,
                                      }),
                                    )
                                  }
                                >
                                  {t('Apply')}
                                </Button>
                                <Button
                                  isDisabled={isBusy}
                                  onPress={() =>
                                    void act(() =>
                                      send('email-receipts-reject', {
                                        proposalId: best.id,
                                      }),
                                    )
                                  }
                                >
                                  {t('Reject')}
                                </Button>
                              </>
                            )}
                            <Button
                              isDisabled={isBusy}
                              onPress={() =>
                                setLinkingFor(isLinking ? null : item.messageId)
                              }
                            >
                              {t('Link…')}
                            </Button>
                            {/* Preview the receipt email, alongside the other
                                row actions. */}
                            <Button
                              onPress={() => void openPreview(item.messageId)}
                            >
                              {t('Preview')}
                            </Button>
                            <Button
                              variant="bare"
                              isDisabled={isBusy}
                              onPress={() =>
                                void act(() =>
                                  send('email-receipts-reject', {
                                    messageId: item.messageId,
                                  }),
                                )
                              }
                            >
                              {t('Dismiss')}
                            </Button>
                          </View>
                        </td>
                      </tr>
                      {isLinking && (
                        <tr>
                          <td colSpan={6} style={{ padding: '0 10px 10px' }}>
                            <LinkPicker
                              item={item}
                              busy={isBusy}
                              onLink={transactionId =>
                                void act(() =>
                                  send('email-receipts-link-manual', {
                                    messageId: item.messageId,
                                    transactionId,
                                    payeeName: payeeFor(item),
                                    categoryId: categoryFor(item) || undefined,
                                  }),
                                )
                              }
                            />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </View>
        </View>
      </View>

      {applied.length > 0 && (
        <View style={{ gap: 6 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <Text style={{ fontWeight: 600, fontSize: 15 }}>
              <Trans>Applied ({{ count: applied.length }})</Trans>
            </Text>
            <ButtonWithLoading
              isLoading={isRebuilding}
              isDisabled={isBusy || isRebuilding}
              onPress={() => {
                void rebuildAttachments();
              }}
            >
              <Trans>Rebuild email PDFs</Trans>
            </ButtonWithLoading>
          </View>
          {rebuildMsg && (
            <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
              {rebuildMsg}
            </Text>
          )}
          <View
            style={{
              border: '1px solid ' + theme.tableBorder,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <View style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  minWidth: 720,
                  tableLayout: 'fixed',
                  borderCollapse: 'collapse',
                }}
              >
                <colgroup>
                  <col style={{ width: '30%' }} />
                  <col style={{ width: '10%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '25%' }} />
                </colgroup>
                <thead>
                  <tr style={{ backgroundColor: theme.tableRowHeaderBackground }}>
                    <th style={headCell}>{t('Receipt')}</th>
                    <th style={{ ...headCell, textAlign: 'right' }}>
                      {t('Amount')}
                    </th>
                    <th style={headCell}>{t('Date')}</th>
                    <th style={headCell}>{t('Applied to')}</th>
                    <th style={{ ...headCell, textAlign: 'right' }} />
                  </tr>
                </thead>
                <tbody>
                  {applied.map(item => {
                    const appliedProposal = item.proposals.find(
                      p =>
                        p.status === 'applied' || p.status === 'auto_applied',
                    );
                    if (!appliedProposal) {
                      return null;
                    }
                    return (
                      <tr
                        key={item.messageId}
                        style={{
                          borderTop: '1px solid ' + theme.tableBorder,
                        }}
                      >
                        <td style={cell}>
                          <div
                            style={{
                              fontWeight: 600,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {item.receipt.merchant}
                          </div>
                          <div
                            style={{
                              color: theme.pageTextSubdued,
                              fontSize: 12,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {item.subject ?? item.from ?? item.messageId}
                          </div>
                        </td>
                        <td
                          style={{
                            ...cell,
                            textAlign: 'right',
                            fontVariantNumeric: 'tabular-nums',
                          }}
                        >
                          {integerToCurrency(receiptAmount(item))}
                        </td>
                        <td style={cell}>{fmtDate(item.receipt.date)}</td>
                        <td style={cell}>
                          <div
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {fmtDate(appliedProposal.transactionDate)} ·{' '}
                            {appliedProposal.transactionPayee ?? '-'}
                          </div>
                          <div
                            style={{
                              color: theme.pageTextSubdued,
                              fontSize: 12,
                            }}
                          >
                            {appliedProposal.status === 'auto_applied'
                              ? t('Auto-applied')
                              : t('Applied')}
                          </div>
                        </td>
                        <td style={{ ...cell, textAlign: 'right' }}>
                          <View
                            style={{
                              flexDirection: 'row',
                              justifyContent: 'flex-end',
                            }}
                          >
                            <Button
                              isDisabled={isBusy}
                              onPress={() =>
                                void act(() =>
                                  send('email-receipts-unapply', {
                                    proposalId: appliedProposal.id,
                                  }),
                                )
                              }
                            >
                              {t('Undo')}
                            </Button>
                          </View>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}
