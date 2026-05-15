import axios from 'axios';
import FormData from 'form-data';
import logger from '../utils/logger';
import { AppError } from '../middleware/errorHandler';
import { convertToWav } from '../utils/convertToWav';

const BASE = 'https://api.sarvam.ai';

export type SarvamLanguage =
  | 'hi-IN' | 'en-IN' | 'bn-IN' | 'gu-IN' | 'kn-IN'
  | 'ml-IN' | 'mr-IN' | 'od-IN' | 'pa-IN' | 'ta-IN' | 'te-IN';

export type SarvamSpeaker =
  | 'anushka' | 'manisha' | 'vidya' | 'arya' | 'priya' | 'neha'
  | 'abhilash' | 'karun' | 'hitesh' | 'rahul' | 'rohan';

/**
 * Transcribe audio buffer → text using Sarvam STT.
 * Sarvam accepts WAV/MP3/OGG/WebM (max 10 MB).
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
  languageCode: SarvamLanguage = 'hi-IN',
): Promise<{ transcript: string; language: string }> {
  const cleanMime = mimeType.split(';')[0].trim();
  const inputExt = cleanMime.split('/')[1] ?? 'webm';

  logger.debug('STT input', { mimeType: cleanMime, inputBytes: audioBuffer.length });

  const wavBuffer = await convertToWav(audioBuffer, inputExt);
  logger.debug('STT wav converted', { wavBytes: wavBuffer.length });

  const form = new FormData();
  form.append('file', wavBuffer, { filename: 'audio.wav', contentType: 'audio/wav' });
  form.append('model', 'saarika:v2.5');
  form.append('with_timestamps', 'false');
  // language_code optional — v2.5 auto-detects; only send if explicitly set
  if (languageCode) form.append('language_code', languageCode);

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
    if (axios.isAxiosError(err)) {
      logger.error('Sarvam STT error', { status: err.response?.status, data: err.response?.data, message: err.message });
    } else {
      logger.error('Sarvam STT error', { err });
    }
    throw new AppError('Speech-to-text failed', 502);
  }
}

/**
 * Convert text → audio (base64 WAV) using Sarvam TTS.
 */
export async function synthesizeSpeech(
  text: string,
  languageCode: SarvamLanguage = 'hi-IN',
  speaker: SarvamSpeaker = 'anushka',
): Promise<Buffer> {
  try {
    const { data } = await axios.post<{ audios: string[] }>(
      `${BASE}/text-to-speech`,
      {
        inputs: [text.slice(0, 500)],
        target_language_code: languageCode,
        speaker,
        model: 'bulbul:v2',
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
    if (axios.isAxiosError(err)) {
      logger.error('Sarvam TTS error', { status: err.response?.status, data: err.response?.data });
    } else {
      logger.error('Sarvam TTS error', { err });
    }
    throw new AppError('Text-to-speech failed', 502);
  }
}
