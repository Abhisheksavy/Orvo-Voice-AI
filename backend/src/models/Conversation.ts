import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage {
  role: 'user' | 'assistant';
  text: string;
  audioKey?: string;
  createdAt: Date;
}

export interface IConversation extends Document {
  sessionId: string;
  messages: IMessage[];
  languageCode: string;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<IMessage>(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    text: { type: String, required: true },
    audioKey: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, _id: false }
);

const conversationSchema = new Schema<IConversation>(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    messages: { type: [messageSchema], default: [] },
    languageCode: { type: String, default: 'hi-IN' },
  },
  { timestamps: true }
);

export default mongoose.model<IConversation>('Conversation', conversationSchema);
