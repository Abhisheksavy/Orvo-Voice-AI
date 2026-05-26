import axios from 'axios';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import type { IMessage } from '../models/Conversation';

const GROQ_BASE = 'https://api.groq.com/openai/v1';

const SYSTEM_PROMPT = `You are Orvo, an AI-powered virtual receptionist for hospitals and healthcare clinics, designed for real-time voice conversations over phone calls.
Your role is to speak naturally like a professional hospital front-desk executive — calm, helpful, polite, fast, and conversational.

CORE ROLE: You assist callers with appointment booking, doctor availability, hospital timings, department guidance, basic patient queries, follow-ups and scheduling, general healthcare assistance.

VOICE & CONVERSATION RULES:
- Keep responses short: maximum 1-2 spoken sentences.
- Speak naturally like a real receptionist — no robotic phrasing.
- Never use bullet points, markdown, numbered lists, or technical explanations.
- Ask only one question at a time.
- Maintain a calm, professional, empathetic tone.

LANGUAGE: Always respond in the SAME language the caller uses — English, Hindi, Hinglish, Tamil, Telugu, Bengali, Marathi, Gujarati, Kannada, Malayalam, or Punjabi. If the user mixes languages, respond in the same mixed style.

MEDICAL SAFETY: You are NOT a doctor. For common symptoms, name the standard OTC medicine directly and always end with "but please consult a doctor before taking." Examples — headache/bukhar: "Paracetamol 500mg le sakte hain, par doctor se zaroor poochh lein." Acidity: "Digene ya Gelusil le sakte hain, par doctor se confirm kar lein." Cold: "Cetirizine ya D-Cold le sakte hain, par pehle doctor se lein." If symptoms sound serious or emergency-related, skip medicine advice and calmly advise immediate hospital visit.

STYLE: Human-like voice conversation only. Short responses. Warm and professional. No repetition. No AI disclaimers. No robotic wording.

EXAMPLES (match the caller's language exactly):
User in Hindi: "Mujhe kal cardiologist ki appointment chahiye" → "Zaroor, subah ka time chahiye ya shaam ka?"
User in Hindi: "Mere sir me dard hai" → "Paracetamol 500mg le sakte hain, par pehle doctor se zaroor poochh lein."
User in English: "I have fever since yesterday" → "You can take Paracetamol 650mg and rest well, but please consult a doctor before taking."
User in Hindi: "Emergency ward open hai?" → "Haan, hamare emergency services 24 ghante, saat din uplabdh hain."`;

const GEMMA_BACKEND_URL = process.env.GEMMA_BACKEND_URL?.trim() ?? '';

const RETRYABLE_STATUS = new Set([502, 503, 504]);

