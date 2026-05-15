import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { createSession, sendAudio, sendText, clearHistory } from '../api/voice';

const DEFAULT_SYSTEM_PROMPT = `You are Orvo, a voice AI assistant for Indian users.
Reply ONLY with the spoken answer — no markdown, no bullet points, no asterisks, no labels, no reasoning.
Keep it to 1-3 sentences maximum. It will be read aloud.
Always reply in the same language the user used (Hindi or English).
Be warm, direct, and conversational.`;

interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

type AppState = 'idle' | 'recording' | 'processing' | 'speaking';

const LANGUAGES = [
  { code: 'hi-IN', label: 'हिंदी' },
  { code: 'en-IN', label: 'English' },
  { code: 'bn-IN', label: 'বাংলা' },
  { code: 'ta-IN', label: 'தமிழ்' },
  { code: 'te-IN', label: 'తెలుగు' },
  { code: 'mr-IN', label: 'मराठी' },
  { code: 'gu-IN', label: 'ગુજરાતી' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ' },
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
  const [lang, setLang] = useState('hi-IN');
  const [error, setError] = useState<string | null>(null);
  const [showLangMenu, setShowLangMenu] = useState(false);
  const [typedText, setTypedText] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState<string>(
    () => localStorage.getItem('orvo-system-prompt') ?? DEFAULT_SYSTEM_PROMPT,
  );
  const [draftPrompt, setDraftPrompt] = useState('');
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textInputRef = useRef<HTMLInputElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const langRef = useRef<HTMLDivElement | null>(null);

  const { start: startRec, stop: stopRec, error: recError } = useVoiceRecorder();

  useEffect(() => {
    const stored = localStorage.getItem('orvo-session');
    void createSession(stored ?? undefined).then((id) => {
      setSessionId(id);
      localStorage.setItem('orvo-session', id);
    });
  }, []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { if (recError) setError(recError); }, [recError]);

  // close lang dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (langRef.current && !langRef.current.contains(e.target as Node)) setShowLangMenu(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const playAudio = useCallback((base64: string, mimeType: string): Promise<void> => {
    return new Promise((resolve) => {
      const blob = new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
      audio.onerror = () => { URL.revokeObjectURL(url); resolve(); };
      void audio.play();
    });
  }, []);

  const handleMicPress = useCallback(async () => {
    if (appState !== 'idle') return;
    setError(null);
    await startRec();
    setAppState('recording');
  }, [appState, startRec]);

  const handleMicRelease = useCallback(async () => {
    if (appState !== 'recording') return;
    setAppState('processing');
    const blob = await stopRec();
    if (!blob || blob.size < 1000) {
      setAppState('idle');
      setError('Recording too short — hold and speak clearly.');
      return;
    }
    try {
      const result = await sendAudio(blob, sessionId, lang, systemPrompt);
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
    }
  }, [appState, stopRec, sessionId, lang, systemPrompt, playAudio]);

  const handleTextSend = useCallback(async () => {
    const text = typedText.trim();
    if (!text || appState !== 'idle') return;
    setTypedText('');
    setError(null);
    setAppState('processing');
    try {
      const result = await sendText(text, sessionId, lang, systemPrompt);
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
  }, [typedText, appState, sessionId, lang, systemPrompt, playAudio]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    await clearHistory(sessionId);
    setMessages([]);
    audioRef.current?.pause();
  }, [sessionId]);

  const selectedLang = LANGUAGES.find((l) => l.code === lang);

  /* Orb config per state */
  const orbConfig = {
    idle:       { bg: 'bg-indigo-600 hover:bg-indigo-700',  ring: '',            shadow: 'shadow-indigo-200' },
    recording:  { bg: 'bg-rose-500',                         ring: 'text-rose-400',   shadow: 'shadow-rose-200'   },
    processing: { bg: 'bg-violet-600',                       ring: 'text-violet-400', shadow: 'shadow-violet-200' },
    speaking:   { bg: 'bg-emerald-500',                      ring: 'text-emerald-400', shadow: 'shadow-emerald-200' },
  }[appState];

  const statusConfig = {
    idle:       { label: 'Hold to speak',  dot: 'bg-gray-300'     },
    recording:  { label: 'Listening…',     dot: 'bg-rose-500 animate-pulse'    },
    processing: { label: 'Thinking…',      dot: 'bg-violet-500 animate-pulse'  },
    speaking:   { label: 'Speaking…',      dot: 'bg-emerald-500 animate-pulse' },
  }[appState];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">

      {/* ── Header ── */}
      <header className="bg-white border-b border-slate-200 px-5 py-3.5 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shadow-sm shadow-indigo-200">
            <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-gray-900 tracking-tight">Orvo</span>
            <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600 border border-indigo-100">BETA</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Language dropdown */}
          <div className="relative" ref={langRef}>
            <button
              onClick={() => setShowLangMenu((p) => !p)}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-gray-700 transition cursor-pointer border border-slate-200"
            >
              <svg className="w-3 h-3 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 21l5.25-11.25L21 21m-9-3h7.5M3 5.621a48.474 48.474 0 016-.371m0 0c1.12 0 2.233.038 3.334.114M9 5.25V3m3.334 2.364C11.176 10.658 7.69 15.08 3 17.502m9.334-12.138c.896.061 1.785.147 2.666.257m-4.589 8.495a18.023 18.023 0 01-3.827-5.802" />
              </svg>
              {selectedLang?.label}
              <svg className="w-3 h-3 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
            {showLangMenu && (
              <div className="absolute right-0 mt-1 w-36 bg-white rounded-xl border border-slate-200 shadow-xl shadow-slate-200/60 overflow-hidden z-50">
                {LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    onClick={() => { setLang(l.code); setShowLangMenu(false); }}
                    className={`w-full text-left px-3 py-2 text-xs font-medium transition cursor-pointer ${
                      lang === l.code
                        ? 'bg-indigo-50 text-indigo-700'
                        : 'text-gray-700 hover:bg-slate-50'
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Settings gear */}
          <button
            onClick={() => { setDraftPrompt(systemPrompt); setShowSettings(true); }}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-500 hover:text-slate-700 border border-slate-200 transition cursor-pointer"
            title="Prompt settings"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {messages.length > 0 && (
            <button
              onClick={() => void handleClear()}
              className="text-xs font-medium px-3 py-1.5 rounded-lg text-red-500 hover:bg-red-50 border border-transparent hover:border-red-100 transition cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>
      </header>

      {/* ── Messages ── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-4 py-6">
        <div className="max-w-2xl mx-auto space-y-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center min-h-[50vh] text-center gap-5">
              <div className="w-16 h-16 rounded-2xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-200">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                </svg>
              </div>
              <div>
                <p className="text-gray-800 font-semibold text-base">Start a conversation</p>
                <p className="text-gray-400 text-sm mt-1.5 max-w-xs leading-relaxed">
                  Hold the mic button and speak — Orvo understands Hindi, English & 6 more Indian languages
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                {['Sarvam STT/TTS', 'Google Gemma', 'Hindi · English · +6'].map((tag) => (
                  <span key={tag} className="text-xs px-2.5 py-1 rounded-full bg-white border border-slate-200 text-slate-500 font-medium shadow-sm">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {msg.role === 'assistant' && (
                  <div className="w-8 h-8 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0 mt-0.5 shadow-sm shadow-indigo-200">
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
                    </svg>
                  </div>
                )}
                <div className={`max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-tr-sm shadow-indigo-100'
                    : 'bg-white text-gray-800 rounded-tl-sm border border-slate-200'
                }`}>
                  {msg.text}
                </div>
                {msg.role === 'user' && (
                  <div className="w-8 h-8 rounded-xl bg-slate-200 flex items-center justify-center shrink-0 mt-0.5">
                    <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
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

      {/* ── Mic Panel ── */}
      <div className="bg-white border-t border-slate-200 px-4 pt-4 pb-6 flex flex-col items-center gap-4">
        {/* Text input */}
        <div className="w-full max-w-lg flex items-center gap-2">
          <input
            ref={textInputRef}
            type="text"
            value={typedText}
            onChange={(e) => setTypedText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleTextSend(); }}
            placeholder="Type a message or hold mic to speak…"
            disabled={appState !== 'idle'}
            className="flex-1 px-4 py-2.5 text-sm rounded-xl border border-slate-200 bg-slate-50 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent disabled:opacity-50 transition"
          />
          <button
            onClick={() => void handleTextSend()}
            disabled={!typedText.trim() || appState !== 'idle'}
            className="flex items-center justify-center w-10 h-10 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-40 disabled:cursor-not-allowed transition cursor-pointer shrink-0"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
        {/* Status indicator */}
        <div className={`flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-full border transition-all duration-300 ${
          appState === 'idle'       ? 'bg-slate-50 border-slate-200 text-slate-500' :
          appState === 'recording'  ? 'bg-rose-50 border-rose-200 text-rose-600' :
          appState === 'processing' ? 'bg-violet-50 border-violet-200 text-violet-600' :
                                      'bg-emerald-50 border-emerald-200 text-emerald-600'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${statusConfig.dot}`} />
          {statusConfig.label}
        </div>

        {/* Orb */}
        <div className="relative flex items-center justify-center w-24 h-24">
          {/* Pulse rings */}
          {appState !== 'idle' && (
            <>
              <span className={`orb-ring ${orbConfig.ring}`} style={{ animationDelay: '0s' }} />
              <span className={`orb-ring ${orbConfig.ring}`} style={{ animationDelay: '0.45s' }} />
            </>
          )}
          <button
            onPointerDown={() => void handleMicPress()}
            onPointerUp={() => void handleMicRelease()}
            onPointerLeave={() => { if (appState === 'recording') void handleMicRelease(); }}
            disabled={appState === 'processing' || appState === 'speaking'}
            className={`relative z-10 w-20 h-20 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer disabled:cursor-not-allowed select-none shadow-xl ${orbConfig.shadow} ${orbConfig.bg} ${appState === 'idle' ? 'active:scale-95' : ''}`}
          >
            {appState === 'processing' ? <ThinkingDots /> :
             appState === 'recording'  ? <Waveform /> :
             appState === 'speaking'   ? (
               <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                 <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
               </svg>
             ) : (
               <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                 <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
               </svg>
             )}
          </button>
        </div>

        <p className="text-xs text-slate-400 font-medium">
          {appState === 'idle' ? 'Press & hold · Release to send' : ' '}
        </p>
      </div>

      {/* ── Settings Modal ── */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm px-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowSettings(false); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg border border-slate-200 overflow-hidden">
            {/* Modal header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                <span className="text-sm font-semibold text-gray-900">Agent System Prompt</span>
              </div>
              <button
                onClick={() => setShowSettings(false)}
                className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition cursor-pointer"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Modal body */}
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-slate-500 leading-relaxed">
                This prompt defines how Orvo behaves. It is sent with every message and stored locally in your browser.
              </p>
              <textarea
                value={draftPrompt}
                onChange={(e) => setDraftPrompt(e.target.value)}
                rows={8}
                className="w-full px-3.5 py-3 text-sm rounded-xl border border-slate-200 bg-slate-50 text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-400 focus:border-transparent resize-none font-mono leading-relaxed"
                placeholder="Enter system prompt..."
              />
              <button
                onClick={() => setDraftPrompt(DEFAULT_SYSTEM_PROMPT)}
                className="text-xs text-indigo-500 hover:text-indigo-700 font-medium cursor-pointer transition"
              >
                Reset to default
              </button>
            </div>

            {/* Modal footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-3.5 bg-slate-50 border-t border-slate-100">
              <button
                onClick={() => setShowSettings(false)}
                className="px-4 py-2 text-sm font-medium text-slate-600 hover:text-slate-800 rounded-lg hover:bg-slate-200 transition cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  const trimmed = draftPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
                  setSystemPrompt(trimmed);
                  localStorage.setItem('orvo-system-prompt', trimmed);
                  setShowSettings(false);
                }}
                className="px-4 py-2 text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg shadow-sm shadow-indigo-200 transition cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
