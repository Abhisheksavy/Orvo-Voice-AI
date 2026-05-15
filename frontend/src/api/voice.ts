import axios from 'axios';

const api = axios.create({ baseURL: '/api/voice' });

export interface ChatResponse {
  userText: string;
  assistantText: string;
  audioBase64: string;
  audioMimeType: string;
}

export async function createSession(existingId?: string): Promise<string> {
  const { data } = await api.post<{ success: boolean; data: { sessionId: string } }>('/session', {
    sessionId: existingId,
  });
  return data.data.sessionId;
}

export async function sendAudio(
  audioBlob: Blob,
  sessionId: string,
  languageCode: string = 'hi-IN',
): Promise<ChatResponse> {
  const form = new FormData();
  form.append('audio', audioBlob, 'recording.webm');
  form.append('sessionId', sessionId);
  form.append('languageCode', languageCode);

  const { data } = await api.post<{ success: boolean; data: ChatResponse }>('/chat', form, {
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

export async function clearHistory(sessionId: string): Promise<void> {
  await api.delete(`/history/${sessionId}`);
}
