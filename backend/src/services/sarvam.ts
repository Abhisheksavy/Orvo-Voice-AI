import axios from 'axios';
import FormData from 'form-data';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';

const BASE = 'https://api.sarvam.ai';

export type SarvamLanguage =
  | 'hi-IN' | 'en-IN' | 'bn-IN' | 'gu-IN' | 'kn-IN'
  | 'ml-IN' | 'mr-IN' | 'od-IN' | 'pa-IN' | 'ta-IN' | 'te-IN';

export type SarvamSpeaker =
  | 'meera' | 'pavithra' | 'maitreyi' | 'arvind' | 'amol' | 'amartya';

/**
 * Transcribe audio buffer → text using Sarvam STT.
 * Sarvam accepts WAV/MP3/OGG/WebM (max 10 MB).
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  languageCode: SarvamLanguage = 'hi-IN',
): Promise<{ transcript: string; language: string }> {
  const ext = mimeType.split('/')[1]?.split(';')[0] ?? 'webm';
  const form = new FormData();
  form.append('file', audioBuffer, { filename: `audio.${ext}`, contentType: mimeType });
  form.append('model', 'saarika:v2');
  form.append('language_code', languageCode);
  form.append('with_timestamps', 'false');

  try {
    const { data } = await axios.post<{ transcript: string; language_code: string }>(
      `${BASE}/speech-to-text`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'api-subscription-key': process.env.SARVAM_API_KEY ?? '',
        },
        timeout: 30_000,
      },
    );
    logger.debug('Sarvam STT success', { transcript: data.transcript?.slice(0, 80) });
    return { transcript: data.transcript, language: data.language_code };
  } catch (err) {
    logger.error('Sarvam STT error', { err });
    throw new AppError('Speech-to-text failed', 502);
  }
}

/**
 * Convert text → audio (base64 WAV) using Sarvam TTS.
 */
export async function synthesizeSpeech(
  text: string,
  languageCode: SarvamLanguage = 'hi-IN',
  speaker: SarvamSpeaker = 'meera',
): Promise<Buffer> {
  try {
    const { data } = await axios.post<{ audios: string[] }>(
      `${BASE}/text-to-speech`,
      {
        inputs: [text.slice(0, 500)],
        target_language_code: languageCode,
        speaker,
        model: 'bulbul:v1',
        enable_preprocessing: true,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'api-subscription-key': process.env.SARVAM_API_KEY ?? '',
        },
        timeout: 30_000,
      },
    );
    const b64 = data.audios?.[0];
    if (!b64) throw new Error('Empty TTS response');
    logger.debug('Sarvam TTS success', { chars: text.length });
    return Buffer.from(b64, 'base64');
  } catch (err) {
    logger.error('Sarvam TTS error', { err });
    throw new AppError('Text-to-speech failed', 502);
  }
}
