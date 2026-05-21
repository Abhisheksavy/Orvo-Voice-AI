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

function withRag(userText: string, ragContext: string): string {
  if (!ragContext.trim()) return userText;
  return `[Relevant knowledge base context — use this to answer accurately, do not mention the source]\n${ragContext}\n\n[User question]\n${userText}`;
}

async function callGemmaServer(
  userText: string,
  history: IMessage[],
  customSystemPrompt?: string,
  ragContext = '',
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
  modelOverride?: string,
  ragContext = '',
): Promise<string> {
  const model = modelOverride ?? process.env.GEMMA_MODEL ?? 'llama-3.1-8b-instant';
  const apiKey = process.env.GEMMA_API_KEY ?? '';

  const messages = [
    { role: 'system', content: customSystemPrompt?.trim() || SYSTEM_PROMPT },
    ...history.slice(-10).map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.text,
    })),
    { role: 'user', content: withRag(userText, ragContext) },
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

export type AiProvider = 'local' | 'groq';

export interface AiChoice {
  provider: AiProvider;
  model?: string;
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
        logger.debug('Using local Gemma server: ' + GEMMA_BACKEND_URL);
        return await callGemmaServer(userText, history, customSystemPrompt, ragContext);
      }
      logger.debug('Using Groq model: ' + (aiChoice.model ?? 'default'));
      return await callGroq(userText, history, customSystemPrompt, aiChoice.model, ragContext);
    }

    if (GEMMA_BACKEND_URL) {
      logger.debug('Using deployed Gemma server: ' + GEMMA_BACKEND_URL);
      return await callGemmaServer(userText, history, customSystemPrompt, ragContext);
    }
    return await callGroq(userText, history, customSystemPrompt, undefined, ragContext);
  } catch (err) {
    if (axios.isAxiosError(err)) {
      logger.error('Inference error', { status: err.response?.status, data: JSON.stringify(err.response?.data) });
    } else {
      logger.error('Inference error', { err });
    }
    throw new AppError('AI response failed', 502);
  }
}
