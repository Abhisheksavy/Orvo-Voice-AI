import axios from 'axios';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import type { IMessage } from '../models/Conversation';

// ── Groq (OpenAI-compatible, fast) ───────────────────────────────────────────
const GROQ_BASE = 'https://api.groq.com/openai/v1';

// ── Default system prompt ─────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Orvo, a voice AI assistant for Indian users.
Reply ONLY with the spoken answer — no markdown, no bullet points, no asterisks, no labels, no reasoning.
Keep it to 1-3 sentences maximum. It will be read aloud.
Always reply in the same language the user used (Hindi or English).
Be warm, direct, and conversational.`;

// ── Deployed Gemma inference server ──────────────────────────────────────────
// Set GEMMA_BACKEND_URL in .env to route through your self-hosted Gemma API.
// Leave unset to use Groq directly (faster, sub-second).
const GEMMA_BACKEND_URL = process.env.GEMMA_BACKEND_URL?.trim() ?? '';

async function callGemmaServer(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
): Promise<string> {
  const url = `${GEMMA_BACKEND_URL}/api/chat`;
  const apiKey = process.env.GEMMA_BACKEND_API_KEY ?? '';

  const { data } = await axios.post<{ reply: string }>(
    url,
    {
      message: userText,
      systemPrompt: customSystemPrompt?.trim() || SYSTEM_PROMPT,
      history: history.slice(-10).map((m) => ({ role: m.role, text: m.text })),
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: 120_000,
    },
  );

  const reply = (data.reply ?? '').trim();
  if (!reply) throw new Error('Empty reply from Gemma server');
  return reply;
}

async function callGroq(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
): Promise<string> {
  const model = process.env.GEMMA_MODEL ?? 'llama-3.1-8b-instant';
  const apiKey = process.env.GEMMA_API_KEY ?? '';

  const messages = [
    { role: 'system', content: customSystemPrompt?.trim() || SYSTEM_PROMPT },
    ...history.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    })),
    { role: 'user', content: userText },
  ];

  const { data } = await axios.post<{ choices: { message: { content: string } }[] }>(
    `${GROQ_BASE}/chat/completions`,
    { model, messages, temperature: 0.7, max_tokens: 128 },
    {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    },
  );

  const raw = data.choices?.[0]?.message?.content ?? '';
  if (!raw) throw new Error('Empty Groq response');

  return raw
    .replace(/[*_`#>]/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

export async function chatWithGemma(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
): Promise<string> {
  try {
    if (GEMMA_BACKEND_URL) {
      logger.debug('Using deployed Gemma server: ' + GEMMA_BACKEND_URL);
      return await callGemmaServer(userText, history, customSystemPrompt);
    }
    return await callGroq(userText, history, customSystemPrompt);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error('Inference error', { status: err.response?.status, data: JSON.stringify(err.response?.data) });
    } else {
      logger.error('Inference error', { err });
    }
    throw new AppError('AI response failed', 502);
  }
}
