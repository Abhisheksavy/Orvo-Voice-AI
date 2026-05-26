import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Conversation from '../models/Conversation';
import { transcribeAudio, synthesizeSpeech, type SarvamLanguage } from '../services/sarvam';
import { chatWithGemma, streamChatWithGemma, type AiChoice, type AiProvider } from '../services/gemma';
import { retrieveContext } from '../services/rag';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

function parseAiChoice(provider?: string, model?: string, numGpu?: number, temperature?: number): AiChoice | undefined {
  if (provider !== 'local' && provider !== 'groq') return undefined;
  return { provider: provider as AiProvider, model: model?.trim() || undefined, numGpu, temperature };
}

const LANG_NAMES: Record<string, string> = {
  'hi-IN': 'Hindi', 'en-IN': 'English', 'bn-IN': 'Bengali', 'gu-IN': 'Gujarati',
  'kn-IN': 'Kannada', 'ml-IN': 'Malayalam', 'mr-IN': 'Marathi', 'od-IN': 'Odia',
  'pa-IN': 'Punjabi', 'ta-IN': 'Tamil', 'te-IN': 'Telugu',
};

// Injects a language directive so the LLM reliably responds in the user's language.
// Small models often ignore system-prompt language instructions; inline hints are far more effective.
function withLangHint(text: string, langCode: string): string {
  const name = LANG_NAMES[langCode];
  if (!name || langCode === 'en-IN') return text;
  return `${text}\n[Respond ONLY in ${name}]`;
}

/**
 * POST /api/voice/session
 * Create or return an existing session.
 */
