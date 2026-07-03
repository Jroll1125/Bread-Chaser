import React, { useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Input } from '@actual-app/components/input';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import {
  listen,
  send,
} from '@actual-app/core/platform/client/connection';
import { q } from '@actual-app/core/shared/query';
import { integerToCurrency } from '@actual-app/core/shared/util';
import type {
  EmailMatchProposal,
  EmailReviewItem,
  TransactionEntity,
} from '@actual-app/core/types/models';

import { Error as ErrorAlert } from '#components/alerts';
import { FinancialText } from '#components/FinancialText';
import {
  ColumnWidthsProvider,
  ResizableCol,
} from '#components/table/columnResize';
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

function bestProposal(item: EmailReviewItem): EmailMatchProposal | null {
  const open = item.proposals.filter(p => p.status === 'review');
  if (open.length === 0) {
    return null;
  }
  return open.reduce((best, p) => (p.score > best.score ? p : best));
}

// Candidates for hand-linking: anything posted within six weeks of the
// receipt; ranked by how close the amount is, exact matches first.
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
          <Trans>No transactions near this receipt's date.</Trans>
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
            <View
              style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}
            >
              <Text style={{ color: theme.pageTextSubdued }}>{txn.date}</Text>
              <Text style={{ color: theme.pageText }}>
                {payeeName(txn.payee) || (txn.notes ?? '-')}
              </Text>
              <FinancialText style={{ color: theme.pageText }}>
                {integerToCurrency(txn.amount ?? 0)}
              </FinancialText>
            </View>
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

  const pending = lists?.pending ?? [];
  const applied = lists?.applied ?? [];

  const headerText = {
    fontSize: 12,
    color: theme.pageTextSubdued,
  } as const;

  return (
    <View style={{ gap: 18 }}>
      {error && <ErrorAlert>{error}</ErrorAlert>}

      <ColumnWidthsProvider tableId="email-review">
        <View style={{ gap: 6 }}>
          <Text style={{ fontWeight: 600, fontSize: 15 }}>
            <Trans>Needs review ({{ count: pending.length }})</Trans>
          </Text>
          <View
            style={{
              border: '1px solid ' + theme.tableBorder,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                padding: '6px 12px',
                backgroundColor: theme.tableRowHeaderBackground,
              }}
            >
              <ResizableCol col="receipt" flex={2.2} grip>
                <Text style={headerText}>
                  <Trans>Receipt</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="amount" flex={0.9} grip>
                <Text style={{ ...headerText, textAlign: 'right' }}>
                  <Trans>Amount</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="date" flex={0.9} grip>
                <Text style={headerText}>
                  <Trans>Date</Trans>
                </Text>
              </ResizableCol>
              <ResizableCol col="candidate" flex={2.2} grip>
                <Text style={headerText}>
                  <Trans>Best match</Trans>
                </Text>
              </ResizableCol>
              <View style={{ width: 250 }} />
            </View>

            {pending.length === 0 && (
              <View style={{ padding: 12 }}>
                <Text style={{ color: theme.pageTextSubdued }}>
                  <Trans>
                    Nothing to review. Receipts show up here after a sync.
                  </Trans>
                </Text>
              </View>
            )}

            {pending.map(item => {
              const best = bestProposal(item);
              return (
                <View
                  key={item.messageId}
                  style={{ borderTop: '1px solid ' + theme.tableBorder }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      padding: '6px 12px',
                    }}
                  >
                    <ResizableCol col="receipt" flex={2.2}>
                      <Text style={{ fontWeight: 600 }}>
                        {item.receipt.merchant}
                      </Text>
                      <Text
                        style={{
                          color: theme.pageTextSubdued,
                          fontSize: 12,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {item.subject ?? item.from ?? item.messageId}
                      </Text>
                    </ResizableCol>
                    <ResizableCol col="amount" flex={0.9}>
                      <FinancialText style={{ textAlign: 'right' }}>
                        {integerToCurrency(receiptAmount(item))}
                      </FinancialText>
                    </ResizableCol>
                    <ResizableCol col="date" flex={0.9}>
                      <Text>{item.receipt.date}</Text>
                    </ResizableCol>
                    <ResizableCol col="candidate" flex={2.2}>
                      {best ? (
                        <Text
                          style={{
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {best.transactionDate} ·{' '}
                          {best.transactionPayee ?? '-'} ·{' '}
                          {integerToCurrency(best.transactionAmount)}
                        </Text>
                      ) : (
                        <Text style={{ color: theme.pageTextSubdued }}>
                          <Trans>No match found yet</Trans>
                        </Text>
                      )}
                    </ResizableCol>
                    <View
                      style={{
                        width: 250,
                        flexDirection: 'row',
                        justifyContent: 'flex-end',
                        gap: 5,
                      }}
                    >
                      {best && (
                        <>
                          <Button
                            variant="primary"
                            isDisabled={isBusy}
                            onPress={() => {
                              void act(() =>
                                send('email-receipts-apply', {
                                  proposalId: best.id,
                                }),
                              );
                            }}
                          >
                            <Trans>Apply</Trans>
                          </Button>
                          <Button
                            isDisabled={isBusy}
                            onPress={() => {
                              void act(() =>
                                send('email-receipts-reject', {
                                  proposalId: best.id,
                                }),
                              );
                            }}
                          >
                            <Trans>Reject</Trans>
                          </Button>
                        </>
                      )}
                      <Button
                        isDisabled={isBusy}
                        onPress={() =>
                          setLinkingFor(
                            linkingFor === item.messageId
                              ? null
                              : item.messageId,
                          )
                        }
                      >
                        <Trans>Link…</Trans>
                      </Button>
                      <Button
                        variant="bare"
                        isDisabled={isBusy}
                        onPress={() => {
                          void act(() =>
                            send('email-receipts-reject', {
                              messageId: item.messageId,
                            }),
                          );
                        }}
                      >
                        <Trans>Dismiss</Trans>
                      </Button>
                    </View>
                  </View>
                  {linkingFor === item.messageId && (
                    <View style={{ padding: '0 12px 10px' }}>
                      <LinkPicker
                        item={item}
                        busy={isBusy}
                        onLink={transactionId => {
                          void act(() =>
                            send('email-receipts-link-manual', {
                              messageId: item.messageId,
                              transactionId,
                            }),
                          );
                        }}
                      />
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        </View>
      </ColumnWidthsProvider>

      {applied.length > 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ fontWeight: 600, fontSize: 15 }}>
            <Trans>Applied ({{ count: applied.length }})</Trans>
          </Text>
          <View
            style={{
              border: '1px solid ' + theme.tableBorder,
              borderRadius: 8,
              overflow: 'hidden',
            }}
          >
            {applied.map((item, idx) => {
              const appliedProposal = item.proposals.find(
                p => p.status === 'applied' || p.status === 'auto_applied',
              );
              if (!appliedProposal) {
                return null;
              }
              return (
                <View
                  key={item.messageId}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    padding: '6px 12px',
                    borderTop: idx > 0 ? '1px solid ' + theme.tableBorder : 0,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      gap: 10,
                      alignItems: 'baseline',
                    }}
                  >
                    <Text style={{ fontWeight: 600 }}>
                      {item.receipt.merchant}
                    </Text>
                    <FinancialText>
                      {integerToCurrency(receiptAmount(item))}
                    </FinancialText>
                    <Text
                      style={{ color: theme.pageTextSubdued, fontSize: 12 }}
                    >
                      {appliedProposal.transactionDate}
                      {' · '}
                      {appliedProposal.transactionPayee ?? '-'}
                      {' · '}
                      {appliedProposal.status === 'auto_applied'
                        ? t('Auto-applied')
                        : t('Applied')}
                    </Text>
                  </View>
                  <Button
                    isDisabled={isBusy}
                    onPress={() => {
                      void act(() =>
                        send('email-receipts-unapply', {
                          proposalId: appliedProposal.id,
                        }),
                      );
                    }}
                  >
                    <Trans>Undo</Trans>
                  </Button>
                </View>
              );
            })}
          </View>
        </View>
      )}
    </View>
  );
}
