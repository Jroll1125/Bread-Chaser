import { join, resolve } from 'node:path';

import { config } from '#load-config';

import type { BrandedId } from './types';

const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export type FileId = BrandedId<'file'>;
export type GroupId = BrandedId<'group'>;
export type AttachmentId = BrandedId<'attachment'>;

export function isValidFileId(id: string): id is FileId {
  return ID_REGEX.test(id);
}

export function isValidAttachmentId(id: string): id is AttachmentId {
  return ID_REGEX.test(id);
}

export function isValidGroupId(id: string): id is GroupId {
  return ID_REGEX.test(id);
}

export function getPathForUserFile(fileId: FileId) {
  return join(resolve(config.get('userFiles')), `file-${fileId}.blob`);
}

export function getPathForGroupFile(groupId: GroupId) {
  return join(resolve(config.get('userFiles')), `group-${groupId}.sqlite`);
}

export function getAttachmentsDir() {
  return join(resolve(config.get('userFiles')), 'attachments');
}

export function getPathForAttachment(attachmentId: AttachmentId) {
  return join(getAttachmentsDir(), `attachment-${attachmentId}.blob`);
}