async function withRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 1500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      if (axios.isAxiosError(err) && RETRYABLE_STATUS.has(err.response?.status ?? 0) && i < attempts - 1) {
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

function withRag(userText: string, ragContext: string): string {
  if (!ragContext.trim()) return userText;
  return `[Relevant knowledge base context — use this to answer accurately, do not mention the source]\n${ragContext}\n\n[User question]\n${userText}`;
}

async function callGemmaServer(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  ragContext = '',
  numGpu?: number,
  temperature?: number,
): Promise<string> {
  const url = `${GEMMA_BACKEND_URL}/api/chat`;
  const apiKey = process.env.GEMMA_BACKEND_API_KEY ?? '';
  const finalSystemPrompt = customSystemPrompt?.trim() || SYSTEM_PROMPT;

  logger.info('Gemma server payload', {
    url,
    custom: Boolean(customSystemPrompt?.trim()),
    systemPreview: finalSystemPrompt.slice(0, 120),
    historyLen: history.length,
  });

  const { data } = await axios.post<{ reply: string }>(
    url,
    {
      message: withRag(userText, ragContext),
      systemPrompt: finalSystemPrompt,
      history: history.slice(-4).map((m) => ({ role: m.role, text: m.text })),
      ...(numGpu !== undefined ? { numGpu } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: 120_000,
    },
  );

  const reply = (data.reply ?? '')
    .replace(/[*_`#>]/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
  if (!reply) throw new Error('Empty reply from Gemma server');
  return reply;
}

function groqApiKey(): string {
  const key = process.env.GROQ_API_KEY?.trim() ?? process.env.GEMMA_API_KEY?.trim() ?? '';
  if (!key) throw new Error('Groq API key not configured — set GROQ_API_KEY in .env');
  return key;
}

async function callGroq(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  modelOverride?: string,
  ragContext = '',
): Promise<string> {
  const model = modelOverride ?? process.env.GEMMA_MODEL ?? 'llama-3.1-8b-instant';
  const apiKey = groqApiKey();

  const messages = [
    { role: 'system', content: customSystemPrompt?.trim() || SYSTEM_PROMPT },
    ...history.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    })),
    { role: 'user', content: withRag(userText, ragContext) },
  ];

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 256 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body}`);
  }
  const data = await res.json() as { choices: { message: { content: string } }[] };

  const raw = data.choices?.[0]?.message?.content ?? '';
  if (!raw) throw new Error('Empty Groq response');

  return raw
    .replace(/[*_`#>]/g, '')
    .replace(/\n{2,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

export type AiProvider = 'local' | 'groq';

export interface AiChoice {
  provider: AiProvider;
  model?: string;
  numGpu?: number;
  temperature?: number;
}

// ── Streaming generators ──────────────────────────────────────────────────────

async function* streamFromGemmaServer(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  ragContext = '',
  numGpu?: number,
  temperature?: number,
): AsyncGenerator<string> {
  const url = `${GEMMA_BACKEND_URL}/api/chat/stream`;
  const apiKey = process.env.GEMMA_BACKEND_API_KEY ?? '';
  const finalSystemPrompt = customSystemPrompt?.trim() || SYSTEM_PROMPT;

  const response = await axios.post(
    url,
    {
      message: withRag(userText, ragContext),
      systemPrompt: finalSystemPrompt,
      history: history.slice(-4).map((m) => ({ role: m.role, text: m.text })),
      ...(numGpu !== undefined ? { numGpu } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
    },
    {
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      responseType: 'stream',
      timeout: 120_000,
    },
  );

  let buf = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for await (const chunk of response.data as AsyncIterable<any>) {
    buf += (chunk as Buffer).toString();
    const blocks = buf.split('\n\n');
    buf = blocks.pop() ?? '';
    for (const block of blocks) {
      const line = block.trim();
      if (!line.startsWith('data: ')) continue;
      const raw = line.slice(6).trim();
      if (raw === '[DONE]') return;
      try {
        const { token, error } = JSON.parse(raw) as { token?: string; error?: string };
        if (error) throw new Error(error);
        if (token) yield token;
      } catch { /* skip malformed */ }
    }
  }
}

async function* streamFromGroq(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  modelOverride?: string,
  ragContext = '',
): AsyncGenerator<string> {
  const model = modelOverride ?? process.env.GEMMA_MODEL ?? 'llama-3.1-8b-instant';
  const apiKey = groqApiKey();

  const messages = [
    { role: 'system', content: customSystemPrompt?.trim() || SYSTEM_PROMPT },
    ...history.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    })),
    { role: 'user', content: withRag(userText, ragContext) },
  ];

  const res = await fetch(`${GROQ_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 256, stream: true }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${body}`);
  }

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') return;
        try {
          const parsed = JSON.parse(raw) as { choices?: { delta?: { content?: string } }[] };
          const token = parsed.choices?.[0]?.delta?.content ?? '';
          if (token) yield token;
        } catch { /* skip malformed chunk */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* streamChatWithGemma(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  aiChoice?: AiChoice,
  ragContext = '',
): AsyncGenerator<string> {
  if (aiChoice?.provider === 'local' || (!aiChoice && GEMMA_BACKEND_URL)) {
    if (!GEMMA_BACKEND_URL) throw new AppError('Local Gemma is not configured.', 503);
    yield* streamFromGemmaServer(userText, history, customSystemPrompt, ragContext, aiChoice?.numGpu, aiChoice?.temperature);
    return;
  }
  yield* streamFromGroq(userText, history, customSystemPrompt, aiChoice?.model, ragContext);
}

export async function chatWithGemma(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  aiChoice?: AiChoice,
  ragContext = '',
): Promise<string> {
  try {
    if (aiChoice) {
      if (aiChoice.provider === 'local') {
        if (!GEMMA_BACKEND_URL) {
          throw new AppError('Local Gemma is not configured — set GEMMA_BACKEND_URL on the server.', 503);
        }
        logger.debug('Using local Gemma server: ' + GEMMA_BACKEND_URL + (aiChoice.numGpu !== undefined ? ` · numGpu=${aiChoice.numGpu}` : '') + (aiChoice.temperature !== undefined ? ` · temp=${aiChoice.temperature}` : ''));
        return await withRetry(() => callGemmaServer(userText, history, customSystemPrompt, ragContext, aiChoice.numGpu, aiChoice.temperature));
      }
      logger.debug('Using Groq model: ' + (aiChoice.model ?? 'default'));
      return await callGroq(userText, history, customSystemPrompt, aiChoice.model, ragContext);
    }

    if (GEMMA_BACKEND_URL) {
      logger.debug('Using deployed Gemma server: ' + GEMMA_BACKEND_URL);
      return await withRetry(() => callGemmaServer(userText, history, customSystemPrompt, ragContext));
    }
    return await callGroq(userText, history, customSystemPrompt, undefined, ragContext);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Inference error', { msg });
    throw new AppError(`AI response failed: ${msg}`, 502);
  }
}
