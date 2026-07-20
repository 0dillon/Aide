// The voice engine: no React in here. It owns the one Web Speech recognizer
// and the one TTS pipeline (neural streaming with browser-native fallback),
// including the sentence queue, restart backoff, echo handling, the
// "aide stop talking" voice interrupt, and tab-visibility arbitration.
// The React provider in ./index.tsx is a thin wrapper over this class.

type SR = any; // Web Speech API isn't in lib.dom

export type VoiceState = {
  active: boolean;
  listening: boolean;
  speaking: boolean;
  interim: string;
  micStatus: string;
  error: string | null;
};

export type VoiceEngineHandlers = {
  // Partial state updates for the UI (orb, status lines).
  onState: (patch: Partial<VoiceState>) => void;
  // A finished user utterance, heard while Aide was NOT talking.
  onFinal: (text: string) => void;
};

const STOP_PHRASE = /\b(stop talking|aide stop|be quiet)\b/;

export class VoiceEngine {
  private handlers: VoiceEngineHandlers;

  private rec: SR | null = null;
  private active = false;
  private speaking = false;
  private speechEndedAt = 0;
  // What Aide is currently saying — used to avoid self-triggering the
  // "stop talking" voice interrupt when Aide itself utters the phrase.
  private currentSpeechText = "";

  // Streamed replies are spoken sentence by sentence: each finished utterance
  // pulls the next queued sentence, and only when the queue runs dry does the
  // mic get the floor back.
  private queue: string[] = [];
  private currentAudio: HTMLAudioElement | null = null;
  private currentUtter: SpeechSynthesisUtterance | null = null;
  // Speech Chrome blocked before the first user interaction, replayed on the
  // first touch or keypress — no visible gate, nothing the user has to find.
  private pendingSpeech: string | null = null;

  // Restart bookkeeping: recognizers die (silence timeouts, network hiccups,
  // our own pauses) and must come back — but a recognizer that dies instantly,
  // over and over, needs backoff, not a hot loop.
  private lastStart = 0;
  private rapidEnds = 0;
  private restartDelay = 300;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private listenOffTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(handlers: VoiceEngineHandlers) {
    this.handlers = handlers;
  }

  static supported(): boolean {
    return typeof window !== "undefined" && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
  }

  start(): void {
    this.active = true;
    this.handlers.onState({ active: true });
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
    // Only the visible tab gets a voice and ears. Without this, every open
    // tab runs its own recognizer and speaks its own replies — two Aides
    // talking over each other the moment a second tab is open.
    if (document.hidden) this.onVisibility();
    else this.startRecognition();
  }

