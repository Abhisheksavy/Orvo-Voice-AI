import axios from 'axios';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import type { IMessage } from '../models/Conversation';

// Groq uses OpenAI-compatible API — fast inference, free tier 14k req/day
const GROQ_BASE = 'https://api.groq.com/openai/v1';

const SYSTEM_PROMPT = `You are Orvo, a voice AI assistant for Indian users.
Reply ONLY with the spoken answer — no markdown, no bullet points, no asterisks, no labels, no reasoning.
Keep it to 1-3 sentences maximum. It will be read aloud.
Always reply in the same language the user used (Hindi or English).
Be warm, direct, and conversational.`;

export async function chatWithGemma(userText: string, history: IMessage[], customSystemPrompt?: string): Promise<string> {
  const model = process.env.GEMMA_MODEL ?? 'gemma2-9b-it';
  const apiKey = process.env.GEMMA_API_KEY ?? '';

  const messages = [
    { role: 'system', content: customSystemPrompt?.trim() || SYSTEM_PROMPT },
    ...history.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    })),
    { role: 'user', content: userText },
  ];

  try {
    const { data } = await axios.post<{ choices: { message: { content: string } }[] }>(
      `${GROQ_BASE}/chat/completions`,
      {
        model,
        messages,
        temperature: 0.7,
        max_tokens: 128,
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );

    const raw = data.choices?.[0]?.message?.content ?? '';
    if (!raw) throw new Error('Empty Groq response');

    // Strip any residual markdown just in case
    const reply = raw
      .replace(/[*_`#>]/g, '')
      .replace(/\n{2,}/g, ' ')
      .replace(/\n/g, ' ')
      .trim();

    logger.debug('Groq reply', { preview: reply.slice(0, 100) });
    return reply;
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error('Groq error', { status: err.response?.status, data: JSON.stringify(err.response?.data) });
    } else {
      logger.error('Groq error', { err });
    }
    throw new AppError('AI response failed', 502);
  }
}