export async function createSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = (req.body as { sessionId?: string }).sessionId ?? uuidv4();
    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) {
      conversation = await Conversation.create({ sessionId, messages: [], languageCode: 'en-IN' });
    }
    res.json({ success: true, data: { sessionId: conversation.sessionId, messageCount: conversation.messages.length } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/voice/chat
 * Accepts: multipart/form-data — audio file + sessionId + optional languageCode
 * Returns: JSON { userText, assistantText, audioBase64 }
 */
export async function voiceChat(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = req.file;
    if (!file) throw new AppError('Audio file is required', 400);

    const { sessionId, languageCode = 'hi-IN', systemPrompt, aiProvider, aiModel, numGpu, temperature } = req.body as {
      sessionId?: string;
      languageCode?: string;
      systemPrompt?: string;
      aiProvider?: string;
      aiModel?: string;
      numGpu?: string;
      temperature?: string;
    };
    if (!sessionId) throw new AppError('sessionId is required', 400);

    const lang = languageCode as SarvamLanguage;
    const aiChoice = parseAiChoice(aiProvider, aiModel, numGpu !== undefined ? Number(numGpu) : undefined, temperature !== undefined ? Number(temperature) : undefined);
    const t0 = Date.now();
    const ms = (since: number) => `${Date.now() - since}ms`;

    // 1. STT
    const t_stt = Date.now();
    const { transcript, language: detectedLang } = await transcribeAudio(file.buffer, file.mimetype, lang);
    const sttMs = Date.now() - t_stt;
    // Auto-switch TTS language to match what the user actually spoke
    const ttsLang = (detectedLang as SarvamLanguage) || lang;
    logger.info(`[TIMING] STT: ${sttMs}ms detectedLang=${ttsLang}`, { sessionId });
    if (!transcript?.trim()) {
      logger.info('STT empty transcript — likely noise, ignoring', { sessionId });
      res.json({ success: true, data: { empty: true } });
      return;
    }

    // 2. Load history + RAG retrieval (parallel)
    const t_rag = Date.now();
    const [conversation, ragContext] = await Promise.all([
      Conversation.findOne({ sessionId }).then(async (c) =>
        c ?? Conversation.create({ sessionId, messages: [], languageCode: ttsLang }),
      ),
      retrieveContext(transcript),
    ]);
    const ragMs = Date.now() - t_rag;
    logger.info(`[TIMING] RAG+DB: ${ragMs}ms`, { sessionId, hasRag: !!ragContext });

    // 3. LLM — inject language hint so model responds in the user's language
    const t_llm = Date.now();
    const assistantText = await chatWithGemma(withLangHint(transcript, ttsLang), conversation.messages, systemPrompt, aiChoice, ragContext);
    const llmMs = Date.now() - t_llm;
    logger.info(`[TIMING] LLM: ${llmMs}ms | model=${aiChoice?.provider ?? 'default'} numGpu=${aiChoice?.numGpu ?? 99}`, { sessionId });

    // 4. TTS — use detected language so voice matches what the user spoke
    const t_tts = Date.now();
    const audioBuffer = await synthesizeSpeech(assistantText, ttsLang);
    const audioBase64 = audioBuffer.toString('base64');
    const ttsMs = Date.now() - t_tts;
    logger.info(`[TIMING] TTS: ${ttsMs}ms`, { sessionId });

    // 5. Persist messages
    conversation.messages.push(
      { role: 'user', text: transcript, createdAt: new Date() },
      { role: 'assistant', text: assistantText, createdAt: new Date() },
    );
    await conversation.save();

    const totalMs = Date.now() - t0;
    logger.info(`[TIMING] TOTAL: ${totalMs}ms`, { sessionId });

    res.json({
      success: true,
      data: {
        userText: transcript,
        assistantText,
        audioBase64,
        audioMimeType: 'audio/wav',
        _timing: { sttMs, ragMs, llmMs, ttsMs, totalMs },
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/voice/history/:sessionId
 * Returns full conversation history for a session.
 */
export async function getHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { sessionId } = req.params;
    const conversation = await Conversation.findOne({ sessionId });
    if (!conversation) throw new AppError('Session not found', 404);
    res.json({ success: true, data: { sessionId, messages: conversation.messages } });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/voice/chat-text
 * Text-only chat — skips STT, goes straight to LLM + TTS.
 */
export async function textChat(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { sessionId, text, languageCode = 'hi-IN', systemPrompt, aiProvider, aiModel, numGpu, temperature, skipTts } = req.body as {
      sessionId?: string;
      text?: string;
      languageCode?: string;
      systemPrompt?: string;
      aiProvider?: string;
      aiModel?: string;
      numGpu?: number;
      temperature?: number;
      skipTts?: boolean;
    };
    if (!sessionId) throw new AppError('sessionId is required', 400);
    if (!text?.trim()) throw new AppError('text is required', 400);

    const lang = languageCode as SarvamLanguage;
    const aiChoice = parseAiChoice(aiProvider, aiModel, numGpu, temperature);
    const t0 = Date.now();
    const ms = (since: number) => `${Date.now() - since}ms`;

    const t_rag = Date.now();
    const [conversation, ragContext] = await Promise.all([
      Conversation.findOne({ sessionId }).then(async (c) =>
        c ?? Conversation.create({ sessionId, messages: [], languageCode: lang }),
      ),
      retrieveContext(text.trim()),
    ]);
    logger.info(`[TIMING] RAG+DB: ${ms(t_rag)}`, { sessionId, hasRag: !!ragContext });

    const t_llm = Date.now();
    const assistantText = await chatWithGemma(text.trim(), conversation.messages, systemPrompt, aiChoice, ragContext);
    logger.info(`[TIMING] LLM: ${ms(t_llm)} | model=${aiChoice?.provider ?? 'default'} numGpu=${aiChoice?.numGpu ?? 99}`, { sessionId });

    let audioBase64 = '';
    let audioMimeType = '';
    if (!skipTts) {
      const t_tts = Date.now();
      const audioBuffer = await synthesizeSpeech(assistantText, lang);
      audioBase64 = audioBuffer.toString('base64');
      audioMimeType = 'audio/wav';
      logger.info(`[TIMING] TTS: ${ms(t_tts)}`, { sessionId });
    }

    logger.info(`[TIMING] TOTAL: ${ms(t0)}`, { sessionId });

    conversation.messages.push(
      { role: 'user', text: text.trim(), createdAt: new Date() },
      { role: 'assistant', text: assistantText, createdAt: new Date() },
    );
    await conversation.save();

    res.json({
      success: true,
      data: {
        userText: text.trim(),
        assistantText,
        audioBase64,
        audioMimeType,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/voice/history/:sessionId
 * Clear conversation history (keep session alive).
 */
export async function clearHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { sessionId } = req.params;
    await Conversation.findOneAndUpdate({ sessionId }, { $set: { messages: [] } });
    res.json({ success: true, data: { cleared: true } });
  } catch (err) {
    next(err);
  }
}

// Sentence boundary: punctuation followed by space/end, or newlines.
const SENTENCE_RE = /[.!?।]+(?=\s|$)/;

/**
 * POST /api/voice/chat-stream
 * SSE endpoint: STT → streaming LLM → TTS per sentence → stream audio chunks.
 * Cuts perceived latency from ~3.5s to ~1s (first audio plays as soon as first sentence is ready).
 */
export async function voiceChatStream(req: Request, res: Response): Promise<void> {
  const sendEvent = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const file = req.file;
    if (!file) { sendEvent({ type: 'error', message: 'Audio file required' }); res.end(); return; }

    const { sessionId, languageCode = 'en-IN', systemPrompt, aiProvider, aiModel, numGpu, temperature } = req.body as {
      sessionId?: string; languageCode?: string; systemPrompt?: string;
      aiProvider?: string; aiModel?: string; numGpu?: string; temperature?: string;
    };
    if (!sessionId) { sendEvent({ type: 'error', message: 'sessionId required' }); res.end(); return; }

    const lang = languageCode as SarvamLanguage;
    const aiChoice = parseAiChoice(aiProvider, aiModel, numGpu !== undefined ? Number(numGpu) : undefined, temperature !== undefined ? Number(temperature) : undefined);
    const t0 = Date.now();

    // 1. STT
    const { transcript, language: detectedLang } = await transcribeAudio(file.buffer, file.mimetype, lang);
    if (!transcript?.trim()) { sendEvent({ type: 'empty' }); res.end(); return; }
    // Auto-switch TTS language to match what the user actually spoke
    const ttsLang = (detectedLang as SarvamLanguage) || lang;
    sendEvent({ type: 'transcript', text: transcript, sttMs: Date.now() - t0 });

    // 2. Conversation + RAG (parallel)
    const [conversation, ragContext] = await Promise.all([
      Conversation.findOne({ sessionId }).then(async (c) =>
        c ?? Conversation.create({ sessionId, messages: [], languageCode: ttsLang }),
      ),
      retrieveContext(transcript),
    ]);

    // 3. Stream LLM + pipeline TTS per sentence
    //    TTS calls run in parallel; audio events are sent in arrival order via the chain.
    let fullText = '';
    let buffer = '';
    let ttsChain = Promise.resolve(); // ensures ordered audio delivery
    const t_llm = Date.now();

    const queueSentence = (sentence: string) => {
      const clean = sentence.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
      if (!clean || clean.length < 4) return;
      const ttsP = synthesizeSpeech(clean, ttsLang); // fire with detected language
      ttsChain = ttsChain.then(async () => {
        try {
          const audioBuffer = await ttsP;
          sendEvent({ type: 'audio', text: clean, audioBase64: audioBuffer.toString('base64'), audioMimeType: 'audio/wav' });
        } catch {
          // TTS for one sentence failed — skip it, don't abort the whole stream
        }
      });
    };

    for await (const token of streamChatWithGemma(withLangHint(transcript, ttsLang), conversation.messages, systemPrompt, aiChoice, ragContext)) {
      buffer += token;
      fullText += token;

      // Look for a sentence boundary
      const m = SENTENCE_RE.exec(buffer);
      if (m) {
        const end = m.index + m[0].length;
        const sentence = buffer.slice(0, end);
        buffer = buffer.slice(end).trimStart();
        queueSentence(sentence);
      }
    }

    // Flush any remaining text (no terminal punctuation)
    if (buffer.trim()) queueSentence(buffer.trim());

    // Wait for all TTS to deliver before signalling done
    await ttsChain;

    const totalMs = Date.now() - t0;
    sendEvent({ type: 'done', assistantText: fullText.trim(), llmMs: Date.now() - t_llm, totalMs });

    // 4. Persist
    conversation.messages.push(
      { role: 'user', text: transcript, createdAt: new Date() },
      { role: 'assistant', text: fullText.trim(), createdAt: new Date() },
    );
    await conversation.save();
  } catch (err) {
    logger.error('voiceChatStream error', { err });
    sendEvent({ type: 'error', message: err instanceof Error ? err.message : 'Stream failed' });
  } finally {
    if (!res.writableEnded) res.end();
  }
}