  stop(): void {
    this.active = false;
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.listenOffTimer) clearTimeout(this.listenOffTimer);
    this.detachRecognizer();
    this.stopAllSpeech();
  }

  // Public speak: interrupts whatever is queued and says this instead.
  speak(text: string): void {
    this.queue = [];
    this.speakNow(text);
  }

  // Queue a sentence behind whatever is already being said.
  queueSpeak(text: string): void {
    if (this.speaking) this.queue.push(text);
    else this.speakNow(text);
  }

  // Tap Aide while it talks — or say "aide stop talking" — to cut it off.
  interrupt(): void {
    this.queue = [];
    this.stopAllSpeech();
    this.speaking = false;
    this.handlers.onState({ speaking: false });
    this.speechEndedAt = Date.now();
    if (this.active) this.startRecognition();
  }

  // --- Tab visibility & autoplay unlock ---

  private onVisibility = () => {
    if (document.hidden) {
      this.active = false;
      this.handlers.onState({ active: false });
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.detachRecognizer();
      this.setListening(false);
      this.interrupt();
    } else {
      this.active = true;
      this.handlers.onState({ active: true });
      this.startRecognition();
    }
  };

  private unlock = () => {
    const pending = this.pendingSpeech;
    if (pending) {
      this.pendingSpeech = null;
      this.speak(pending);
    }
  };

  // --- Recognition ---

  // The orb shouldn't flicker every time the recognizer blips through a
  // restart: turning "listening" on is instant, turning it off waits 800ms.
  private setListening(on: boolean): void {
    if (this.listenOffTimer) clearTimeout(this.listenOffTimer);
    if (on) this.handlers.onState({ listening: true });
    else this.listenOffTimer = setTimeout(() => this.handlers.onState({ listening: false }), 800);
  }

  private detachRecognizer(): void {
    const old = this.rec;
    if (!old) return;
    old.onresult = null;
    old.onend = null;
    old.onerror = null;
    try {
      old.abort();
    } catch {}
  }

  // Create a FRESH recognizer each time — Chrome instances can wedge after
  // abort, and a new one is the reliable way back to a working mic.
  private startRecognition(): void {
    if (!this.active || typeof window === "undefined") return;
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) return;

    this.detachRecognizer();

    const rec: SR = new Ctor();
    rec.lang = "en-NG";
    rec.interimResults = true;
    rec.continuous = true;

    const onState = this.handlers.onState;

    // Lifecycle diagnostics: these pinpoint WHERE hearing breaks — mic never
    // opens, opens but no sound (wrong input device), sound but no speech
    // recognized (service problem), or full success.
    rec.onaudiostart = () => {
      console.info("Aide mic: audio capture started");
      onState({ micStatus: "mic open — no sound detected yet" });
    };
    rec.onsoundstart = () => {
      console.info("Aide mic: sound detected");
      onState({ micStatus: "hearing sound" });
    };
    rec.onspeechstart = () => {
      console.info("Aide mic: speech detected");
      onState({ micStatus: "hearing speech…" });
    };

    rec.onresult = (e: any) => {
      onState({ micStatus: "recognizing speech" });
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }
      const clean = finalText.trim();
      // While Aide talks, the mic stays open ONLY to hear "aide stop talking".
      // Everything else heard mid-speech (usually Aide's own echo) is dropped.
      if (this.speaking) {
        const heard = (clean + " " + interimText).toLowerCase();
        const selfEcho = this.currentSpeechText.toLowerCase().includes("stop talking");
        if (!selfEcho && STOP_PHRASE.test(heard)) this.interrupt();
        return;
      }
      onState({ interim: interimText });
      if (!clean || Date.now() - this.speechEndedAt < 400) return;
      this.rapidEnds = 0;
      onState({ interim: "" });
      this.handlers.onFinal(clean);
    };

    rec.onend = () => {
      if (this.rec !== rec) return; // superseded by a newer instance
      const aliveMs = Date.now() - this.lastStart;
      console.info(`Aide mic: recognizer ended after ${aliveMs}ms`);
      this.setListening(false);
      if (!this.active) return;
      // Instant deaths mean something is wrong (usually no internet — Chrome's
      // recognizer needs it). Back off instead of hot-looping.
      if (aliveMs < 1000) {
        this.rapidEnds += 1;
        this.restartDelay = Math.min(this.restartDelay * 2, 4000);
        if (this.rapidEnds === 5) {
          onState({ error: "Aide's hearing keeps cutting out. Speech recognition in Chrome needs an internet connection — retrying." });
        }
      } else {
        this.rapidEnds = 0;
        this.restartDelay = 300;
      }
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.startRecognition(), this.restartDelay);
    };

    rec.onerror = (e: any) => {
      // "no-speech" / "aborted" are routine; onend does the restart.
      if (e?.error === "no-speech") {
        onState({ micStatus: "mic open, but no speech was heard (check the input device)" });
      } else if (e?.error && e.error !== "aborted") {
        console.warn("Aide speech recognition error:", e.error);
        onState({ micStatus: `recognition error: ${e.error}` });
      }
      if (e?.error === "not-allowed" || e?.error === "service-not-allowed") {
        this.active = false;
        onState({ active: false, error: "Microphone access was blocked. Allow the microphone so Aide can hear you." });
      }
    };

    this.rec = rec;
    try {
      rec.start();
      this.lastStart = Date.now();
      this.setListening(true);
      this.handlers.onState({ micStatus: "mic starting…" });
    } catch {
      /* already starting */
    }
  }

  // --- Speech synthesis ---

  private stopAllSpeech(): void {
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.currentUtter = null;
    window.speechSynthesis?.cancel();
  }

  private finishOrNext(): void {
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.speakNow(queued);
      return;
    }
    this.speaking = false;
    this.handlers.onState({ speaking: false });
    this.speechEndedAt = Date.now();
    if (this.active) this.startRecognition();
  }

  private async speakNow(text: string): Promise<void> {
    if (typeof window === "undefined") return;
    // The mic STAYS OPEN while Aide talks — onresult drops everything heard
    // mid-speech except the "aide stop talking" interrupt phrase.
    this.speaking = true;
    this.currentSpeechText = text;
    this.handlers.onState({ speaking: true });

    // Stop any running neural audio
    if (this.currentAudio) {
      this.currentAudio.onended = null;
      this.currentAudio.onerror = null;
      this.currentAudio.pause();
      this.currentAudio = null;
    }

    // Server-side neural TTS, streamed: the <audio> element points straight
    // at the GET endpoint, so playback begins while synthesis is still in
    // flight instead of after the whole MP3 has downloaded.
    try {
      const audio = new Audio(`/api/tts?text=${encodeURIComponent(text)}`);
      this.currentAudio = audio;

      let audioStarted = false;
      const watchdog = setTimeout(() => {
        if (!audioStarted && this.currentAudio === audio) {
          console.warn("Neural audio never started — falling back to the browser voice.");
          stopAudio();
          this.speakWithBrowserVoice(text);
        }
      }, 3000);

      const stopAudio = () => {
        clearTimeout(watchdog);
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        if (this.currentAudio === audio) this.currentAudio = null;
      };

      audio.onplay = () => {
        audioStarted = true;
      };
      audio.onended = () => {
        stopAudio();
        this.finishOrNext();
      };
      audio.onerror = () => {
        console.warn("Neural audio playback failed — falling back to the browser voice.");
        const wasCurrent = this.currentAudio === audio;
        stopAudio();
        if (wasCurrent) this.speakWithBrowserVoice(text);
      };

      await audio.play();
    } catch (err) {
      console.warn("Neural TTS failed, falling back to browser-native:", err);
      this.speakWithBrowserVoice(text);
    }
  }

  // Browser-native SpeechSynthesis fallback.
  private speakWithBrowserVoice(text: string): void {
    if (!window.speechSynthesis) return;

    const u = new SpeechSynthesisUtterance(text);
    const voice = getBestNativeVoice(window.speechSynthesis);
    if (voice) u.voice = voice;
    else u.lang = "en-NG";

    // Mark this utterance as the current one BEFORE cancel(): the canceled
    // utterance's own end/error handlers must not resume the mic while this
    // new one is talking.
    this.currentUtter = u;
    window.speechSynthesis.cancel();

    // Watchdogs: on machines with no TTS voices (common on Linux), the
    // utterance never starts and never errors — without these, the mic
    // would stay paused forever waiting for a speech that never ends.
    let ttsStarted = false;
    let startWatchdog: ReturnType<typeof setTimeout> | null = null;
    let runawayWatchdog: ReturnType<typeof setTimeout> | null = null;

    const resumeNative = () => {
      if (startWatchdog) clearTimeout(startWatchdog);
      if (runawayWatchdog) clearTimeout(runawayWatchdog);
      if (this.currentUtter !== u) return; // superseded
      this.currentUtter = null;
      this.finishOrNext();
    };

    u.onstart = () => {
      ttsStarted = true;
    };
    u.onend = resumeNative;
    u.onerror = (ev: any) => {
      // Chrome blocks speech before the first user interaction; stash the
      // text for the document-level unlock listener to replay.
      if (ev?.error === "not-allowed") this.pendingSpeech = text;
      resumeNative();
    };

    startWatchdog = setTimeout(() => {
      if (!ttsStarted && this.currentUtter === u) {
        console.warn("Aide TTS never started — no speech voices available? Resuming the mic.");
        this.handlers.onState({
          error: "Aide can't speak aloud in this browser (no speech voices found) — it can still hear you and show replies as text.",
        });
        window.speechSynthesis.cancel();
        resumeNative();
      }
    }, 2500);
    // Generous per-text cap in case onend never fires mid-speech.
    runawayWatchdog = setTimeout(() => {
      if (this.currentUtter === u) {
        window.speechSynthesis.cancel();
        resumeNative();
      }
    }, 10000 + text.length * 90);

    window.speechSynthesis.speak(u);
  }
}

function getBestNativeVoice(synth: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (typeof window === "undefined" || !synth) return null;
  const voices = synth.getVoices();
  if (voices.length === 0) return null;

  // 1. Try en-NG (Nigerian English)
  const ng = voices.find((v) => v.lang.toLowerCase().replace("_", "-") === "en-ng");
  if (ng) return ng;

  // 2. Try high-quality English voices (Google, Siri, Microsoft Natural)
  const prefs = ["natural", "google", "siri", "zira", "david", "samantha", "daniel", "hazel"];
  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  for (const p of prefs) {
    const match = en.find((v) => v.name.toLowerCase().includes(p));
    if (match) return match;
  }

  return en[0] ?? null;
}
