import axios from 'axios';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import type { IMessage } from '../models/Conversation';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

interface GeminiResponse {
  candidates: { content: { parts: { text: string }[] } }[];
}

const SYSTEM_PROMPT = `You are Orvo, a helpful and friendly AI voice assistant built for Indian users.
Keep your responses concise (2-4 sentences max) since they will be read aloud.
You support Hindi and English. Match the language the user speaks in.
Be warm, conversational, and helpful.`;

/**
 * Send conversation history to Gemma via Google AI Studio and get a reply.
 * History is kept to last 10 messages to control token cost.
 */
export async function chatWithGemma(
  userText: string,
  history: IMessage[],
): Promise<string> {
  const model = process.env.GEMMA_MODEL ?? 'gemma-3-12b-it';
  const apiKey = process.env.GEMMA_API_KEY ?? '';

  const contents: GeminiContent[] = [
    { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'Understood. I am Orvo, ready to help!' }] },
    ...history.slice(-10).map((m) => ({
      role: m.role === 'user' ? ('user' as const) : ('model' as const),
      parts: [{ text: m.text }],
    })),
    { role: 'user', parts: [{ text: userText }] },
  ];

  try {
    const { data } = await axios.post<GeminiResponse>(
      `${GEMINI_BASE}/models/${model}:generateContent?key=${apiKey}`,
      {
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 256,
          topP: 0.9,
        },
      },
      { timeout: 30_000 },
    );

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!reply) throw new Error('Empty Gemma response');
    logger.debug('Gemma reply', { preview: reply.slice(0, 100) });
    return reply.trim();
  } catch (err) {
    logger.error('Gemma error', { err });
    throw new AppError('AI response failed', 502);
  }
}
