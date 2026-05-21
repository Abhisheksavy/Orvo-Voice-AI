import { v4 as uuidv4 } from 'uuid';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require('pdf-parse');
import mammoth from 'mammoth';
import { KnowledgeChunk, KnowledgeDocument } from '../models/KnowledgeChunk';
import { uploadFile, deleteFile } from './s3';
import logger from '../utils/logger';

const CHUNK_SIZE    = 600;  // characters per chunk
const CHUNK_OVERLAP = 100;  // overlap between chunks

// ── Text extraction ───────────────────────────────────────────────────────────

export async function extractText(buffer: Buffer, mimetype: string): Promise<string> {
  const clean = mimetype.split(';')[0].trim();

  if (clean === 'application/pdf') {
    const result = await pdfParse(buffer);
    return result.text;
  }

  if (
    clean === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    clean === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // Plain text fallback
  return buffer.toString('utf-8');
}

// ── Chunking ──────────────────────────────────────────────────────────────────

function chunkText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const end = start + CHUNK_SIZE;
    const chunk = cleaned.slice(start, end).trim();
    if (chunk.length > 60) chunks.push(chunk);
    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

// ── Ingest ────────────────────────────────────────────────────────────────────

export async function ingestDocument(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  sizeBytes: number,
): Promise<{ documentId: string; chunkCount: number }> {
  const documentId = uuidv4();
  const s3Key = `knowledge/${documentId}/${filename}`;

  // 1. Upload original file to S3 (or local fallback)
  const fileUrl = await uploadFile(buffer, s3Key, mimetype);

  // 2. Extract + chunk text → store in MongoDB
  const rawText = await extractText(buffer, mimetype);
  if (!rawText.trim()) throw new Error('Could not extract text from document');

  const chunks = chunkText(rawText);
  if (chunks.length === 0) throw new Error('Document produced no usable chunks');

  await KnowledgeDocument.create({ documentId, filename, mimetype, chunkCount: chunks.length, sizeBytes, s3Key, fileUrl });
  await KnowledgeChunk.insertMany(
    chunks.map((text, chunkIndex) => ({ documentId, filename, chunkIndex, text })),
  );

  logger.info('Document ingested', { documentId, filename, chunkCount: chunks.length, fileUrl });
  return { documentId, chunkCount: chunks.length };
}

// ── Retrieval ─────────────────────────────────────────────────────────────────

export async function retrieveContext(query: string, topK = 3): Promise<string> {
  if (!query.trim()) return '';

  try {
    const results = await KnowledgeChunk
      .find(
        { $text: { $search: query } },
        { score: { $meta: 'textScore' }, text: 1, filename: 1 },
      )
      .sort({ score: { $meta: 'textScore' } })
      .limit(topK)
      .lean();

    if (!results.length) return '';

    const context = results
      .map((r) => `[${r.filename}]: ${r.text}`)
      .join('\n\n');

    logger.debug('RAG retrieved', { query: query.slice(0, 60), chunks: results.length });
    return context;
  } catch (err) {
    logger.warn('RAG retrieval failed', { err: (err as Error).message });
    return '';
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────

export async function deleteDocument(documentId: string): Promise<void> {
  const doc = await KnowledgeDocument.findOne({ documentId }).lean();
  await Promise.all([
    KnowledgeDocument.deleteOne({ documentId }),
    KnowledgeChunk.deleteMany({ documentId }),
    doc ? deleteFile(doc.s3Key, doc.fileUrl) : Promise.resolve(),
  ]);
  logger.info('Document deleted', { documentId });
}
