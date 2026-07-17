"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Thin wrapper over the browser's Web Speech API. STT via SpeechRecognition,
// TTS via speechSynthesis. Typed loosely because these APIs aren't in lib.dom.
type SR = any;

export function useVoice(onFinal: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [supported, setSupported] = useState(true);
  const recRef = useRef<SR | null>(null);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  useEffect(() => {
    const Ctor = (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition)) || null;
    if (!Ctor) {
      setSupported(false);
      return;
    }
    const rec: SR = new Ctor();
    rec.lang = "en-NG";
    rec.interimResults = true;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      setInterim(interimText);
      if (finalText.trim()) {
        setInterim("");
        onFinalRef.current(finalText.trim());
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    return () => rec.abort();
  }, []);

  const listen = useCallback(() => {
    if (!recRef.current || listening) return;
    try {
      window.speechSynthesis?.cancel();
      recRef.current.start();
      setListening(true);
    } catch {
      /* already started */
    }
  }, [listening]);

  const stop = useCallback(() => {
    recRef.current?.stop();
    setListening(false);
  }, []);

  const speak = useCallback((text: string, onDone?: () => void) => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      onDone?.();
      return;
    }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-NG";
    u.rate = 1.0;
    u.onend = () => onDone?.();
    window.speechSynthesis.speak(u);
  }, []);

  return { listening, interim, supported, listen, stop, speak };
}
