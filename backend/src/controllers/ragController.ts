import { Request, Response, NextFunction } from 'express';
import { ingestDocument, deleteDocument } from '../services/rag';
import { KnowledgeDocument } from '../models/KnowledgeChunk';
import { AppError } from '../middleware/errorHandler';

export async function uploadDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = req.file;
    if (!file) throw new AppError('File is required', 400);

    const { documentId, chunkCount } = await ingestDocument(
      file.buffer,
      file.originalname,
      file.mimetype,
      file.size,
    );

    res.json({ success: true, data: { documentId, filename: file.originalname, chunkCount } });
  } catch (err) {
    next(err);
  }
}

export async function listDocuments(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const docs = await KnowledgeDocument.find().sort({ createdAt: -1 }).lean();
    res.json({ success: true, data: docs });
  } catch (err) {
    next(err);
  }
}

export async function removeDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { documentId } = req.params;
    await deleteDocument(documentId);
    res.json({ success: true, data: { deleted: true } });
  } catch (err) {
    next(err);
  }
}
