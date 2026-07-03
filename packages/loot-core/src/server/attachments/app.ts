import { v4 as uuidv4 } from 'uuid';

import * as asyncStorage from '#platform/server/asyncStorage';
import * as fs from '#platform/server/fs';
import { logger } from '#platform/server/log';
import * as secureStore from '#platform/server/secure-store';
import { createApp } from '#server/app';
import * as db from '#server/db';
import * as encryption from '#server/encryption';
import { mutator } from '#server/mutators';
import { getServer } from '#server/server-config';

export type TransactionAttachmentEntity = {
  id: string;
  transaction_id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number;
  source: 'file' | 'email';
  source_key: string | null;
  created_at: number;
};

type AttachmentRow = TransactionAttachmentEntity & {
  key_meta: string | null;
  tombstone: number;
};

export type AttachmentsHandlers = {
  'attachments-add': typeof addAttachment;
  'attachments-add-data': typeof addAttachmentData;
  'attachments-list': typeof listAttachments;
  'attachments-open': typeof openAttachment;
  'attachments-delete': typeof deleteAttachment;
  'attachments-for-account': typeof attachmentsForAccount;
};

export const app = createApp<AttachmentsHandlers>();
app.method('attachments-add', mutator(addAttachment));
app.method('attachments-add-data', mutator(addAttachmentData));
app.method('attachments-list', listAttachments);
app.method('attachments-open', openAttachment);
// Deliberately not undoable: undo would resurrect metadata whose server
// blob has already been deleted.
app.method('attachments-delete', mutator(deleteAttachment));
app.method('attachments-for-account', attachmentsForAccount);

// The attachments encryption key: a random 256-bit key generated once and
// sealed in the OS keychain via the secure store. Blobs are encrypted with
// AES-256-GCM before they ever leave this machine for the sync-server.
const ATTACHMENTS_KEY_ID = 'attachments';
const ATTACHMENTS_KEY_SECRET = 'attachments-key';

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  html: 'text/html',
};

// Inline previews are data URIs; cap them so a huge image cannot balloon
// the renderer.
const MAX_INLINE_PREVIEW_BYTES = 20 * 1024 * 1024;

async function ensureAttachmentsKey(): Promise<void> {
  if (encryption.hasKey(ATTACHMENTS_KEY_ID)) {
    return;
  }
  let base64 = await secureStore.getSecret(ATTACHMENTS_KEY_SECRET);
  if (base64 == null) {
    base64 = Buffer.from(encryption.randomBytes(32)).toString('base64');
    await secureStore.setSecret(ATTACHMENTS_KEY_SECRET, base64);
  }
  await encryption.loadKey({ id: ATTACHMENTS_KEY_ID, base64 });
}

async function getServerInfo(): Promise<{ base: string; token: string }> {
  const server = getServer();
  if (!server) {
    throw new Error('No sync server is configured');
  }
  const token = await asyncStorage.getItem('user-token');
  if (!token) {
    throw new Error('Not logged in to the sync server');
  }
  return { base: server.BASE_SERVER, token };
}

function fileNameFromPath(filepath: string): string {
  const name = filepath.replace(/\\/g, '/').split('/').pop();
  return name || 'attachment';
}

function extensionOf(fileName: string): string | null {
  const match = fileName.match(/\.([a-zA-Z0-9]{1,5})$/);
  return match ? match[1].toLowerCase() : null;
}

function contentTypeFor(fileName: string): string | null {
  const ext = extensionOf(fileName);
  return ext ? (MIME_BY_EXT[ext] ?? null) : null;
}

function attachmentsCacheDir(): string {
  const dataDir = fs.getDataDir();
  if (!dataDir) {
    throw new Error('No data directory is available to cache attachments');
  }
  return fs.join(dataDir, 'attachments');
}

function cachePathFor(row: {
  id: string;
  file_name: string | null;
}): string {
  const ext = row.file_name ? extensionOf(row.file_name) : null;
  return fs.join(attachmentsCacheDir(), row.id + (ext ? '.' + ext : ''));
}

