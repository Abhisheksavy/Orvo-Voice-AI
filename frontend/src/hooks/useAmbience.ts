import { useCallback, useEffect, useRef } from 'react';

export type AmbienceMode = 'none' | 'hospital';

interface UseAmbienceReturn {
  start: (mode: AmbienceMode) => void;
  stop: () => void;
  setMode: (mode: AmbienceMode) => void;
  /** Subtly boost ambience while AI is talking (so it reads as the AI's environment). */
  setSpeaking: (speaking: boolean) => void;
}

// Master mix — kept low so the ambience sits *behind* the AI voice.
const IDLE_GAIN = 0.04;
const SPEAKING_GAIN = 0.06;

// Per-layer gains (relative to master).
const HVAC_GAIN = 0.40;        // low room rumble (HVAC / AC)
const ROOM_TONE_GAIN = 0.25;   // mid-band hush — ambient hum
const CHATTER_NEAR_GAIN = 0.38; // nearby reception desk voices
const CHATTER_MID_GAIN  = 0.30; // mid-distance conversations
const CHATTER_FAR_GAIN  = 0.20; // far background murmur

/**
 * Layered, self-contained local-hospital ambience.
 *   • HVAC rumble (constant)
 *   • Room tone (mid noise, gently modulated)
 *   • Distant chatter (band-pass + slow swell)
 *   • Primary heart monitor (~76 BPM)
 *   • Secondary monitor (~64 BPM, detuned)
 *   • Random 2-tone page beeps every 8–22 s
 */
