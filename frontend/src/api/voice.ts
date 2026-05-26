import axios from 'axios';

const api = axios.create({ baseURL: '/api/voice' });

export interface ChatResponse {
  userText: string;
  assistantText: string;
  audioBase64: string;
  audioMimeType: string;
  empty?: boolean;
}

export async function createSession(existingId?: string): Promise<string> {
  const { data } = await api.post<{ success: boolean; data: { sessionId: string } }>('/session', {
    sessionId: existingId,
  });
  return data.data.sessionId;
}

export interface AiChoice {
  aiProvider: 'local' | 'groq';
  aiModel?: string;
}

export async function sendAudio(
  audioBlob: Blob,
  sessionId: string,
  languageCode: string = 'hi-IN',
  systemPrompt?: string,
  ai?: AiChoice,
): Promise<ChatResponse> {
  const form = new FormData();
  form.append('audio', audioBlob, 'recording.webm');
  form.append('sessionId', sessionId);
  form.append('languageCode', languageCode);
  if (systemPrompt) form.append('systemPrompt', systemPrompt);
  if (ai) {
    form.append('aiProvider', ai.aiProvider);
    if (ai.aiModel) form.append('aiModel', ai.aiModel);
  }

  const { data } = await api.post<{ success: boolean; data: ChatResponse & { empty?: boolean } }>('/chat', form, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return data.data;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
}

export async function getHistory(sessionId: string): Promise<Message[]> {
  const { data } = await api.get<{ success: boolean; data: { messages: Message[] } }>(`/history/${sessionId}`);
  return data.data.messages;
}

export async function sendText(
  text: string,
  sessionId: string,
  languageCode: string = 'hi-IN',
  systemPrompt?: string,
  ai?: AiChoice,
): Promise<ChatResponse> {
  const { data } = await api.post<{ success: boolean; data: ChatResponse }>('/chat-text', {
    text,
    sessionId,
    languageCode,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(ai ? { aiProvider: ai.aiProvider, ...(ai.aiModel ? { aiModel: ai.aiModel } : {}) } : {}),
  });
  return data.data;
}

export async function clearHistory(sessionId: string): Promise<void> {
  await api.delete(`/history/${sessionId}`);
}

export interface TextOnlyResponse {
  userText: string;
  assistantText: string;
}

export async function sendTextOnly(
  text: string,
  sessionId: string,
  languageCode: string = 'hi-IN',
  systemPrompt?: string,
  ai?: AiChoice,
): Promise<TextOnlyResponse> {
  const { data } = await api.post<{ success: boolean; data: ChatResponse }>('/chat-text', {
    text,
    sessionId,
    languageCode,
    skipTts: true,
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(ai ? { aiProvider: ai.aiProvider, ...(ai.aiModel ? { aiModel: ai.aiModel } : {}) } : {}),
  });
  return { userText: data.data.userText, assistantText: data.data.assistantText };
}

// ── RAG / Knowledge Base ──────────────────────────────────────────────────────

const ragApi = axios.create({ baseURL: '/api/rag' });

export interface KnowledgeDoc {
  documentId: string;
  filename: string;
  mimetype: string;
  chunkCount: number;
  sizeBytes: number;
  createdAt: string;
}

export async function uploadKnowledgeFile(file: File): Promise<{ documentId: string; chunkCount: number }> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await ragApi.post<{ success: boolean; data: { documentId: string; chunkCount: number } }>('/upload', form);
  return data.data;
}

export async function uploadKnowledgeText(title: string, text: string): Promise<{ documentId: string; chunkCount: number }> {
  const { data } = await ragApi.post<{ success: boolean; data: { documentId: string; chunkCount: number } }>('/upload-text', { title, text });
  return data.data;
}

export async function listKnowledgeDocs(): Promise<KnowledgeDoc[]> {
  const { data } = await ragApi.get<{ success: boolean; data: KnowledgeDoc[] }>('/documents');
  return data.data;
}

export async function deleteKnowledgeDoc(documentId: string): Promise<void> {
  await ragApi.delete(`/documents/${documentId}`);
}
