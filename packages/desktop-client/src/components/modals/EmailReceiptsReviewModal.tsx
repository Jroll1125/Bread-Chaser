import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button } from '@actual-app/components/button';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';
import { integerToCurrency } from '@actual-app/core/shared/util';
import type {
  EmailMatchProposal,
  EmailReviewItem,
} from '@actual-app/core/types/models';

import { Error as ErrorAlert } from '#components/alerts';
import {
  Modal,
  ModalCloseButton,
  ModalHeader,
} from '#components/common/Modal';
import { FinancialText } from '#components/FinancialText';
import type { Modal as ModalType } from '#modals/modalsSlice';

type EmailReceiptsReviewModalProps = Extract<
  ModalType,
  { name: 'email-receipts-review' }
>['options'];

type ReviewLists = {
  pending: EmailReviewItem[];
  applied: EmailReviewItem[];
};

function receiptAmount(item: EmailReviewItem): number {
  return item.receipt.direction === 'refund'
    ? Math.abs(item.receipt.amount_cents)
    : -Math.abs(item.receipt.amount_cents);
}

function ReceiptSummary({ item }: { item: EmailReviewItem }) {
  const { t } = useTranslation();

  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}>
        <Text style={{ fontWeight: 600, color: theme.pageText }}>
          {item.receipt.merchant}
        </Text>
        <FinancialText style={{ color: theme.pageText }}>
          {integerToCurrency(receiptAmount(item))}
        </FinancialText>
        <Text style={{ color: theme.pageTextSubdued }}>
          {item.receipt.date}
        </Text>
      </View>
      <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
        {item.subject ?? item.from ?? item.messageId}
        {item.receipt.order_id ? ` • #${item.receipt.order_id}` : ''}
      </Text>
      {item.receipt.line_items.length >= 2 && (
        <Text style={{ color: theme.pageTextSubdued, fontSize: 12 }}>
          {t('Applies as a split with {{count}} item(s).', {
            count: item.receipt.line_items.length,
          })}
        </Text>
      )}
    </View>
  );
}

function ProposalLine({
  proposal,
  busy,
  onApply,
  onReject,
}: {
  proposal: EmailMatchProposal;
  busy: boolean;
  onApply: () => void;
  onReject: () => void;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        paddingLeft: 10,
      }}
    >
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'baseline' }}>
        <Text style={{ color: theme.pageTextSubdued }}>
          {proposal.transactionDate}
        </Text>
        <Text style={{ color: theme.pageText }}>
          {proposal.transactionPayee ?? '-'}
        </Text>
        <FinancialText style={{ color: theme.pageText }}>
          {integerToCurrency(proposal.transactionAmount)}
        </FinancialText>
      </View>
      <View style={{ flexDirection: 'row', gap: 5, flexShrink: 0 }}>
        <Button variant="primary" isDisabled={busy} onPress={onApply}>
          <Trans>Apply</Trans>
        </Button>
        <Button isDisabled={busy} onPress={onReject}>
          <Trans>Reject</Trans>
        </Button>
      </View>
    </View>
  );
}

export const EmailReceiptsReviewModal = ({
  onChange,
}: EmailReceiptsReviewModalProps) => {
  const { t } = useTranslation();
  const [lists, setLists] = useState<ReviewLists | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    try {
      setLists(await send('email-receipts-proposals'));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const act = async (fn: () => Promise<unknown>) => {
    setIsBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsBusy(false);
  };

  const pending = lists?.pending ?? [];
  const applied = lists?.applied ?? [];

  return (
    <Modal
      name="email-receipts-review"
      containerProps={{ style: { width: 600 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Review email receipts')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ gap: 15, maxHeight: '60vh', overflowY: 'auto' }}>
            {error && <ErrorAlert>{error}</ErrorAlert>}

            {lists && pending.length === 0 && applied.length === 0 && (
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>
                  Nothing to review. Receipts show up here after a sync.
                </Trans>
              </Text>
            )}

            {pending.length > 0 && (
              <View style={{ gap: 10 }}>
                <Text style={{ fontWeight: 600, color: theme.pageText }}>
                  <Trans>Needs review</Trans>
                </Text>
                {pending.map(item => (
                  <View
                    key={item.messageId}
                    style={{
                      border: `1px solid ${theme.tableBorder}`,
                      borderRadius: 6,
                      padding: 10,
                      gap: 8,
                    }}
                  >
                    <ReceiptSummary item={item} />
                    {item.proposals.filter(p => p.status === 'review')
                      .length === 0 ? (
                      <View
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 10,
                        }}
                      >
                        <Text style={{ color: theme.pageTextSubdued }}>
                          <Trans>No matching transaction found yet.</Trans>
                        </Text>
                        <Button
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
                    ) : (
                      item.proposals
                        .filter(p => p.status === 'review')
                        .map(proposal => (
                          <ProposalLine
                            key={proposal.id}
                            proposal={proposal}
                            busy={isBusy}
                            onApply={() => {
                              void act(() =>
                                send('email-receipts-apply', {
                                  proposalId: proposal.id,
                                }),
                              );
                            }}
                            onReject={() => {
                              void act(() =>
                                send('email-receipts-reject', {
                                  proposalId: proposal.id,
                                }),
                              );
                            }}
                          />
                        ))
                    )}
                  </View>
                ))}
              </View>
            )}

            {applied.length > 0 && (
              <View style={{ gap: 10 }}>
                <Text style={{ fontWeight: 600, color: theme.pageText }}>
                  <Trans>Applied</Trans>
                </Text>
                {applied.map(item => {
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
                        border: `1px solid ${theme.tableBorder}`,
                        borderRadius: 6,
                        padding: 10,
                      }}
                    >
                      <View style={{ gap: 2 }}>
                        <View
                          style={{
                            flexDirection: 'row',
                            gap: 10,
                            alignItems: 'baseline',
                          }}
                        >
                          <Text
                            style={{ fontWeight: 600, color: theme.pageText }}
                          >
                            {item.receipt.merchant}
                          </Text>
                          <FinancialText style={{ color: theme.pageText }}>
                            {integerToCurrency(receiptAmount(item))}
                          </FinancialText>
                          <Text
                            style={{
                              backgroundColor: theme.pillBackground,
                              color: theme.pillText,
                              borderRadius: 4,
                              padding: '1px 6px',
                              fontSize: 11,
                            }}
                          >
                            {appliedProposal.status === 'auto_applied'
                              ? t('Auto-applied')
                              : t('Applied')}
                            {appliedProposal.appliedSplit
                              ? ` • ${t('split')}`
                              : ''}
                          </Text>
                        </View>
                        <Text
                          style={{ color: theme.pageTextSubdued, fontSize: 12 }}
                        >
                          {appliedProposal.transactionDate}
                          {' • '}
                          {appliedProposal.transactionPayee ?? '-'}
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
            )}
          </View>
        </>
      )}
    </Modal>
  );
};
