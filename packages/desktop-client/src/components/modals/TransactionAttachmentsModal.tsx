import React, { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, ButtonWithLoading } from '@actual-app/components/button';
import { SvgAttachment, SvgTrash } from '@actual-app/components/icons/v1';
import { Text } from '@actual-app/components/text';
import { theme } from '@actual-app/components/theme';
import { View } from '@actual-app/components/view';
import { send } from '@actual-app/core/platform/client/connection';

import { Error as ErrorAlert } from '#components/alerts';
import { Modal, ModalCloseButton, ModalHeader } from '#components/common/Modal';
import { refreshAttachedTransactionIds } from '#hooks/useAttachedTransactionIds';
import type { Modal as ModalType } from '#modals/modalsSlice';

const SUPPORTED_EXTENSIONS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'tif',
  'tiff',
];

type AttachmentItem = {
  id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number;
  source: 'file' | 'email';
  created_at: number;
};

type TransactionAttachmentsModalProps = Extract<
  ModalType,
  { name: 'transaction-attachments' }
>['options'];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${bytes} B`;
}

export function TransactionAttachmentsModal({
  transactionId,
}: TransactionAttachmentsModalProps) {
  const { t } = useTranslation();

  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isAdding, setIsAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    try {
      const list = await send('attachments-list', { transactionId });
      setAttachments(list);

      // Inline previews for images; loaded best-effort after the list.
      for (const item of list) {
        if (item.content_type?.startsWith('image/')) {
          try {
            const { dataUri } = await send('attachments-open', {
              id: item.id,
            });
            if (dataUri) {
              setPreviews(prev => ({ ...prev, [item.id]: dataUri }));
            }
          } catch {
            // Preview failures are non-fatal; Open still works.
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsLoading(false);
  }

  useEffect(() => {
    void reload();
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [transactionId]);

  async function onAdd() {
    const res = await window.Actual.openFileDialog({
      properties: ['openFile'],
      filters: [{ name: t('Receipts'), extensions: SUPPORTED_EXTENSIONS }],
    });
    if (!res || res.length === 0) {
      return;
    }
    setIsAdding(true);
    setError(null);
    try {
      for (const filepath of res) {
        await send('attachments-add', { transactionId, filepath });
      }
      await reload();
      void refreshAttachedTransactionIds();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setIsAdding(false);
  }

  async function onOpen(id: string) {
    setError(null);
    try {
      const { path } = await send('attachments-open', { id });
      const result = await window.Actual.openPathInDefaultApp?.(path);
      if (result) {
        setError(result);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await send('attachments-delete', { id });
      await reload();
      void refreshAttachedTransactionIds();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Modal
      name="transaction-attachments"
      containerProps={{ style: { width: 550 } }}
    >
      {({ state }) => (
        <>
          <ModalHeader
            title={t('Attachments')}
            rightContent={<ModalCloseButton onPress={() => state.close()} />}
          />
          <View style={{ display: 'flex', gap: 10 }}>
            {error && <ErrorAlert>{error}</ErrorAlert>}

            {isLoading ? (
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>Loading attachments…</Trans>
              </Text>
            ) : attachments.length === 0 ? (
              <Text style={{ color: theme.pageTextSubdued }}>
                <Trans>
                  No attachments yet. Attach receipts, invoices, or photos to
                  this transaction.
                </Trans>
              </Text>
            ) : (
              attachments.map(item => (
                <View
                  key={item.id}
                  style={{
                    flexDirection: 'column',
                    gap: 6,
                    padding: 10,
                    borderRadius: 6,
                    backgroundColor: theme.pillBackground,
                  }}
                >
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <SvgAttachment
                      style={{ width: 13, height: 13, flexShrink: 0 }}
                    />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text
                        style={{
                          fontWeight: 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.file_name}
                      </Text>
                      <Text
                        style={{
                          fontSize: 12,
                          color: theme.pageTextSubdued,
                        }}
                      >
                        {formatSize(item.size_bytes)}
                        {item.source === 'email' && (
                          <>
                            {' · '}
                            <Trans>from email receipt</Trans>
                          </>
                        )}
                      </Text>
                    </View>
                    <Button
                      variant="bare"
                      onPress={() => onOpen(item.id)}
                      aria-label={t('Open attachment')}
                    >
                      <Trans>Open</Trans>
                    </Button>
                    <Button
                      variant="bare"
                      onPress={() => onDelete(item.id)}
                      aria-label={t('Delete attachment')}
                    >
                      <SvgTrash
                        style={{
                          width: 13,
                          height: 13,
                          color: theme.errorText,
                        }}
                      />
                    </Button>
                  </View>
                  {previews[item.id] && (
                    <img
                      src={previews[item.id]}
                      alt={item.file_name}
                      style={{
                        maxWidth: '100%',
                        maxHeight: 220,
                        objectFit: 'contain',
                        alignSelf: 'flex-start',
                        borderRadius: 4,
                        cursor: 'pointer',
                      }}
                      onClick={() => onOpen(item.id)}
                    />
                  )}
                </View>
              ))
            )}

            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'flex-end',
                paddingTop: 10,
              }}
            >
              <ButtonWithLoading
                variant="primary"
                isLoading={isAdding}
                onPress={onAdd}
              >
                <Trans>Add attachment</Trans>
              </ButtonWithLoading>
            </View>
          </View>
        </>
      )}
    </Modal>
  );
}
