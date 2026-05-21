import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger';

// S3 is active only when all three env vars are set.
const isS3Configured =
  Boolean(process.env.AWS_ACCESS_KEY_ID) &&
  Boolean(process.env.AWS_SECRET_ACCESS_KEY) &&
  Boolean(process.env.AWS_S3_BUCKET);

const s3 = isS3Configured
  ? new S3Client({
      region: process.env.AWS_REGION ?? 'ap-south-1',
      credentials: {
        accessKeyId:     process.env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
      },
    })
  : null;

const BUCKET  = process.env.AWS_S3_BUCKET ?? '';
const LOCAL_DIR = path.join(os.tmpdir(), 'orvo-uploads');

// ── Upload ────────────────────────────────────────────────────────────────────

export async function uploadFile(
  buffer: Buffer,
  key: string,
  mimetype: string,
): Promise<string> {
  if (s3 && BUCKET) {
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buffer, ContentType: mimetype }));
    const url = `https://${BUCKET}.s3.${process.env.AWS_REGION ?? 'ap-south-1'}.amazonaws.com/${key}`;
    logger.info('File uploaded to S3', { key, bytes: buffer.length });
    return url;
  }

  // Local fallback
  await fs.mkdir(LOCAL_DIR, { recursive: true });
  const localPath = path.join(LOCAL_DIR, key.replace(/\//g, '_'));
  await fs.writeFile(localPath, buffer);
  logger.info('File saved locally (S3 not configured)', { localPath, bytes: buffer.length });
  return `local://${localPath}`;
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteFile(key: string, fileUrl: string): Promise<void> {
  if (s3 && BUCKET && !fileUrl.startsWith('local://')) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    logger.info('File deleted from S3', { key });
    return;
  }

  // Local fallback
  const localPath = fileUrl.replace('local://', '');
  await fs.unlink(localPath).catch(() => undefined);
  logger.info('Local file deleted', { localPath });
}
