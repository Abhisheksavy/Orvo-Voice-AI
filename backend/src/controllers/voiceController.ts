import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Conversation from '../models/Conversation';
import { transcribeAudio, synthesizeSpeech, type SarvamLanguage } from '../services/sarvam';
import { chatWithGemma } from '../services/gemma';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

/**
 * POST /api/voice/session
 * Create or return an existing session.
 */
export async function createSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = (req.body as { sessionId?: string }).sessionId ?? uuidv4();
    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) {
      conversation = await Conversation.create({ sessionId, messages: [], languageCode: 'hi-IN' });
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

    const { sessionId, languageCode = 'hi-IN', systemPrompt } = req.body as {
      sessionId?: string;
      languageCode?: string;
      systemPrompt?: string;
    };
    if (!sessionId) throw new AppError('sessionId is required', 400);

    const lang = languageCode as SarvamLanguage;

    // 1. STT
    const { transcript } = await transcribeAudio(file.buffer, file.mimetype, lang);
    if (!transcript?.trim()) throw new AppError('Could not understand audio', 422);
    logger.info('STT done', { sessionId, transcript: transcript.slice(0, 80) });

    // 2. Load history + call LLM
    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) {
      conversation = await Conversation.create({ sessionId, messages: [], languageCode: lang });
    }

    const assistantText = await chatWithGemma(transcript, conversation.messages, systemPrompt);
    logger.info('LLM done', { sessionId, preview: assistantText.slice(0, 80) });

    // 3. TTS
    const audioBuffer = await synthesizeSpeech(assistantText, lang);
    const audioBase64 = audioBuffer.toString('base64');

    // 4. Persist messages
    conversation.messages.push(
      { role: 'user', text: transcript, createdAt: new Date() },
      { role: 'assistant', text: assistantText, createdAt: new Date() },
    );
    await conversation.save();

    res.json({
      success: true,
      data: {
        userText: transcript,
        assistantText,
        audioBase64,
        audioMimeType: 'audio/wav',
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
    const { sessionId, text, languageCode = 'hi-IN', systemPrompt } = req.body as {
      sessionId?: string;
      text?: string;
      languageCode?: string;
      systemPrompt?: string;
    };
    if (!sessionId) throw new AppError('sessionId is required', 400);
    if (!text?.trim()) throw new AppError('text is required', 400);

    const lang = languageCode as SarvamLanguage;

    let conversation = await Conversation.findOne({ sessionId });
    if (!conversation) {
      conversation = await Conversation.create({ sessionId, messages: [], languageCode: lang });
    }

    const assistantText = await chatWithGemma(text.trim(), conversation.messages, systemPrompt);
    const audioBuffer = await synthesizeSpeech(assistantText, lang);

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
        audioBase64: audioBuffer.toString('base64'),
        audioMimeType: 'audio/wav',
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
