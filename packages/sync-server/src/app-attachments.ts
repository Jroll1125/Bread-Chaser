import fs from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Request, Response } from 'express';
import express from 'express';

import { getAccountDb, isAdmin } from './account-db';
import { config } from './load-config';
import {
  errorMiddleware,
  requestLoggerMiddleware,
  validateSessionMiddleware,
} from './util/middlewares';
import {
  getAttachmentsDir,
  getPathForAttachment,
  isValidAttachmentId,
} from './util/paths';
import type { AttachmentId } from './util/paths';

const app = express();
app.use(validateSessionMiddleware);
app.use(errorMiddleware);
app.use(requestLoggerMiddleware);
app.use(
  express.raw({
    type: 'application/encrypted-file',
    limit: `${config.get('upload.syncEncryptedFileSizeLimitMB')}mb`,
  }),
);
app.use(express.json({ limit: `${config.get('upload.fileSizeLimitMB')}mb` }));

export { app as handlers };

type AttachmentRow = {
  id: string;
  owner: string;
  transaction_id: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number;
  key_meta: string | null;
  created_at: number;
  deleted: number;
};

function getAttachment(id: AttachmentId): AttachmentRow | null {
  return (
    (getAccountDb().first('SELECT * FROM attachments WHERE id = ?', [
      id,
    ]) as AttachmentRow | null) ?? null
  );
}

function requireAttachmentOwner(row: AttachmentRow, userId: string) {
  if (row.owner === userId || isAdmin(userId)) {
    return null;
  }
  return 'attachment-access-not-allowed';
}

function extractSingleHeader(
  req: Request,
  res: Response,
  key: string,
): string | null {
  const value = req.headers[key];
  if (!value) {
    return null;
  }
  if (typeof value !== 'string') {
    res.status(400).send('Duplicate headers encountered for key ' + key);
    return null;
  }
  return value;
}

function requireAttachmentId(req: Request, res: Response): AttachmentId | null {
  const id = req.params['id'];
  if (typeof id !== 'string' || !isValidAttachmentId(id)) {
    res.status(400).send('invalid attachment id');
    return null;
  }
  return id;
}

app.post('/upload', async (req, res) => {
  const id = extractSingleHeader(req, res, 'x-actual-attachment-id');
  if (res.headersSent) return;
  if (!id || !isValidAttachmentId(id)) {
    res.status(400).send('single x-actual-attachment-id is required');
    return;
  }

  const transactionId = extractSingleHeader(req, res, 'x-actual-transaction-id');
  if (res.headersSent) return;
  if (!transactionId) {
    res.status(400).send('single x-actual-transaction-id is required');
    return;
  }

  const rawName = extractSingleHeader(req, res, 'x-actual-name');
  if (res.headersSent) return;
  if (!rawName) {
    res.status(400).send('single x-actual-name is required');
    return;
  }
  const name = decodeURIComponent(rawName);

  const contentType = extractSingleHeader(req, res, 'x-actual-mime');
  if (res.headersSent) return;
  const keyMeta = extractSingleHeader(req, res, 'x-actual-key-meta');
  if (res.headersSent) return;

  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).send('attachment body is required');
    return;
  }

  const userId = res.locals.user_id as string | undefined;
  if (!userId) {
    res.status(401).send('unauthorized');
    return;
  }

  const accountDb = getAccountDb();
  const currentRow = getAttachment(id);
  if (currentRow && requireAttachmentOwner(currentRow, userId)) {
    res.status(403).send('attachment-access-not-allowed');
    return;
  }

  try {
    await fs.mkdir(getAttachmentsDir(), { recursive: true });
    await fs.writeFile(getPathForAttachment(id), req.body);
  } catch (err) {
    console.log('Error writing attachment', err);
    res.status(500).send({ status: 'error' });
    return;
  }

  if (currentRow) {
    accountDb.mutate(
      `UPDATE attachments
          SET transaction_id = ?, file_name = ?, content_type = ?,
              size_bytes = ?, key_meta = ?, deleted = 0
        WHERE id = ?`,
      [transactionId, name, contentType, req.body.length, keyMeta, id],
    );
  } else {
    accountDb.mutate(
      `INSERT INTO attachments
         (id, owner, transaction_id, file_name, content_type, size_bytes,
          key_meta, created_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        id,
        userId,
        transactionId,
        name,
        contentType,
        req.body.length,
        keyMeta,
        Date.now(),
      ],
    );
  }

  res.send({ status: 'ok', id });
});

app.get('/download/:id', async (req, res) => {
  const id = requireAttachmentId(req, res);
  if (!id) return;

  const row = getAttachment(id);
  if (!row || row.deleted) {
    res.status(400).send('attachment not found');
    return;
  }

  const accessError = requireAttachmentOwner(row, res.locals.user_id);
  if (accessError) {
    res.status(403).send(accessError);
    return;
  }

  const path = getPathForAttachment(id);
  if (!path.startsWith(resolve(config.get('userFiles')))) {
    res.status(403).send('Access denied');
    return;
  }

  res.setHeader('Content-Disposition', `attachment;filename=${id}`);
  res.setHeader('X-ACTUAL-KEY-META', row.key_meta ?? '');
  res.sendFile(path, { dotfiles: 'allow' });
});

app.get('/list', (req, res) => {
  const userId = res.locals.user_id as string;
  const transactionId = req.query['transactionId'];

  let rows: AttachmentRow[];
  if (typeof transactionId === 'string' && transactionId !== '') {
    rows = getAccountDb().all(
      `SELECT id, transaction_id, file_name, content_type, size_bytes, created_at
         FROM attachments
        WHERE deleted = 0 AND transaction_id = ? AND (owner = ? OR ?)`,
      [transactionId, userId, isAdmin(userId) ? 1 : 0],
    ) as AttachmentRow[];
  } else {
    rows = getAccountDb().all(
      `SELECT id, transaction_id, file_name, content_type, size_bytes, created_at
         FROM attachments
        WHERE deleted = 0 AND (owner = ? OR ?)`,
      [userId, isAdmin(userId) ? 1 : 0],
    ) as AttachmentRow[];
  }

  res.send({ status: 'ok', data: rows });
});

app.delete('/:id', async (req, res) => {
  const id = requireAttachmentId(req, res);
  if (!id) return;

  const row = getAttachment(id);
  if (!row || row.deleted) {
    // Deleting something that is already gone is a success.
    res.send({ status: 'ok' });
    return;
  }

  const accessError = requireAttachmentOwner(row, res.locals.user_id);
  if (accessError) {
    res.status(403).send(accessError);
    return;
  }

  getAccountDb().mutate('UPDATE attachments SET deleted = 1 WHERE id = ?', [
    id,
  ]);

  try {
    await fs.unlink(getPathForAttachment(id));
  } catch (err) {
    // A missing blob should not fail the delete; the metadata row is
    // already tombstoned.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.log('Error deleting attachment blob', err);
    }
  }

  res.send({ status: 'ok' });
});
