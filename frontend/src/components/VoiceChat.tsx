import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useVoiceRecorder } from '../hooks/useVoiceRecorder';
import { createSession, sendAudio, clearHistory } from '../api/voice';

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

export default function VoiceChat() {
  const [sessionId, setSessionId] = useState<string>('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [appState, setAppState] = useState<AppState>('idle');
  const [lang, setLang] = useState('hi-IN');
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { start: startRec, stop: stopRec, error: recError } = useVoiceRecorder();

  // Init session on mount
  useEffect(() => {
    const stored = localStorage.getItem('orvo-session');
    void createSession(stored ?? undefined).then((id) => {
      setSessionId(id);
      localStorage.setItem('orvo-session', id);
    });
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (recError) setError(recError);
  }, [recError]);

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
      setError('Recording too short. Please hold and speak.');
      return;
    }

    try {
      const result = await sendAudio(blob, sessionId, lang);

      setMessages((prev) => [
        ...prev,
        { id: uuidv4(), role: 'user', text: result.userText },
        { id: uuidv4(), role: 'assistant', text: result.assistantText },
      ]);

      setAppState('speaking');
      await playAudio(result.audioBase64, result.audioMimeType);
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setAppState('idle');
    }
  }, [appState, stopRec, sessionId, lang, playAudio]);

  const handleClear = useCallback(async () => {
    if (!sessionId) return;
    await clearHistory(sessionId);
    setMessages([]);
    audioRef.current?.pause();
  }, [sessionId]);

  const orbClass =
    appState === 'recording'
      ? 'orb-glow-active scale-110 bg-red-500/20 border-red-500'
      : appState === 'speaking'
        ? 'orb-glow-speaking scale-105 bg-green-500/20 border-green-500'
        : appState === 'processing'
          ? 'orb-glow bg-indigo-500/20 border-indigo-400 animate-pulse'
          : 'orb-glow bg-indigo-500/10 border-indigo-500/60 hover:scale-105 hover:bg-indigo-500/20';

  const orbLabel =
    appState === 'recording'
      ? 'Release to send'
      : appState === 'processing'
        ? 'Processing…'
        : appState === 'speaking'
          ? 'Speaking…'
          : 'Hold to speak';

  return (
    <div className="flex flex-col h-screen max-w-2xl mx-auto px-4 py-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Orvo</h1>
          <p className="text-xs text-gray-500 mt-0.5">Voice AI · Powered by Sarvam + Gemma</p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            className="text-xs bg-gray-800 border border-gray-700 rounded-lg px-2.5 py-1.5 text-gray-300 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>{l.label}</option>
            ))}
          </select>
          {messages.length > 0 && (
            <button
              onClick={() => void handleClear()}
              className="text-xs text-gray-500 hover:text-red-400 transition cursor-pointer bg-transparent border-none"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-3 mb-6 pr-1">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-16 h-16 rounded-full bg-indigo-500/10 border border-indigo-500/30 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              </svg>
            </div>
            <p className="text-gray-400 text-sm font-medium">Hold the button and speak</p>
            <p className="text-gray-600 text-xs mt-1">Supports Hindi, English and 6 more Indian languages</p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-sm'
                    : 'bg-gray-800 text-gray-100 rounded-bl-sm border border-gray-700'
                }`}
              >
                {msg.role === 'assistant' && (
                  <p className="text-xs text-indigo-400 font-medium mb-1">Orvo</p>
                )}
                {msg.text}
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Error */}
      {error && (
        <div className="mb-4 text-center text-xs text-red-400 bg-red-500/10 rounded-lg px-3 py-2 border border-red-500/20">
          {error}
        </div>
      )}

      {/* Orb / Mic Button */}
      <div className="flex flex-col items-center gap-3 pb-2">
        <button
          onPointerDown={() => void handleMicPress()}
          onPointerUp={() => void handleMicRelease()}
          onPointerLeave={() => { if (appState === 'recording') void handleMicRelease(); }}
          disabled={appState === 'processing' || appState === 'speaking'}
          className={`w-24 h-24 rounded-full border-2 transition-all duration-200 cursor-pointer disabled:cursor-not-allowed select-none ${orbClass}`}
          aria-label={orbLabel}
        >
          {appState === 'processing' ? (
            <div className="flex items-center justify-center gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
          ) : (
            <svg
              className={`w-8 h-8 mx-auto transition-colors ${
                appState === 'recording' ? 'text-red-400' : appState === 'speaking' ? 'text-green-400' : 'text-indigo-400'
              }`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          )}
        </button>
        <p className="text-xs text-gray-500">{orbLabel}</p>
      </div>
    </div>
  );
}
