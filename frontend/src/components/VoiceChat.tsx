import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useCallRecorder } from '../hooks/useCallRecorder';
import { useAmbience, type AmbienceMode } from '../hooks/useAmbience';
import { createSession, sendText, sendTextOnly, streamAudioChunks, clearHistory, uploadKnowledgeFile, uploadKnowledgeText, listKnowledgeDocs, deleteKnowledgeDoc, type KnowledgeDoc } from '../api/voice';

const DEFAULT_SYSTEM_PROMPT = `You are Orvo, an AI-powered virtual receptionist for hospitals and healthcare clinics, designed for real-time voice conversations over phone calls.
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

UNKNOWN INFO: If you do not know something, never hallucinate. Say naturally: "Let me quickly check that for you." Then give only a concise spoken response after retrieval — no links, no citations.

STYLE: Human-like voice conversation only. Short responses. Warm and professional. No repetition. No AI disclaimers. No robotic wording.

EXAMPLES (match the caller's language exactly):
User in Hindi: "Mujhe kal cardiologist ki appointment chahiye" → "Zaroor, subah ka time chahiye ya shaam ka?"
User in Hindi: "Mere sir me dard hai" → "Paracetamol 500mg le sakte hain, par pehle doctor se zaroor poochh lein."
User in English: "I have fever since yesterday" → "You can take Paracetamol 650mg and rest well, but please consult a doctor before taking."
User in Hindi: "Emergency ward open hai?" → "Haan, hamare emergency services 24 ghante, saat din uplabdh hain."`;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

type AppState = 'idle' | 'listening' | 'recording' | 'processing' | 'speaking';

