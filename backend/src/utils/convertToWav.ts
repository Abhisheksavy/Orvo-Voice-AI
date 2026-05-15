import ffmpeg from 'fluent-ffmpeg';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * Convert any audio buffer (webm/ogg/mp3/etc) → 16kHz mono WAV
 * which Sarvam STT transcribes reliably.
 */
export async function convertToWav(inputBuffer: Buffer, inputExt: string): Promise<Buffer> {
  const tmpIn  = path.join(os.tmpdir(), `orvo-in-${Date.now()}.${inputExt}`);
  const tmpOut = path.join(os.tmpdir(), `orvo-out-${Date.now()}.wav`);

  await fs.writeFile(tmpIn, inputBuffer);

  await new Promise<void>((resolve, reject) => {
    ffmpeg(tmpIn)
      .audioChannels(1)
      .audioFrequency(16000)
      .audioCodec('pcm_s16le')
      .audioFilters('loudnorm=I=-16:TP=-1.5:LRA=11')  // normalize to -16 LUFS
      .format('wav')
      .on('error', (err: Error) => reject(err))
      .on('end', () => resolve())
      .save(tmpOut);
  });

  const wavBuffer = await fs.readFile(tmpOut);
  // DEBUG: keep last wav for inspection
  await fs.copyFile(tmpOut, '/tmp/orvo-last.wav').catch(() => undefined);
  await Promise.all([fs.unlink(tmpIn), fs.unlink(tmpOut)]).catch(() => undefined);
  return wavBuffer;
}
