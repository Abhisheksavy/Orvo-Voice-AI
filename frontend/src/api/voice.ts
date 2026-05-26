import axios from 'axios';

const api = axios.create({ baseURL: '/api/voice' });

export interface ChatResponse {
  userText: string;
  assistantText: string;
  audioBase64: string;
  audioMimeType: string;
  empty?: boolean;
  _timing?: { sttMs: number; ragMs: number; llmMs: number; ttsMs: number; totalMs: number };
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
  numGpu?: number;
  temperature?: number;
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
    if (ai.numGpu !== undefined) form.append('numGpu', String(ai.numGpu));
    if (ai.temperature !== undefined) form.append('temperature', String(ai.temperature));
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
    ...(ai ? { aiProvider: ai.aiProvider, ...(ai.aiModel ? { aiModel: ai.aiModel } : {}), ...(ai.numGpu !== undefined ? { numGpu: ai.numGpu } : {}), ...(ai.temperature !== undefined ? { temperature: ai.temperature } : {}) } : {}),
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
    ...(ai ? { aiProvider: ai.aiProvider, ...(ai.aiModel ? { aiModel: ai.aiModel } : {}), ...(ai.numGpu !== undefined ? { numGpu: ai.numGpu } : {}), ...(ai.temperature !== undefined ? { temperature: ai.temperature } : {}) } : {}),
  });
  return { userText: data.data.userText, assistantText: data.data.assistantText };
}

// ── Streaming audio ───────────────────────────────────────────────────────────

export type StreamEvent =
  | { type: 'transcript'; text: string; sttMs: number }
  | { type: 'audio'; text: string; audioBase64: string; audioMimeType: string }
  | { type: 'done'; assistantText: string; llmMs: number; totalMs: number }
  | { type: 'empty' }
  | { type: 'error'; message: string };

export async function* streamAudioChunks(
  audioBlob: Blob,
  sessionId: string,
  languageCode = 'en-IN',
  systemPrompt?: string,
  ai?: AiChoice,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const form = new FormData();
  form.append('audio', audioBlob, 'recording.webm');
  form.append('sessionId', sessionId);
  form.append('languageCode', languageCode);
  if (systemPrompt) form.append('systemPrompt', systemPrompt);
  if (ai) {
    form.append('aiProvider', ai.aiProvider);
    if (ai.aiModel) form.append('aiModel', ai.aiModel);
    if (ai.numGpu !== undefined) form.append('numGpu', String(ai.numGpu));
    if (ai.temperature !== undefined) form.append('temperature', String(ai.temperature));
  }

  const response = await fetch('/api/voice/chat-stream', { method: 'POST', body: form, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const blocks = buf.split('\n\n');
      buf = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block.trim();
        if (!line.startsWith('data: ')) continue;
        try { yield JSON.parse(line.slice(6)) as StreamEvent; } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
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
