import { v4 as uuidv4 } from 'uuid';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse: (buf: Buffer) => Promise<{ text: string }> = require('pdf-parse');
import mammoth from 'mammoth';
import { KnowledgeChunk, KnowledgeDocument } from '../models/KnowledgeChunk';
import { uploadFile, deleteFile } from './s3';
import logger from '../utils/logger';

const CHUNK_SIZE    = 600;  // target characters per chunk
const CHUNK_OVERLAP = 100;  // overlap between consecutive chunks

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

  return buffer.toString('utf-8');
}

// ── Chunking ──────────────────────────────────────────────────────────────────
// Strategy: sentence-boundary aware sliding window.
// 1. Normalise whitespace.
// 2. For each window of CHUNK_SIZE chars, try to split at the last sentence
//    boundary (. ! ? \n) so chunks end cleanly.
// 3. Overlap by CHUNK_OVERLAP chars for retrieval continuity.
// 4. Always include the final remainder — no minimum-length discard.

function chunkText(text: string): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    const idealEnd = start + CHUNK_SIZE;

    if (idealEnd >= cleaned.length) {
      // Final segment — always include regardless of length
      const last = cleaned.slice(start).trim();
      if (last.length > 0) chunks.push(last);
      break;
    }

    // Try to find the last sentence boundary in the final 150 chars of the window
    let splitAt = idealEnd;
    const searchStart = Math.max(start + Math.floor(CHUNK_SIZE / 2), idealEnd - 150);
    const window = cleaned.slice(searchStart, idealEnd);
    // Match sentence-ending punctuation followed by a space or end-of-window
    const sentenceMatch = window.search(/[.!?\n](?=\s|$)/);
    if (sentenceMatch !== -1) {
      splitAt = searchStart + sentenceMatch + 1;
    } else {
      // Fall back to last word boundary
      const wordBreak = cleaned.lastIndexOf(' ', idealEnd);
      if (wordBreak > start + Math.floor(CHUNK_SIZE / 2)) {
        splitAt = wordBreak + 1;
      }
    }

    const chunk = cleaned.slice(start, splitAt).trim();
    if (chunk.length > 0) chunks.push(chunk);

    start = splitAt - CHUNK_OVERLAP;
  }

  return chunks;
}

// ── Ingest from file ──────────────────────────────────────────────────────────

export async function ingestDocument(
  buffer: Buffer,
  filename: string,
  mimetype: string,
  sizeBytes: number,
): Promise<{ documentId: string; chunkCount: number }> {
  const documentId = uuidv4();
  const s3Key = `knowledge/${documentId}/${filename}`;

  const fileUrl = await uploadFile(buffer, s3Key, mimetype);

  const rawText = await extractText(buffer, mimetype);
  if (!rawText.trim()) throw new Error('Could not extract text from document');

  const chunks = chunkText(rawText);
  if (chunks.length === 0) throw new Error('Document produced no usable chunks');

  await KnowledgeDocument.create({ documentId, filename, mimetype, chunkCount: chunks.length, sizeBytes, s3Key, fileUrl });
  await KnowledgeChunk.insertMany(
    chunks.map((text, chunkIndex) => ({ documentId, filename, chunkIndex, text })),
  );

  logger.info('Document ingested', { documentId, filename, chunkCount: chunks.length });
  return { documentId, chunkCount: chunks.length };
}

// ── Ingest from pasted text ───────────────────────────────────────────────────

export async function ingestText(
  rawText: string,
  title: string,
): Promise<{ documentId: string; chunkCount: number }> {
  if (!rawText.trim()) throw new Error('Text is empty');

  const documentId = uuidv4();
  const sizeBytes = Buffer.byteLength(rawText, 'utf-8');

  const chunks = chunkText(rawText);
  if (chunks.length === 0) throw new Error('Text produced no usable chunks');

  // No file to upload — store metadata only (s3Key/fileUrl omitted)
  await KnowledgeDocument.create({
    documentId,
    filename: title,
    mimetype: 'text/plain',
    chunkCount: chunks.length,
    sizeBytes,
  });
  await KnowledgeChunk.insertMany(
    chunks.map((text, chunkIndex) => ({ documentId, filename: title, chunkIndex, text })),
  );

  logger.info('Text ingested', { documentId, title, chunkCount: chunks.length });
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
    doc?.s3Key ? deleteFile(doc.s3Key, doc.fileUrl ?? '') : Promise.resolve(),
  ]);
  logger.info('Document deleted', { documentId });
}