async function writeCacheFile(
  row: { id: string; file_name: string | null },
  data: Buffer,
): Promise<string> {
  const dir = attachmentsCacheDir();
  if (!(await fs.exists(dir))) {
    await fs.mkdir(dir);
  }
  const path = cachePathFor(row);
  await fs.writeFile(path, data);
  return path;
}

export async function addAttachmentBuffer({
  transactionId,
  data,
  fileName,
  contentType,
  source,
  sourceKey,
}: {
  transactionId: string;
  data: Buffer;
  fileName: string;
  contentType?: string | null;
  source: 'file' | 'email';
  sourceKey?: string | null;
}): Promise<TransactionAttachmentEntity> {
  if (data.length === 0) {
    throw new Error('Cannot attach an empty file');
  }

  const { base, token } = await getServerInfo();
  await ensureAttachmentsKey();

  const id = uuidv4();
  const resolvedContentType = contentType ?? contentTypeFor(fileName);
  const { value: encrypted, meta } = await encryption.encrypt(
    data,
    ATTACHMENTS_KEY_ID,
  );

  let res;
  try {
    res = await fetch(base + '/attachments/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/encrypted-file',
        'X-ACTUAL-TOKEN': token,
        'X-ACTUAL-ATTACHMENT-ID': id,
        'X-ACTUAL-TRANSACTION-ID': transactionId,
        'X-ACTUAL-NAME': encodeURIComponent(fileName),
        ...(resolvedContentType
          ? { 'X-ACTUAL-MIME': resolvedContentType }
          : {}),
        'X-ACTUAL-KEY-META': JSON.stringify(meta),
      },
      body: encrypted,
    });
  } catch (err) {
    throw new Error('Could not reach the sync server to upload', {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new Error(
      `Attachment upload failed (${res.status}): ${await res.text()}`,
    );
  }

  const row = {
    id,
    transaction_id: transactionId,
    file_name: fileName,
    content_type: resolvedContentType,
    size_bytes: data.length,
    source,
    source_key: sourceKey ?? null,
    key_meta: JSON.stringify(meta),
    created_at: Date.now(),
  };
  await db.insert('transaction_attachments', row);

  try {
    await writeCacheFile(row, data);
  } catch (err) {
    // The cache is an optimization; opening will re-download on demand.
    logger.warn('Failed to cache attachment locally', err);
  }

  const { key_meta: _keyMeta, ...entity } = row;
  return entity;
}

export async function hasAttachmentForSource(
  transactionId: string,
  sourceKey: string,
): Promise<boolean> {
  const existing = await db.first<{ id: string }>(
    `SELECT id FROM transaction_attachments
      WHERE transaction_id = ? AND source_key = ? AND tombstone = 0`,
    [transactionId, sourceKey],
  );
  return existing != null;
}

async function addAttachment({
  transactionId,
  filepath,
}: {
  transactionId: string;
  filepath: string;
}): Promise<TransactionAttachmentEntity> {
  const data = (await fs.readFile(filepath, 'binary')) as Buffer;
  const fileName = fileNameFromPath(filepath);
  return addAttachmentBuffer({
    transactionId,
    data: Buffer.from(data),
    fileName,
    source: 'file',
  });
}

// Attach bytes the renderer already holds in memory (base64-encoded), for
// flows that read the file themselves instead of passing a picked path — e.g.
// mortgage statement import, which reads PDFs for text extraction. A
// `sourceKey` makes re-imports idempotent: if the transaction already has an
// attachment with that key, this returns null instead of duplicating.
export async function addAttachmentData({
  transactionId,
  fileName,
  dataBase64,
  contentType,
  sourceKey,
}: {
  transactionId: string;
  fileName: string;
  dataBase64: string;
  contentType?: string | null;
  sourceKey?: string | null;
}): Promise<TransactionAttachmentEntity | null> {
  if (sourceKey && (await hasAttachmentForSource(transactionId, sourceKey))) {
    return null;
  }
  return addAttachmentBuffer({
    transactionId,
    data: Buffer.from(dataBase64, 'base64'),
    fileName,
    contentType: contentType ?? null,
    source: 'file',
    sourceKey: sourceKey ?? null,
  });
}

async function listAttachments({
  transactionId,
}: {
  transactionId: string;
}): Promise<TransactionAttachmentEntity[]> {
  return db.all<TransactionAttachmentEntity>(
    `SELECT id, transaction_id, file_name, content_type, size_bytes,
            source, source_key, created_at
       FROM transaction_attachments
      WHERE transaction_id = ? AND tombstone = 0
      ORDER BY created_at`,
    [transactionId],
  );
}

async function getAttachmentRow(id: string): Promise<AttachmentRow> {
  const row = await db.first<AttachmentRow>(
    'SELECT * FROM transaction_attachments WHERE id = ? AND tombstone = 0',
    [id],
  );
  if (!row) {
    throw new Error('Attachment not found: ' + id);
  }
  return row;
}

async function downloadAndDecrypt(row: AttachmentRow): Promise<Buffer> {
  const { base, token } = await getServerInfo();
  let res;
  try {
    res = await fetch(base + '/attachments/download/' + row.id, {
      headers: { 'X-ACTUAL-TOKEN': token },
    });
  } catch (err) {
    throw new Error('Could not reach the sync server to download', {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new Error(
      `Attachment download failed (${res.status}): ${await res.text()}`,
    );
  }
  const encrypted = Buffer.from(await res.arrayBuffer());

  if (!row.key_meta) {
    throw new Error('Attachment is missing its encryption metadata');
  }
  await ensureAttachmentsKey();
  return encryption.decrypt(encrypted, JSON.parse(row.key_meta));
}

async function openAttachment({ id }: { id: string }): Promise<{
  path: string;
  dataUri: string | null;
}> {
  const row = await getAttachmentRow(id);
  const path = cachePathFor(row);

  let data: Buffer;
  if (await fs.exists(path)) {
    data = Buffer.from((await fs.readFile(path, 'binary')) as Buffer);
  } else {
    data = await downloadAndDecrypt(row);
    await writeCacheFile(row, data);
  }

  const isImage = row.content_type?.startsWith('image/') ?? false;
  const dataUri =
    isImage && data.length <= MAX_INLINE_PREVIEW_BYTES
      ? `data:${row.content_type};base64,${data.toString('base64')}`
      : null;

  return { path, dataUri };
}

async function deleteAttachment({ id }: { id: string }): Promise<void> {
  const row = await getAttachmentRow(id);

  await db.delete_('transaction_attachments', id);

  try {
    const { base, token } = await getServerInfo();
    const res = await fetch(base + '/attachments/' + id, {
      method: 'DELETE',
      headers: { 'X-ACTUAL-TOKEN': token },
    });
    if (!res.ok) {
      logger.warn(
        `Failed to delete attachment blob on server (${res.status})`,
      );
    }
  } catch (err) {
    logger.warn('Failed to delete attachment blob on server', err);
  }

  try {
    const path = cachePathFor(row);
    if (await fs.exists(path)) {
      await fs.removeFile(path);
    }
  } catch (err) {
    logger.warn('Failed to remove cached attachment', err);
  }
}

async function attachmentsForAccount({
  accountId,
}: {
  accountId?: string;
} = {}): Promise<string[]> {
  let rows: Array<{ transaction_id: string }>;
  if (accountId) {
    rows = await db.all<{ transaction_id: string }>(
      `SELECT DISTINCT ta.transaction_id
         FROM transaction_attachments ta
         JOIN transactions t ON t.id = ta.transaction_id
        WHERE ta.tombstone = 0 AND t.acct = ?`,
      [accountId],
    );
  } else {
    rows = await db.all<{ transaction_id: string }>(
      `SELECT DISTINCT transaction_id
         FROM transaction_attachments
        WHERE tombstone = 0`,
    );
  }
  return rows.map(row => row.transaction_id);
}
