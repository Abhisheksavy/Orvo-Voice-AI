import { useCallback, useEffect, useRef } from 'react';

interface UseCallRecorderOpts {
  onSpeechStart?: () => void;
  onSpeechEnd?: (blob: Blob) => void;
  onError?: (err: string) => void;
  /** Multiplier applied to speech threshold while AI is playing (helps ignore self) */
  playbackThresholdMultiplier?: number;
}

interface UseCallRecorderReturn {
  start: () => Promise<void>;
  stop: () => void;
  /** Tell the VAD that AI playback is active so it ignores quieter sounds */
  setPlaybackActive: (active: boolean) => void;
  /** Pause speech-end emissions (e.g. while waiting for backend) but keep mic open */
  setMuted: (muted: boolean) => void;
}

const BASE_SPEECH_THRESHOLD = 0.020;
const SILENCE_MS = 650;
const MIN_SPEECH_MS = 250;
// Used to detect interruption — needs only a short burst (~100ms) to fire,
// so we react quickly when the user starts talking over the AI.
const INTERRUPT_TRIGGER_MS = 90;

export function useCallRecorder(opts: UseCallRecorderOpts = {}): UseCallRecorderReturn {
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const rafRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const speakingRef = useRef(false);
  const speechStartAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const mimeTypeRef = useRef('audio/webm');
  const playbackActiveRef = useRef(false);
  const mutedRef = useRef(false);

  const onSpeechStartRef = useRef(opts.onSpeechStart);
  const onSpeechEndRef = useRef(opts.onSpeechEnd);
  const onErrorRef = useRef(opts.onError);
  // Lower multiplier = easier to interrupt while AI is speaking.
  // Browser echoCancellation strips most of the AI's own voice, so 1.3 is safe.
  const playbackMultRef = useRef(opts.playbackThresholdMultiplier ?? 1.3);
  const voiceStreakRef = useRef(0);

  useEffect(() => { onSpeechStartRef.current = opts.onSpeechStart; }, [opts.onSpeechStart]);
  useEffect(() => { onSpeechEndRef.current = opts.onSpeechEnd; }, [opts.onSpeechEnd]);
  useEffect(() => { onErrorRef.current = opts.onError; }, [opts.onError]);
  useEffect(() => { playbackMultRef.current = opts.playbackThresholdMultiplier ?? 1.3; }, [opts.playbackThresholdMultiplier]);

  const startUtterance = useCallback(() => {
    const stream = streamRef.current;
    if (!stream) return;
    if (recorderRef.current && recorderRef.current.state === 'recording') return;
    try {
      const recorder = new MediaRecorder(stream, { mimeType: mimeTypeRef.current });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorderRef.current = recorder;
      recorder.start(100);
    } catch {
      // ignore
    }
  }, []);

  const endUtterance = useCallback((): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const recorder = recorderRef.current;
      if (!recorder || recorder.state === 'inactive') {
        resolve(null);
        return;
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeTypeRef.current });
        chunksRef.current = [];
        resolve(blob);
      };
      try {
        recorder.stop();
      } catch {
        resolve(null);
      }
    });
  }, []);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      sourceRef.current = source;
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      analyserRef.current = analyser;
      source.connect(analyser);

      mimeTypeRef.current = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/ogg';

      runningRef.current = true;
      const buf = new Float32Array(analyser.fftSize);

      const tick = () => {
        if (!runningRef.current || !analyserRef.current) return;
        analyserRef.current.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);

        const threshold = BASE_SPEECH_THRESHOLD * (playbackActiveRef.current ? playbackMultRef.current : 1);
        const now = performance.now();

        if (rms > threshold) {
          // Require a short streak above threshold to confirm real speech
          // (prevents single-frame spikes from triggering an interrupt).
          voiceStreakRef.current += 16; // ~one rAF frame
          if (!speakingRef.current && voiceStreakRef.current >= INTERRUPT_TRIGGER_MS) {
            speakingRef.current = true;
            speechStartAtRef.current = now;
            startUtterance();
            onSpeechStartRef.current?.();
          }
          lastVoiceAtRef.current = now;
        } else {
          if (!speakingRef.current) voiceStreakRef.current = 0;
        }
        if (speakingRef.current && rms <= threshold) {
          const silentFor = now - lastVoiceAtRef.current;
          if (silentFor >= SILENCE_MS) {
            const dur = now - speechStartAtRef.current;
            speakingRef.current = false;
            voiceStreakRef.current = 0;
            const blobP = endUtterance();
            if (!mutedRef.current && dur >= MIN_SPEECH_MS) {
              void blobP.then((blob) => { if (blob) onSpeechEndRef.current?.(blob); });
            } else {
              void blobP; // discard
            }
          }
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (err) {
      onErrorRef.current?.(err instanceof Error ? err.message : 'Microphone access denied');
    }
  }, [startUtterance, endUtterance]);

  const stop = useCallback(() => {
    runningRef.current = false;
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    speakingRef.current = false;
    try { recorderRef.current?.stop(); } catch { /* noop */ }
    recorderRef.current = null;
    chunksRef.current = [];
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    try { sourceRef.current?.disconnect(); } catch { /* noop */ }
    sourceRef.current = null;
    analyserRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
  }, []);

  const setPlaybackActive = useCallback((active: boolean) => {
    playbackActiveRef.current = active;
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
  }, []);

  useEffect(() => () => stop(), [stop]);

  return { start, stop, setPlaybackActive, setMuted };
}
