"use client";
import { useCallback, useEffect, useRef, useState } from "react";

type Result = { isFinal: boolean; 0: { transcript: string } };
type Engine = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
type W = Window & { SpeechRecognition?: new () => Engine; webkitSpeechRecognition?: new () => Engine };

const ctor = () => (typeof window === "undefined" ? undefined : (window as W).SpeechRecognition ?? (window as W).webkitSpeechRecognition);

/** Browser dictation (Web Speech API). Transcription may be handled by the browser vendor's service. */
export function useDictation(lang = "ar-SA") {
  const engine = useRef<Engine | null>(null);
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setSupported(Boolean(ctor())); return () => engine.current?.abort(); }, []);

  const stop = useCallback(() => { engine.current?.stop(); setListening(false); }, []);
  const abort = useCallback(() => { engine.current?.abort(); setListening(false); }, []);

  /** `base` is the text already in the field; `onText` receives base + live transcript. */
  const start = useCallback((base: string, onText: (text: string) => void, continuous = false) => {
    const Engine = ctor();
    if (!Engine) { setError("التعرف الصوتي غير متاح في هذا المتصفح. استخدم Safari محدثاً أو إملاء لوحة المفاتيح."); return; }
    engine.current?.abort();
    const e = new Engine(); engine.current = e;
    e.lang = lang; e.continuous = continuous; e.interimResults = true;
    let committed = "";
    e.onresult = (ev) => {
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) committed += r[0].transcript + " "; else interim += r[0].transcript; }
      onText([base, committed.trim(), interim.trim()].filter(Boolean).join(" "));
    };
    e.onerror = (ev) => {
      setError(ev.error === "not-allowed" || ev.error === "service-not-allowed" ? "تعذّر استخدام الميكروفون. اسمح به من إعدادات Safari أو استخدم إملاء لوحة المفاتيح." : ev.error === "no-speech" ? "لم يُسمع كلام. حاول مرة أخرى." : "خطأ في التعرف الصوتي: " + ev.error);
      setListening(false);
    };
    e.onend = () => setListening(false);
    try { setError(""); e.start(); setListening(true); } catch { setError("تعذر بدء الاستماع."); setListening(false); }
  }, [lang]);

  return { supported, listening, error, start, stop, abort, clearError: () => setError("") };
}