export function useAmbience(): UseAmbienceReturn {
  const ctxRef = useRef<AudioContext | null>(null);
  const masterRef = useRef<GainNode | null>(null);
  const stopFnsRef = useRef<Array<() => void>>([]);
  const modeRef = useRef<AmbienceMode>('none');
  const speakingRef = useRef(false);

  const teardown = useCallback(() => {
    stopFnsRef.current.forEach((fn) => { try { fn(); } catch { /* noop */ } });
    stopFnsRef.current = [];
    try { masterRef.current?.disconnect(); } catch { /* noop */ }
    masterRef.current = null;
    void ctxRef.current?.close().catch(() => undefined);
    ctxRef.current = null;
  }, []);

  const buildHospital = useCallback(() => {
    teardown();
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    ctxRef.current = ctx;

    const master = ctx.createGain();
    master.gain.value = speakingRef.current ? SPEAKING_GAIN : IDLE_GAIN;
    master.connect(ctx.destination);
    masterRef.current = master;
    const sr = ctx.sampleRate;

    const makeNoiseBuffer = (seconds: number) => {
      const buf = ctx.createBuffer(1, Math.floor(sr * seconds), sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return buf;
    };

    // ── Layer 1: HVAC rumble (brown noise, low-passed) ─────────────────────
    {
      const buf = ctx.createBuffer(1, Math.floor(sr * 2), sr);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.015 * w) / 1.015;
        d[i] = last * 3.0;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 180; lp.Q.value = 0.6;

      const g = ctx.createGain(); g.gain.value = HVAC_GAIN;

      src.connect(lp); lp.connect(g); g.connect(master);
      src.start();
      stopFnsRef.current.push(() => { try { src.stop(); } catch { /* noop */ } });
    }

    // ── Layer 2: Room tone (mid band-pass, gentle LFO) ─────────────────────
    {
      const src = ctx.createBufferSource();
      src.buffer = makeNoiseBuffer(3); src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 0.8;

      const g = ctx.createGain(); g.gain.value = ROOM_TONE_GAIN;

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 0.07;
      lfoGain.gain.value = ROOM_TONE_GAIN * 0.35;
      lfo.connect(lfoGain); lfoGain.connect(g.gain);

      src.connect(bp); bp.connect(g); g.connect(master);
      src.start(); lfo.start();
      stopFnsRef.current.push(() => { try { src.stop(); } catch { /* noop */ } try { lfo.stop(); } catch { /* noop */ } });
    }

    // ── Layer 3a: Near chatter — reception desk voices ─────────────────────
    // Bandpass around speech fundamentals (200–900 Hz) + presence band,
    // with a medium-speed swell simulating someone speaking nearby.
    {
      const src = ctx.createBufferSource();
      src.buffer = makeNoiseBuffer(5); src.loop = true;

      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 220; hp.Q.value = 0.5;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2400; lp.Q.value = 0.6;

      const g = ctx.createGain(); g.gain.value = CHATTER_NEAR_GAIN * 0.5;

      // Swell: 0.09 Hz — sounds like someone talking in short bursts
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.frequency.value = 0.09;
      lfoGain.gain.value = CHATTER_NEAR_GAIN * 0.5;
      lfo.connect(lfoGain); lfoGain.connect(g.gain);

      src.connect(hp); hp.connect(bp); bp.connect(lp); lp.connect(g); g.connect(master);
      src.start(); lfo.start();
      stopFnsRef.current.push(() => { try { src.stop(); } catch { /* noop */ } try { lfo.stop(); } catch { /* noop */ } });
    }

    // ── Layer 3b: Mid-distance voices — waiting area ───────────────────────
    // Different frequency band + slightly faster swell for a second "voice"
    {
      const src = ctx.createBufferSource();
      src.buffer = makeNoiseBuffer(6); src.loop = true;

      const bp1 = ctx.createBiquadFilter();
      bp1.type = 'bandpass'; bp1.frequency.value = 600; bp1.Q.value = 1.0;

      const bp2 = ctx.createBiquadFilter();
      bp2.type = 'bandpass'; bp2.frequency.value = 1400; bp2.Q.value = 1.5;

      const g = ctx.createGain(); g.gain.value = CHATTER_MID_GAIN * 0.45;

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.frequency.value = 0.13;
      // Phase-offset so this voice peaks when the near voice dips
      lfo.connect(lfoGain); lfoGain.connect(g.gain);
      lfoGain.gain.value = CHATTER_MID_GAIN * 0.45;

      src.connect(bp1); bp1.connect(bp2); bp2.connect(g); g.connect(master);
      src.start(); lfo.start();
      stopFnsRef.current.push(() => { try { src.stop(); } catch { /* noop */ } try { lfo.stop(); } catch { /* noop */ } });
    }

    // ── Layer 3c: Far background murmur — corridor / hall ─────────────────
    // Low-frequency murmur, very slow undulation — constant crowd feel
    {
      const src = ctx.createBufferSource();
      src.buffer = makeNoiseBuffer(4); src.loop = true;

      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = 500; bp.Q.value = 0.7;

      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 1000; lp.Q.value = 0.5;

      const g = ctx.createGain(); g.gain.value = CHATTER_FAR_GAIN * 0.6;

      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.type = 'sine'; lfo.frequency.value = 0.05; // very slow — crowd hum
      lfoGain.gain.value = CHATTER_FAR_GAIN * 0.4;
      lfo.connect(lfoGain); lfoGain.connect(g.gain);

      src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(master);
      src.start(); lfo.start();
      stopFnsRef.current.push(() => { try { src.stop(); } catch { /* noop */ } try { lfo.stop(); } catch { /* noop */ } });
    }
  }, [teardown]);

  const start = useCallback((mode: AmbienceMode) => {
    modeRef.current = mode;
    if (mode === 'hospital') buildHospital();
    else teardown();
  }, [buildHospital, teardown]);

  const stop = useCallback(() => {
    modeRef.current = 'none';
    teardown();
  }, [teardown]);

  const setMode = useCallback((mode: AmbienceMode) => {
    if (mode === modeRef.current) return;
    modeRef.current = mode;
    if (mode === 'hospital') buildHospital();
    else teardown();
  }, [buildHospital, teardown]);

  const setSpeaking = useCallback((speaking: boolean) => {
    speakingRef.current = speaking;
    const ctx = ctxRef.current;
    const gain = masterRef.current;
    if (!ctx || !gain) return;
    const target = speaking ? SPEAKING_GAIN : IDLE_GAIN;
    try {
      gain.gain.cancelScheduledValues(ctx.currentTime);
      gain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.35);
    } catch { /* noop */ }
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  return { start, stop, setMode, setSpeaking };
}
