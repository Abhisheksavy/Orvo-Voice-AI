import mongoose, { Document, Schema } from 'mongoose';

export interface IKnowledgeDocument extends Document {
  documentId: string;
  filename: string;
  mimetype: string;
  chunkCount: number;
  sizeBytes: number;
  s3Key?: string;
  fileUrl?: string;
  createdAt: Date;
}

export interface IKnowledgeChunk extends Document {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  createdAt: Date;
}

const knowledgeDocumentSchema = new Schema<IKnowledgeDocument>(
  {
    documentId: { type: String, required: true, unique: true, index: true },
    filename:   { type: String, required: true },
    mimetype:   { type: String, required: true },
    chunkCount: { type: Number, default: 0 },
    sizeBytes:  { type: Number, default: 0 },
    s3Key:      { type: String, default: undefined },
    fileUrl:    { type: String, default: undefined },
  },
  { timestamps: true },
);

const knowledgeChunkSchema = new Schema<IKnowledgeChunk>(
  {
    documentId: { type: String, required: true, index: true },
    filename:   { type: String, required: true },
    chunkIndex: { type: Number, required: true },
    text:       { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: true },
);

// Full-text index for MongoDB $text search retrieval
knowledgeChunkSchema.index({ text: 'text', filename: 'text' });

export const KnowledgeDocument = mongoose.model<IKnowledgeDocument>('KnowledgeDocument', knowledgeDocumentSchema);
export const KnowledgeChunk    = mongoose.model<IKnowledgeChunk>('KnowledgeChunk', knowledgeChunkSchema);