const LANGUAGES = [
  { code: 'hi-IN', label: 'हिंदी' },
  { code: 'en-IN', label: 'English' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ' },
  { code: 'bn-IN', label: 'বাংলা' },
  { code: 'ta-IN', label: 'தமிழ்' },
  { code: 'te-IN', label: 'తెలుగు' },
  { code: 'mr-IN', label: 'मराठी' },
  { code: 'gu-IN', label: 'ગુજરાતી' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ' },
];

interface ModelOption {
  id: string;
  label: string;
  short: string;
  provider: 'local' | 'groq';
  model?: string;
  hint: string;
  numGpu?: number;
}

const MODELS: ModelOption[] = [
  { id: 'local-gemma-4-gpu',  label: 'Gemma 2B · GPU (Local)', short: 'Gemma 2B GPU',     provider: 'local', numGpu: 99, hint: 'self-hosted · M2 Metal · ~3-5s' },
  { id: 'local-gemma-4-cpu',  label: 'Gemma 2B · CPU (Local)', short: 'Gemma 2B CPU',     provider: 'local', numGpu: 0,  hint: 'self-hosted · CPU only · ~10s+' },
  { id: 'groq-llama-3.3-70b', label: 'Llama 3.3 70B (Groq)',   short: 'Llama 3.3 70B',    provider: 'groq',  model: 'llama-3.3-70b-versatile',  hint: 'most capable' },
  { id: 'groq-llama-3.1-8b',  label: 'Llama 3.1 8B (Groq)',    short: 'Llama 3.1 8B',     provider: 'groq',  model: 'llama-3.1-8b-instant',     hint: 'fastest' },
  { id: 'groq-gemma2-9b',     label: 'Gemma 2 9B (Groq)',      short: 'Gemma 2 9B',       provider: 'groq',  model: 'gemma2-9b-it',             hint: 'balanced' },
];

function Waveform() {
  return (
    <div className="flex items-center justify-center gap-[3px] h-6">
      {[0.6, 1, 0.7, 1.1, 0.5, 0.9, 0.6].map((d, i) => (
        <div key={i} className="wave-bar w-[3px] rounded-full bg-white" style={{ height: '18px', animationDelay: `${d * 0.28}s` }} />
      ))}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1.5">
      {[0, 0.18, 0.36].map((d, i) => (
        <span key={i} className="w-2 h-2 rounded-full bg-violet-500 animate-bounce" style={{ animationDelay: `${d}s` }} />
      ))}
    </div>
  );
}

export default function VoiceChat() {
  const [sessionId, setSessionId] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [appState, setAppState] = useState<AppState>('idle');
  const [lang, setLang] = useState('en-IN');
  const [error, setError] = useState<string | null>(null);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [showModelMenu, setShowModelMenu] = useState(false);
  const [selectedModelId, setSelectedModelId] = useState<string>(() =>
    localStorage.getItem('orvo-model') ?? MODELS[0].id,
  );
  const [typedText, setTypedText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState<string>(DEFAULT_SYSTEM_PROMPT);
  const [draftPrompt, setDraftPrompt] = useState('');
  const [ambience, setAmbience] = useState<AmbienceMode>(
    () => (localStorage.getItem('orvo-ambience') as AmbienceMode) || 'none',
  );
  const [draftAmbience, setDraftAmbience] = useState<AmbienceMode>('none');
  const [temperature, setTemperature] = useState<number>(
    () => Number(localStorage.getItem('orvo-temperature') ?? '0.4'),
  );
  const [draftTemperature, setDraftTemperature] = useState<number>(0.4);
  const [inCall, setInCall] = useState(false);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [widgetMessages, setWidgetMessages] = useState<Message[]>([]);
  const [widgetDraft, setWidgetDraft] = useState('');
  const [widgetBusy, setWidgetBusy] = useState(false);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [knowledgeDocs, setKnowledgeDocs] = useState<KnowledgeDoc[]>([]);
  const [kbUploading, setKbUploading] = useState(false);
  const [kbError, setKbError] = useState<string | null>(null);
  const [kbTab, setKbTab] = useState<'file' | 'text'>('file');
  const [kbTextTitle, setKbTextTitle] = useState('');
  const [kbTextBody, setKbTextBody] = useState('');
  const [kbTextSubmitting, setKbTextSubmitting] = useState(false);
  const kbFileRef = useRef<HTMLInputElement | null>(null);
  const widgetEndRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const playbackResolveRef = useRef<(() => void) | null>(null);
  const unmuteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const langRef = useRef<HTMLDivElement | null>(null);
  const modelRef = useRef<HTMLDivElement | null>(null);
  const appStateRef = useRef<AppState>('idle');

  // Keep ref synced so callbacks see latest state without re-creating
  useEffect(() => { appStateRef.current = appState; }, [appState]);

  const selectedModel = useMemo(
    () => MODELS.find((m) => m.id === selectedModelId) ?? MODELS[0],
    [selectedModelId],
  );
  const aiChoice = useMemo(
    () => ({
      aiProvider: selectedModel.provider,
      aiModel: selectedModel.model,
      numGpu: selectedModel.numGpu,
      ...(selectedModel.provider === 'local' ? { temperature } : {}),
    }),
    [selectedModel, temperature],
  );
  // Stable ref for use inside recorder callbacks (avoid stale closures)
  const aiChoiceRef = useRef(aiChoice);
  const systemPromptRef = useRef(systemPrompt);
  const sessionIdRef = useRef(sessionId);
  const langRefValue = useRef(lang);
  useEffect(() => { aiChoiceRef.current = aiChoice; }, [aiChoice]);
  useEffect(() => { systemPromptRef.current = systemPrompt; }, [systemPrompt]);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  useEffect(() => { langRefValue.current = lang; }, [lang]);

  const stopPlayback = useCallback(() => {
    const a = audioRef.current;
    if (a) {
      try {
        // Drop callbacks first so onended/onerror won't fire and stomp state.
        a.onended = null;
        a.onerror = null;
        a.pause();
        a.currentTime = 0;
        a.src = '';
        a.load();
      } catch { /* noop */ }
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    audioRef.current = null;
    // Resolve any pending playAudio promise so its finally-block always runs.
    const res = playbackResolveRef.current;
    playbackResolveRef.current = null;
    res?.();
  }, []);

  const playAudio = useCallback((base64: string, mimeType: string): Promise<void> => {
    return new Promise((resolve) => {
      playbackResolveRef.current = resolve;
      try {
        const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mimeType });
        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => { stopPlayback(); };
        audio.onerror = () => { stopPlayback(); };
        const playPromise = audio.play();
        // If browser blocks autoplay, resolve immediately so we don't get stuck.
        if (playPromise !== undefined) {
          playPromise.catch(() => { stopPlayback(); });
        }
      } catch {
        stopPlayback();
      }
    });
  }, [stopPlayback]);

  // ── Ambience (background hospital sounds) ────────────────────────────────────
  const { start: startAmbience, stop: stopAmbience, setMode: setAmbienceMode, setSpeaking: setAmbienceSpeaking } = useAmbience();

  useEffect(() => {
    if (inCall && ambience !== 'none') startAmbience(ambience);
    else stopAmbience();
    // intentionally don't depend on the function refs (stable enough)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inCall, ambience]);

  // Bump ambience slightly while AI is talking so it reads as the AI's room.
  useEffect(() => {
    setAmbienceSpeaking(appState === 'speaking');
  }, [appState, setAmbienceSpeaking]);

  // ── Call recorder (VAD-based, hands-free) ─────────────────────────────────────
  const handleUtterance = useCallback(async (blob: Blob) => {
    const minSize = appStateRef.current === 'recording' ? 3000 : 1000;
    if (!blob || blob.size < minSize) {
      setAppState((s) => (s === 'recording' ? 'listening' : s));
      return;
    }
    if (!sessionIdRef.current) return;

    // Abort any previous in-flight stream before starting a new one
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    stopPlayback();
    callRef.current.setPlaybackActive(false);
    setAppState('processing');
    callRef.current.setMuted(true);
    setError(null);

    let userText = '';
    let assistantText = '';
    const t0 = performance.now();

    try {
      const stream = streamAudioChunks(
        blob,
        sessionIdRef.current,
        langRefValue.current,
        systemPromptRef.current,
        aiChoiceRef.current,
        ctrl.signal,
      );

      // Audio queue: plays chunks in sequence; allows next chunk to be received
      // while current one is still playing.
      const audioQueue: Array<{ base64: string; mime: string }> = [];
      let draining = false;

      const drainQueue = async () => {
        if (draining) return;
        draining = true;
        while (audioQueue.length > 0) {
          // Stop draining if interrupted or call ended
          if (ctrl.signal.aborted || appStateRef.current === 'idle') break;
          const { base64, mime } = audioQueue.shift()!;
          await playAudio(base64, mime);
        }
        draining = false;
      };

      for await (const event of stream) {
        if (ctrl.signal.aborted) break;
        if (event.type === 'empty') return;

        if (event.type === 'error') {
          setError('Something went wrong. Please try again.');
          return;
        }

        if (event.type === 'transcript') {
          userText = event.text;
          // Show user message and switch to speaking state as soon as transcript arrives
          setMessages((prev) => [...prev, { id: uuidv4(), role: 'user', text: userText }]);
          setAppState('speaking');
          callRef.current.setPlaybackActive(true);
          unmuteTimerRef.current = setTimeout(() => {
            callRef.current.setMuted(false);
            unmuteTimerRef.current = null;
          }, 500);
        }

        if (event.type === 'audio') {
          assistantText += (assistantText ? ' ' : '') + event.text;
          // Update assistant message live as sentences arrive
          setMessages((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, text: assistantText }];
            }
            return [...prev, { id: uuidv4(), role: 'assistant', text: assistantText }];
          });
          audioQueue.push({ base64: event.audioBase64, mime: event.audioMimeType });
          void drainQueue();
        }

        if (event.type === 'done') {
          const mode = aiChoiceRef.current.aiProvider === 'local'
            ? `LOCAL ${aiChoiceRef.current.numGpu ? 'GPU' : 'CPU'} (streaming, temp=${(aiChoiceRef.current as { temperature?: number }).temperature?.toFixed(2) ?? '?'})`
            : 'GROQ (streaming)';
          console.log(
            `%c[ORVO TIMING]%c [${mode}] LLM: ${event.llmMs}ms | TOTAL: ${event.totalMs}ms | perceived: ${Math.round(performance.now() - t0)}ms`,
            'color:#7c3aed;font-weight:bold',
            'color:inherit',
          );
        }
      }

      // Wait for the audio queue to finish playing (no-op if aborted)
      await drainQueue();

    } catch (err) {
      // AbortError = user intentionally interrupted — not an error to show
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError('Something went wrong. Please try again.');
    } finally {
      if (unmuteTimerRef.current) { clearTimeout(unmuteTimerRef.current); unmuteTimerRef.current = null; }
      // If aborted, the NEW utterance owns state — don't reset it here
      if (!ctrl.signal.aborted) {
        callRef.current.setPlaybackActive(false);
        callRef.current.setMuted(false);
        setAppState((s) => (s === 'idle' ? 'idle' : 'listening'));
      }
    }
  }, [playAudio, stopPlayback]);

  const handleSpeechStart = useCallback(() => {
    if (appStateRef.current === 'processing') return;
    if (appStateRef.current === 'speaking') {
      // User is interrupting — cancel the SSE stream + drain loop, stop audio immediately.
      abortRef.current?.abort();
      if (unmuteTimerRef.current) { clearTimeout(unmuteTimerRef.current); unmuteTimerRef.current = null; }
      stopPlayback();
      callRef.current.setPlaybackActive(false);
      callRef.current.setMuted(false);
      setAppState('recording');
    } else {
      setAppState('recording');
    }
  }, [stopPlayback]);

  const handleRecError = useCallback((msg: string) => {
    setError(msg);
    setInCall(false);
  }, []);

  const callRecorder = useCallRecorder({
    onSpeechStart: handleSpeechStart,
    onSpeechEnd: handleUtterance,
    onError: handleRecError,
  });
  const callRef = useRef(callRecorder);
  useEffect(() => { callRef.current = callRecorder; }, [callRecorder]);

  const handleStartCall = useCallback(async () => {
    if (inCall) return;
    setError(null);
    // Fresh session for every call — isolates history between calls
    const freshId = uuidv4();
    const id = await createSession(freshId);
    setSessionId(id);
    setMessages([]);
    setInCall(true);
    setAppState('listening');
    await callRef.current.start();
  }, [inCall]);

  const handleLeaveCall = useCallback(() => {
    stopPlayback();
    callRef.current.stop();
    stopAmbience();
    setInCall(false);
    setAppState('idle');
  }, [stopPlayback, stopAmbience]);

  // ── Session bootstrap — fresh session on every page load ────────────────────
  useEffect(() => {
    void createSession(uuidv4()).then((id) => setSessionId(id));
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setShowLangMenu(false);
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setShowModelMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // ── Text input (only used when not in call) ──────────────────────────────────
  const handleTextSend = useCallback(async () => {
    const text = typedText.trim();
    if (!text || appState !== 'idle') return;
    setTypedText('');
    setError(null);
    setAppState('processing');
    try {
      const result = await sendText(text, sessionId, lang, systemPrompt, aiChoice);
      if (result._timing) {
        const t = result._timing;
        const m = aiChoice;
        const mode = m.aiProvider === 'local'
          ? `LOCAL ${m.numGpu ? 'GPU' : 'CPU'} (numGpu=${m.numGpu ?? 0}, temp=${(m as { temperature?: number }).temperature?.toFixed(2) ?? '?'})`
          : 'GROQ';
        console.log(
          `%c[ORVO TIMING]%c [${mode}] STT: ${t.sttMs}ms | RAG: ${t.ragMs}ms | LLM: ${t.llmMs}ms | TTS: ${t.ttsMs}ms | TOTAL: ${t.totalMs}ms`,
          'color:#7c3aed;font-weight:bold',
          'color:inherit',
        );
      }
      setMessages((prev) => [
        ...prev,
        { id: uuidv4(), role: 'user',      text: result.userText      },
        { id: uuidv4(), role: 'assistant', text: result.assistantText },
      ]);
      setAppState('speaking');
      await playAudio(result.audioBase64, result.audioMimeType);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setAppState('idle');
      textInputRef.current?.focus();
    }
  }, [typedText, appState, sessionId, lang, systemPrompt, aiChoice, playAudio]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    await clearHistory(sessionId);
    setMessages([]);
    stopPlayback();
  }, [sessionId, stopPlayback]);

  // ── Knowledge Base handlers ───────────────────────────────────────────────────
  const openKnowledge = useCallback(async () => {
    setKbError(null);
    setShowKnowledge(true);
    try {
      const docs = await listKnowledgeDocs();
      setKnowledgeDocs(docs);
    } catch {
      setKbError('Failed to load documents.');
    }
  }, []);

  const handleKbUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setKbUploading(true);
    setKbError(null);
    try {
      await uploadKnowledgeFile(file);
      const docs = await listKnowledgeDocs();
      setKnowledgeDocs(docs);
    } catch {
      setKbError('Upload failed. Check file type (PDF, DOCX, TXT).');
    } finally {
      setKbUploading(false);
      if (kbFileRef.current) kbFileRef.current.value = '';
    }
  }, []);

  const handleKbDelete = useCallback(async (documentId: string) => {
    try {
      await deleteKnowledgeDoc(documentId);
      setKnowledgeDocs((prev) => prev.filter((d) => d.documentId !== documentId));
    } catch {
      setKbError('Delete failed.');
    }
  }, []);

  const handleKbTextSubmit = useCallback(async () => {
    const title = kbTextTitle.trim();
    const body  = kbTextBody.trim();
    if (!title || !body) { setKbError('Both title and text are required.'); return; }
    setKbTextSubmitting(true);
    setKbError(null);
    try {
      await uploadKnowledgeText(title, body);
      const docs = await listKnowledgeDocs();
      setKnowledgeDocs(docs);
      setKbTextTitle('');
      setKbTextBody('');
    } catch {
      setKbError('Failed to save text. Please try again.');
    } finally {
      setKbTextSubmitting(false);
    }
  }, [kbTextTitle, kbTextBody]);

  // ── Widget (text-only side chat) ─────────────────────────────────────────────
  const handleWidgetSend = useCallback(async () => {
    const text = widgetDraft.trim();
    if (!text || widgetBusy || !sessionId) return;
    setWidgetDraft('');
    setWidgetBusy(true);
    setWidgetMessages((prev) => [...prev, { id: uuidv4(), role: 'user', text }]);
    try {
      const result = await sendTextOnly(text, sessionId, lang, systemPrompt, aiChoice);
      setWidgetMessages((prev) => [...prev, { id: uuidv4(), role: 'assistant', text: result.assistantText }]);
    } catch {
      setWidgetMessages((prev) => [...prev, { id: uuidv4(), role: 'assistant', text: 'Error talking to AI. Try again.' }]);
    } finally {
      setWidgetBusy(false);
    }
  }, [widgetDraft, widgetBusy, sessionId, lang, systemPrompt, aiChoice]);

  useEffect(() => {
    widgetEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [widgetMessages, widgetBusy]);

  const selectedLang = LANGUAGES.find((l) => l.code === lang);

  /* Orb config per state — single-accent design language (slate + indigo) */
  const orbConfig = ({
    idle:       { bg: 'bg-indigo-600 hover:bg-indigo-700',         ring: '',                  shadow: 'shadow-indigo-500/30'  },
    listening:  { bg: 'bg-indigo-600',                              ring: 'text-indigo-400',   shadow: 'shadow-indigo-500/30'  },
    recording:  { bg: 'bg-rose-500',                                ring: 'text-rose-400',     shadow: 'shadow-rose-500/30'    },
    processing: { bg: 'bg-slate-700',                               ring: 'text-slate-400',    shadow: 'shadow-slate-500/30'   },
    speaking:   { bg: 'bg-emerald-500',                             ring: 'text-emerald-400',  shadow: 'shadow-emerald-500/30' },
  } as const)[appState];

  const statusConfig = ({
    idle:       { label: 'Ready to call',         dot: 'bg-slate-300'                    },
    listening:  { label: 'Listening',              dot: 'bg-indigo-500 animate-pulse'    },
    recording:  { label: 'You’re speaking',   dot: 'bg-rose-500 animate-pulse'      },
    processing: { label: 'Thinking',               dot: 'bg-slate-500 animate-pulse'     },
    speaking:   { label: 'Speaking',               dot: 'bg-emerald-500 animate-pulse'   },
  } as const)[appState];

  return (
    <div className="h-[100dvh] overflow-hidden surface-gradient flex flex-col">

      {/* ── Header ── */}
      <header className="bg-white/75 backdrop-blur-md border-b border-slate-200/60 px-4 sm:px-5 py-3 flex items-center justify-between z-20 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-md shadow-indigo-500/25 ring-1 ring-inset ring-white/10">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div className="flex flex-col leading-tight">
            <div className="flex items-center gap-1.5">
              <span className="text-[15px] font-semibold text-slate-900 tracking-tight">Orvo</span>
              <span className="text-[9px] font-semibold tracking-wider px-1.5 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200">BETA</span>
            </div>
            <span className="text-[10.5px] text-slate-500 font-medium hidden sm:block">Voice AI · Hindi · English</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          {/* Model dropdown */}
          <div className="relative" ref={modelRef}>
            <button
              onClick={() => setShowModelMenu((p) => !p)}
              disabled={inCall}
              className="flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
              title="AI model"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${
                selectedModel.provider === 'local' && selectedModel.numGpu
                  ? 'bg-emerald-500'
                  : selectedModel.provider === 'local'
                  ? 'bg-blue-400'
                  : 'bg-amber-500'
              }`} />
              <span className="hidden sm:inline">{selectedModel.short}</span>
              <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showModelMenu && (
              <div className="absolute right-0 mt-1.5 w-64 bg-white rounded-xl border border-slate-200 shadow-2xl shadow-slate-900/10 overflow-hidden z-50 ring-1 ring-slate-900/5">
                <div className="px-3 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">AI Model</div>
                {MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setSelectedModelId(m.id);
                      localStorage.setItem('orvo-model', m.id);
                      setShowModelMenu(false);
                    }}
                    className={`w-full text-left px-3 py-2.5 transition cursor-pointer border-l-2 ${
                      m.id === selectedModelId
                        ? 'bg-indigo-50/60 border-indigo-500'
                        : 'border-transparent text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-xs font-semibold ${m.id === selectedModelId ? 'text-indigo-700' : 'text-slate-800'}`}>{m.label}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold tracking-wider ${
                        m.provider === 'local' && m.numGpu
                          ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                          : m.provider === 'local'
                          ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
                          : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                      }`}>{m.provider === 'local' ? (m.numGpu ? 'GPU' : 'CPU') : 'GROQ'}</span>
                    </div>
                    <div className="text-[10.5px] text-slate-500 mt-0.5">{m.hint}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Language dropdown */}
          <div className="relative" ref={langRef}>
            <button
              onClick={() => setShowLangMenu((p) => !p)}
              className="flex items-center gap-1.5 text-[11.5px] font-medium px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition cursor-pointer shadow-sm"
              title="Language"
            >
              <svg className="w-3.5 h-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18z M3 12h18 M12 3a14.5 14.5 0 010 18 M12 3a14.5 14.5 0 000 18" />
              </svg>
              <span className="hidden sm:inline">{selectedLang?.label}</span>
            </button>
            {showLangMenu && (
              <div className="absolute right-0 mt-1.5 w-40 bg-white rounded-xl border border-slate-200 shadow-2xl shadow-slate-900/10 overflow-hidden z-50 ring-1 ring-slate-900/5">
                <div className="px-3 py-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-100">Language</div>
                {LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => { setLang(l.code); setShowLangMenu(false); }}
                    className={`w-full text-left px-3 py-2 text-xs font-medium transition cursor-pointer border-l-2 ${
                      lang === l.code
                        ? 'bg-indigo-50/60 border-indigo-500 text-indigo-700'
                        : 'border-transparent text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Knowledge base */}
          <button
            onClick={() => void openKnowledge()}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-700 border border-slate-200 shadow-sm transition cursor-pointer"
            title="Knowledge base"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
            </svg>
          </button>

          {/* Settings gear */}
          <button
            onClick={() => { setDraftPrompt(systemPrompt); setDraftAmbience(ambience); setDraftTemperature(temperature); setShowSettings(true); }}
            className="flex items-center justify-center w-9 h-9 rounded-lg bg-white hover:bg-slate-50 text-slate-500 hover:text-slate-700 border border-slate-200 shadow-sm transition cursor-pointer"
            title="Settings"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {messages.length > 0 && (
            <button
              onClick={() => void handleClear()}
              className="text-[11.5px] font-medium px-2.5 py-1.5 rounded-lg text-slate-500 hover:text-rose-600 hover:bg-rose-50 border border-transparent hover:border-rose-100 transition cursor-pointer"
              title="Clear conversation"
            >
              <svg className="w-4 h-4 sm:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
              </svg>
              <span className="hidden sm:inline">Clear</span>
            </button>
          )}
        </div>
      </header>

      {/* ── Messages ── */}
      <div className={`flex-1 min-h-0 px-4 ${messages.length === 0 ? 'overflow-hidden flex' : 'overflow-y-auto scrollbar-thin py-6'}`}>
        <div className={`max-w-2xl mx-auto ${messages.length === 0 ? 'w-full flex' : 'space-y-3'}`}>
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center w-full text-center gap-5 px-4">
              <div className="relative">
                <div className="absolute inset-0 rounded-3xl bg-gradient-to-br from-indigo-400 to-violet-500 blur-2xl opacity-30 scale-90" />
                <div className="relative w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shadow-xl shadow-indigo-500/30 ring-1 ring-inset ring-white/15">
                  <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                  </svg>
                </div>
              </div>
              <div className="max-w-sm">
                <h2 className="text-slate-900 font-semibold text-xl tracking-tight">Start a conversation</h2>
                <p className="text-slate-500 text-[13.5px] mt-2 leading-relaxed">
                  Tap the call button below. Orvo listens hands-free and replies in your language — just like a real phone call.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {[
                  { label: 'Hands-free', icon: 'M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z' },
                  { label: 'Interrupt anytime', icon: 'M9 9l6 6m0-6l-6 6m12-3a9 9 0 11-18 0 9 9 0 0118 0z' },
                  { label: '8 languages', icon: 'M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371' },
                ].map((tag) => (
                  <span key={tag.label} className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-600 font-medium shadow-sm">
                    <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d={tag.icon} />
                    </svg>
                    {tag.label}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 flex items-center justify-center shrink-0 mt-0.5 shadow-sm shadow-indigo-500/20 ring-1 ring-inset ring-white/10">
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                )}
                <div className={`max-w-[80%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-sm shadow-md shadow-indigo-500/20'
                    : 'bg-white text-slate-800 rounded-bl-sm border border-slate-200/80 shadow-sm shadow-slate-900/[0.03]'
                }`}>
                  {msg.text}
                </div>
                {msg.role === 'user' && (
                  <div className="w-8 h-8 rounded-xl bg-slate-100 flex items-center justify-center shrink-0 mt-0.5 border border-slate-200">
                    <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                    </svg>
                  </div>
                )}
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="max-w-sm mx-auto mb-2 px-4">
          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-xl px-4 py-2.5 border border-red-200">
            <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
            </svg>
            {error}
          </div>
        </div>
      )}

      {/* ── Call Panel ── */}
      <div className="bg-white/85 backdrop-blur-md border-t border-slate-200/70 px-4 pt-4 pb-[max(env(safe-area-inset-bottom),1.25rem)] flex flex-col items-center gap-3.5 shrink-0">
        {/* Text input — visible only outside call */}
        {!inCall && (
          <div className="w-full max-w-lg flex items-center gap-2">
            <input
              ref={textInputRef}
              type="text"
              value={typedText}
              onChange={(e) => setTypedText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleTextSend(); }}
              placeholder="Type a message…"
              disabled={appState !== 'idle'}
              className="flex-1 px-4 py-2.5 text-[13.5px] rounded-xl border border-slate-200 bg-slate-50/80 text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-300 focus:bg-white disabled:opacity-50 transition"
            />
            <button
              onClick={() => void handleTextSend()}
              disabled={!typedText.trim() || appState !== 'idle'}
              className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 hover:from-indigo-600 hover:to-indigo-800 text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-400 transition cursor-pointer shrink-0 shadow-md shadow-indigo-500/25 ring-1 ring-inset ring-white/10"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        )}

        {/* Status indicator — unified slate base with stateful accent dot */}
        <div className="flex items-center gap-2 text-[11.5px] font-medium px-3 py-1.5 rounded-full border bg-white/60 backdrop-blur-sm border-slate-200/70 text-slate-600 transition-all duration-300">
          <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot}`} />
          <span className="tracking-tight">{statusConfig.label}</span>
          {inCall && ambience === 'hospital' && (
            <span className="ml-1.5 text-[10px] text-slate-400 border-l border-slate-200 pl-2 tracking-wide uppercase">
              Hospital
            </span>
          )}
        </div>

        {/* Call button / Leave button */}
        <div className="relative flex items-center justify-center w-24 h-24">
          {appState !== 'idle' && (
            <>
              <span className={`orb-ring ${orbConfig.ring}`} style={{ animationDelay: '0s' }} />
              <span className={`orb-ring ${orbConfig.ring}`} style={{ animationDelay: '0.45s' }} />
            </>
          )}
          {!inCall ? (
            <button
              onClick={() => void handleStartCall()}
              className="relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer select-none shadow-xl shadow-emerald-500/30 bg-gradient-to-br from-emerald-400 to-emerald-600 hover:from-emerald-500 hover:to-emerald-700 active:scale-95 ring-1 ring-inset ring-white/15"
              title="Start call"
            >
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 002.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 01-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.272.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 00-1.091-.852H4.5A2.25 2.25 0 002.25 4.5v2.25z" />
              </svg>
            </button>
          ) : (
            <button
              onClick={handleLeaveCall}
              className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer select-none shadow-xl ${orbConfig.shadow} ${orbConfig.bg} active:scale-95`}
              title="Leave call"
            >
              {appState === 'processing' ? <ThinkingDots /> :
               appState === 'recording'  ? <Waveform /> :
               appState === 'speaking'   ? (
                 <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                   <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
                 </svg>
               ) : (
                 // listening — show phone-hangup icon to suggest "tap to leave"
                 <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                   <path strokeLinecap="round" strokeLinejoin="round" d="M3 10.5c5-5 13-5 18 0l-2 2-2.5-1.5v-3c-3-1-6-1-9 0v3L5 12.5l-2-2z" />
                 </svg>
               )}
            </button>
          )}
        </div>

        <p className="text-[11.5px] text-slate-400 font-medium tracking-tight">
          {inCall
            ? (appState === 'speaking' ? 'Start speaking to interrupt' : 'Talk naturally — silence ends your turn')
            : 'Tap to start a call'}
        </p>
      </div>

      {/* ── Chat Widget (bottom-right) ── */}
      {!widgetOpen && (
        <button
          onClick={() => setWidgetOpen(true)}
          className="fixed bottom-[max(env(safe-area-inset-bottom),1.25rem)] right-5 z-40 w-12 h-12 rounded-full bg-gradient-to-br from-indigo-500 to-indigo-700 hover:from-indigo-600 hover:to-indigo-800 text-white shadow-lg shadow-indigo-500/30 ring-1 ring-inset ring-white/10 flex items-center justify-center transition cursor-pointer active:scale-95"
          title="Chat with the AI"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.364.466.037.893.281 1.153.671L12 21l2.652-3.978c.26-.39.687-.634 1.153-.67 1.09-.086 2.17-.208 3.238-.365 1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
          </svg>
        </button>
      )}

      {widgetOpen && (
        <div className="fixed bottom-5 right-5 z-40 w-[360px] max-w-[calc(100vw-2rem)] h-[520px] max-h-[calc(100vh-2rem)] bg-white rounded-2xl shadow-2xl shadow-slate-900/15 border border-slate-200 flex flex-col overflow-hidden ring-1 ring-slate-900/5">
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 bg-gradient-to-br from-indigo-600 via-indigo-700 to-indigo-800 text-white">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-white/15 backdrop-blur-sm flex items-center justify-center ring-1 ring-inset ring-white/15">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                </svg>
              </div>
              <div className="leading-tight">
                <div className="text-[13px] font-semibold tracking-tight">Test chat</div>
                <div className="text-[10.5px] opacity-80">{selectedModel.label}</div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setWidgetMessages([])}
                className="w-7 h-7 rounded-lg hover:bg-white/15 flex items-center justify-center transition cursor-pointer"
                title="Clear widget chat"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                </svg>
              </button>
              <button
                onClick={() => setWidgetOpen(false)}
                className="w-7 h-7 rounded-lg hover:bg-white/15 flex items-center justify-center transition cursor-pointer"
                title="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2 bg-slate-50/60">
            {widgetMessages.length === 0 && (
              <div className="text-center text-[12px] text-slate-400 mt-6 px-4 leading-relaxed">
                Type a message to test <span className="font-semibold text-slate-600">{selectedModel.short}</span>.
                <br />Replies are text-only (no voice).
              </div>
            )}
            {widgetMessages.map((m) => (
              <div key={m.id} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-[82%] rounded-2xl px-3 py-2 text-[13px] leading-snug whitespace-pre-wrap ${
                    m.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm shadow-sm shadow-indigo-500/20'
                      : 'bg-white text-slate-800 border border-slate-200 rounded-bl-sm'
                  }`}
                >
                  {m.text}
                </div>
              </div>
            ))}
            {widgetBusy && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-3 py-2">
                  <ThinkingDots />
                </div>
              </div>
            )}
            <div ref={widgetEndRef} />
          </div>

          <div className="border-t border-slate-100 px-3 py-2.5 bg-white flex items-center gap-2">
            <input
              type="text"
              value={widgetDraft}
              onChange={(e) => setWidgetDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleWidgetSend(); } }}
              placeholder={widgetBusy ? 'Waiting for reply…' : 'Type a message…'}
              disabled={widgetBusy}
              className="flex-1 px-3 py-2 text-[13px] rounded-lg border border-slate-200 bg-slate-50/80 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-300 focus:bg-white disabled:opacity-50 transition"
            />
            <button
              onClick={() => void handleWidgetSend()}
              disabled={!widgetDraft.trim() || widgetBusy}
              className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-indigo-700 hover:from-indigo-600 hover:to-indigo-800 text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:from-slate-300 disabled:to-slate-400 transition cursor-pointer flex items-center justify-center shrink-0 shadow-sm shadow-indigo-500/20"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm px-0 sm:px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}
        >
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl shadow-slate-900/20 w-full max-w-lg border border-slate-200 overflow-hidden ring-1 ring-slate-900/5 flex flex-col max-h-[92vh]">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center ring-1 ring-indigo-100">
                  <svg className="w-4 h-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </div>
                <div className="leading-tight">
                  <div className="text-[13.5px] font-semibold text-slate-900 tracking-tight">Settings</div>
                  <div className="text-[10.5px] text-slate-500">Saved on this device</div>
                </div>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 py-5 space-y-6 overflow-y-auto scrollbar-thin">
              {/* Ambience selector */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-800 mb-1 uppercase tracking-wider">
                  Background ambience
                </label>
                <p className="text-[12px] text-slate-500 mb-3 leading-relaxed">
                  Plays softly behind the AI voice — sets the scene for health-care calls.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    { v: 'none',     label: 'None',     desc: 'Silent background', icon: 'M6 18L18 6M6 6l12 12' },
                    { v: 'hospital', label: 'Hospital', desc: 'Beeps, hum, distant chatter', icon: 'M12 6v6m0 0v6m0-6h6m-6 0H6' },
                  ] as { v: AmbienceMode; label: string; desc: string; icon: string }[]).map((opt) => (
                    <button
                      key={opt.v}
                      onClick={() => setDraftAmbience(opt.v)}
                      className={`text-left rounded-xl border px-3.5 py-3 transition cursor-pointer ${
                        draftAmbience === opt.v
                          ? 'border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-100'
                          : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className={`text-[13px] font-semibold ${draftAmbience === opt.v ? 'text-indigo-700' : 'text-slate-800'}`}>
                          {opt.label}
                        </div>
                        {draftAmbience === opt.v && (
                          <svg className="w-4 h-4 text-indigo-600" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                          </svg>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500">{opt.desc}</div>
                    </button>
                  ))}
                </div>
              </div>

              {/* Temperature — local models only */}
              {selectedModel.provider === 'local' && (
                <div>
                  <label className="block text-[11.5px] font-semibold text-slate-800 mb-1 uppercase tracking-wider">
                    Response temperature
                  </label>
                  <p className="text-[12px] text-slate-500 mb-3 leading-relaxed">
                    Controls how creative vs. focused the AI's replies are. Lower = more precise, higher = more varied.
                  </p>
                  <div className="flex items-center gap-3">
                    <span className="text-[11px] text-slate-400 w-14 text-right shrink-0">Focused</span>
                    <input
                      type="range"
                      min="0"
                      max="1.5"
                      step="0.05"
                      value={draftTemperature}
                      onChange={(e) => setDraftTemperature(Number(e.target.value))}
                      className="flex-1 accent-indigo-600 cursor-pointer"
                    />
                    <span className="text-[11px] text-slate-400 w-14 shrink-0">Creative</span>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[11px] text-slate-400">0.0</span>
                    <span className="text-[13px] font-semibold text-indigo-600 tabular-nums">{draftTemperature.toFixed(2)}</span>
                    <span className="text-[11px] text-slate-400">1.5</span>
                  </div>
                  <div className="flex gap-1.5 mt-2">
                    {[
                      { label: 'Precise', value: 0.1 },
                      { label: 'Balanced', value: 0.4 },
                      { label: 'Creative', value: 0.8 },
                      { label: 'Wild', value: 1.2 },
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        onClick={() => setDraftTemperature(preset.value)}
                        className={`flex-1 text-[10.5px] py-1 rounded-lg border font-medium transition cursor-pointer ${
                          Math.abs(draftTemperature - preset.value) < 0.03
                            ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                            : 'bg-white border-slate-200 text-slate-500 hover:border-slate-300'
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* System prompt */}
              <div>
                <label className="block text-[11.5px] font-semibold text-slate-800 mb-1 uppercase tracking-wider">
                  Agent system prompt
                </label>
                <p className="text-[12px] text-slate-500 mb-3 leading-relaxed">
                  Defines how the AI behaves. Sent with every message.
                </p>
                <textarea
                  value={draftPrompt}
                  onChange={(e) => setDraftPrompt(e.target.value)}
                  rows={8}
                  className="w-full px-3.5 py-3 text-[12.5px] rounded-xl border border-slate-200 bg-slate-50/80 text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-300 focus:bg-white resize-none font-mono leading-relaxed transition"
                  placeholder="Enter system prompt…"
                />
                <button
                  onClick={() => setDraftPrompt(DEFAULT_SYSTEM_PROMPT)}
                  className="text-[11.5px] text-indigo-600 hover:text-indigo-800 font-medium cursor-pointer transition mt-1.5"
                >
                  Reset to default
                </button>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 px-5 py-3.5 bg-slate-50/70 border-t border-slate-100">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-[13px] font-medium text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-200/70 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const trimmed = draftPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
                  setSystemPrompt(trimmed);
                  setAmbience(draftAmbience);
                  localStorage.setItem('orvo-ambience', draftAmbience);
                  if (inCall) setAmbienceMode(draftAmbience);
                  if (selectedModel.provider === 'local') {
                    setTemperature(draftTemperature);
                    localStorage.setItem('orvo-temperature', String(draftTemperature));
                  }
                  setShowSettings(false);
                }}
                className="px-4 py-2 text-[13px] font-semibold bg-gradient-to-br from-indigo-500 to-indigo-700 hover:from-indigo-600 hover:to-indigo-800 text-white rounded-lg shadow-md shadow-indigo-500/25 ring-1 ring-inset ring-white/10 transition cursor-pointer"
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Knowledge Base Modal ── */}
      {showKnowledge && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/50 backdrop-blur-sm px-0 sm:px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowKnowledge(false); }}
        >
          <div className="bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden flex flex-col max-h-[88vh]">

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center ring-1 ring-indigo-100">
                  <svg className="w-4 h-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" />
                  </svg>
                </div>
                <div className="leading-tight">
                  <div className="text-[13.5px] font-semibold text-slate-900">Train Knowledge Base</div>
                  <div className="text-[10.5px] text-slate-500">{knowledgeDocs.length} entr{knowledgeDocs.length !== 1 ? 'ies' : 'y'} trained</div>
                </div>
              </div>
              <button onClick={() => setShowKnowledge(false)} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400 transition cursor-pointer">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-100 px-5 pt-3 gap-1">
              <button
                onClick={() => { setKbTab('file'); setKbError(null); }}
                className={`px-3.5 py-1.5 text-[12.5px] font-medium rounded-t-lg transition cursor-pointer ${kbTab === 'file' ? 'bg-indigo-50 text-indigo-700 border border-b-white border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Upload File
              </button>
              <button
                onClick={() => { setKbTab('text'); setKbError(null); }}
                className={`px-3.5 py-1.5 text-[12.5px] font-medium rounded-t-lg transition cursor-pointer ${kbTab === 'text' ? 'bg-indigo-50 text-indigo-700 border border-b-white border-slate-200' : 'text-slate-500 hover:text-slate-700'}`}
              >
                Paste Text
              </button>
            </div>

            {/* Tab content */}
            <div className="px-5 pt-4 pb-2">
              {kbTab === 'file' ? (
                <>
                  <input ref={kbFileRef} type="file" accept=".pdf,.docx,.doc,.txt" className="hidden" onChange={(e) => void handleKbUpload(e)} />
                  <button
                    onClick={() => kbFileRef.current?.click()}
                    disabled={kbUploading}
                    className="w-full border-2 border-dashed border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/40 rounded-xl py-5 flex flex-col items-center gap-2 transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {kbUploading ? (
                      <div className="flex items-center gap-2 text-indigo-600 text-[13px] font-medium">
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                        Processing…
                      </div>
                    ) : (
                      <>
                        <svg className="w-6 h-6 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                        <span className="text-[13px] font-medium text-slate-600">Click to upload PDF, DOCX, or TXT</span>
                        <span className="text-[11px] text-slate-400">Max 20 MB</span>
                      </>
                    )}
                  </button>
                </>
              ) : (
                <div className="flex flex-col gap-3">
                  <div>
                    <label className="block text-[11.5px] font-medium text-slate-600 mb-1">Title / Source name</label>
                    <input
                      type="text"
                      value={kbTextTitle}
                      onChange={(e) => setKbTextTitle(e.target.value)}
                      placeholder="e.g. Hospital FAQ, Doctor Schedule, Services List…"
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                      disabled={kbTextSubmitting}
                    />
                  </div>
                  <div>
                    <label className="block text-[11.5px] font-medium text-slate-600 mb-1">
                      Text content
                      {kbTextBody.length > 0 && (
                        <span className="ml-2 text-slate-400 font-normal">{kbTextBody.length.toLocaleString()} chars</span>
                      )}
                    </label>
                    <textarea
                      value={kbTextBody}
                      onChange={(e) => setKbTextBody(e.target.value)}
                      placeholder="Paste any long text here — FAQs, procedures, doctor bios, service descriptions, schedules…"
                      rows={7}
                      className="w-full px-3 py-2 rounded-lg border border-slate-200 text-[13px] text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
                      disabled={kbTextSubmitting}
                    />
                  </div>
                  <button
                    onClick={() => void handleKbTextSubmit()}
                    disabled={kbTextSubmitting || !kbTextTitle.trim() || !kbTextBody.trim()}
                    className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white text-[13px] font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  >
                    {kbTextSubmitting ? (
                      <>
                        <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                        Chunking & saving…
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" /></svg>
                        Train with this text
                      </>
                    )}
                  </button>
                </div>
              )}
              {kbError && <p className="mt-2 text-[12px] text-red-600">{kbError}</p>}
            </div>

            {/* Trained entries list */}
            <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-2 mt-3">
              <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Trained entries</div>
              {knowledgeDocs.length === 0 && !kbUploading && !kbTextSubmitting && (
                <p className="text-center text-[12.5px] text-slate-400 py-4">Nothing trained yet. Upload a file or paste text above.</p>
              )}
              {knowledgeDocs.map((doc) => {
                const isText = doc.mimetype === 'text/plain' && doc.sizeBytes < 50000 && !doc.filename.match(/\.(txt|TXT)$/);
                return (
                  <div key={doc.documentId} className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border border-slate-200 bg-slate-50/60">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center shrink-0">
                        {isText ? (
                          <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
                          </svg>
                        ) : (
                          <svg className="w-4 h-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-slate-800 truncate">{doc.filename}</div>
                        <div className="text-[10.5px] text-slate-400">{doc.chunkCount} chunks · {(doc.sizeBytes / 1024).toFixed(0)} KB</div>
                      </div>
                    </div>
                    <button
                      onClick={() => void handleKbDelete(doc.documentId)}
                      className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-500 transition cursor-pointer shrink-0"
                      title="Delete"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
