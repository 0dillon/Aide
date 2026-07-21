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
  // Mic deliberately closed after a stretch of silence. Not an error — Aide is
  // waiting to be woken, and any tap or key press brings it back.
  dormant: boolean;
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

// A mic that opens but only ever delivers silence — almost always an OS or
// hardware mute — leaves a blind user talking into the void with no cue. After
// this many full listen windows with the mic open but no sound EVER heard this
// session, Aide says the problem out loud instead of sitting there deaf.
const SILENT_CYCLES_BEFORE_WARNING = 2;
// Only a recognizer that actually ran a full window counts as "silent" — an
// instant death (aliveMs < this) is a network problem, handled separately.
const MIC_SILENT_MIN_MS = 3000;
// Where neural speech comes from. Locally that's the Node route, which keeps a
// warm Python subprocess for speed; on Vercel a serverless function can't own a
// long-lived child process, so NEXT_PUBLIC_TTS_PATH points at the native Python
// function (/api/speak) instead. Either way the browser voice is the fallback.
const TTS_PATH = process.env.NEXT_PUBLIC_TTS_PATH || "/api/tts";

// Last-resort filler for when the model produces nothing at all for a while.
// Aide is instructed to open every reply with its own short sentence, so this
// should rarely be heard — hearing it every turn would be a verbal tic, not
// conversation. The phrases are a FIXED set so the long Cache-Control on
// /api/speak applies and they play instantly; they rotate so a slow patch
// doesn't repeat the same words back to back.
const THINKING_FILLERS = ["One moment.", "Let me check.", "Just a second.", "Bear with me."];
// Measured against production: DeepSeek's first sentence reaches the speaker at
// roughly 3.5s. Anything below that fires on EVERY turn, which is how a helpful
// bridge turns into a verbal tic. This sits past it, so it only speaks when a
// reply is genuinely stuck.
const FILLER_AFTER_MS = 4200;

// Holding the microphone open forever costs battery, keeps a recognizer
// streaming the room to a speech service, and means every stray noise is being
// listened to. After this much quiet Aide closes the mic and waits to be woken.
const IDLE_SLEEP_MS = 90_000;
const SLEEP_NOTICE = "I'll stop listening for now. Tap the screen or press any key when you want me.";

const MIC_SILENT_WARNING =
  "I can't hear your microphone. It may be muted or turned off. Please check your microphone, then talk to me again. You can also type to me in the box on the screen.";

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
  // True while a reply is still streaming in from the model. The queue running
  // dry mid-reply does NOT mean Aide finished talking — it means the next
  // sentence hasn't been generated yet. Without this the turn ends early, the
  // mic re-opens, and the rest of the sentence arrives seconds later as if
  // Aide started over.
  private replyPending = false;
  // Set when the user interrupts mid-reply: the model keeps streaming
  // sentences afterwards, and none of them may be spoken. Cleared by the next
  // beginReply().
  private replyAbandoned = false;
  private ackTimer: ReturnType<typeof setTimeout> | null = null;
  private fillerIndex = -1;
  // Sleep/wake: the mic closes after a stretch of silence and a gesture
  // reopens it, so Aide isn't streaming an empty room indefinitely.
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private dormant = false;
  // The next sentence's audio, already downloading while the current one
  // speaks — this is what keeps sentence boundaries seamless.
  private prefetch: { text: string; audio: Promise<string | null> } | null = null;
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
  // Dead-mic detection: consecutive listen windows that opened the mic but
  // heard no sound, whether we've EVER heard sound this session, and whether
  // we've already spoken the mute warning (so it fires once, not every cycle).
  private silentCycles = 0;
  private everHeardSound = false;
  private micWarned = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private listenOffTimer: ReturnType<typeof setTimeout> | null = null;
  // Fires if a recognizer we started never opens the mic. Without it, a
  // recognizer that neither starts nor ends leaves Aide permanently deaf.
  private openTimer: ReturnType<typeof setTimeout> | null = null;

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
    else {
      this.startRecognition();
      this.armIdleTimer();
    }

    // Warm the fillers into the browser cache (and the serverless function)
    // while the greeting plays, so the first time one is genuinely needed it
    // starts instantly instead of paying full synthesis latency.
    for (const phrase of THINKING_FILLERS) {
      void fetch(`${TTS_PATH}?text=${encodeURIComponent(phrase)}`).catch(() => {});
    }
  }

  // Speak-only mode for browsers with no SpeechRecognition (Firefox, most iOS):
  // Aide can't listen, but it must still TALK — a blind user cannot be left at
  // a silent wall. No mic is opened; we only wire the autoplay-unlock listeners
  // so the first queued message replays on the user's first tap or keypress.
  enableSpeechOnly(): void {
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
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
    this.prefetch = null; // a primed sentence from the old reply must not play
    this.speakNow(text);
  }

  // Bracket a streaming reply: between these calls, an empty queue means
  // "waiting for more words", not "done speaking".
  beginReply(): void {
    this.replyPending = true;
    this.replyAbandoned = false;

    // A blind user gets no spinner. Several seconds of silence after speaking
    // is indistinguishable from the app being broken, so if the model hasn't
    // produced anything audible shortly, say something. Only fires when the
    // wait is real — a fast reply cancels it before it is ever heard.
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.replyAbandoned || !this.replyPending) return;
      if (this.currentAudio || this.currentUtter || this.queue.length > 0) return;
      this.fillerIndex = (this.fillerIndex + 1) % THINKING_FILLERS.length;
      this.speakNow(THINKING_FILLERS[this.fillerIndex]);
    }, FILLER_AFTER_MS);
  }

  endReply(): void {
    this.replyPending = false;
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    // The last chunk may have finished playing while we were still holding the
    // turn open — close it out now.
    if (!this.currentAudio && !this.currentUtter && this.queue.length === 0 && this.speaking) {
      this.finishOrNext();
    }
  }

  // Queue a sentence behind whatever is already being said.
  queueSpeak(text: string): void {
    if (this.replyAbandoned) return; // user cut this reply off
    // Real words arrived in time — no need to stall.
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    // Something is actively playing — queue behind it and prime the pipeline.
    if (this.currentAudio || this.currentUtter) {
      this.queue.push(text);
      this.primeNext();
      return;
    }
    // Nothing is playing: either idle, or holding the turn open mid-reply
    // waiting for exactly this. Speak it straight away.
    this.speakNow(text);
  }

  // Tap Aide while it talks — or say "aide stop talking" — to cut it off.
  interrupt(): void {
    this.queue = [];
    this.prefetch = null;
    this.currentSpeechText = ""; // supersedes any download still in flight
    // Whatever is still streaming from the model must not be spoken.
    this.replyPending = false;
    this.replyAbandoned = true;
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
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

  // One gesture handler for two jobs. First, it replays speech the browser
  // refused before the user had interacted (every phone does this). Second,
  // while Aide is talking, ANY tap or key press cuts it off — a blind user
  // shouldn't have to find a specific button, and with the mic closed during
  // speech there's no longer a spoken way to interrupt.
  private unlock = (e: Event) => {
    const pending = this.pendingSpeech;
    if (pending) {
      this.pendingSpeech = null;
      this.speak(pending);
      return;
    }
    // Asleep after a quiet spell — any gesture brings the mic back.
    if (this.dormant) {
      this.wake();
      return;
    }
    if (!this.speaking) {
      this.armIdleTimer(); // still around; don't nod off mid-interaction
      return;
    }
    // Typing to Aide, or using a control, shouldn't count as "shut up".
    const el = e.target as HTMLElement | null;
    if (el?.closest("input, textarea, select, button, a")) return;
    this.interrupt();
  };

  // --- Recognition ---

  // The orb shouldn't flicker every time the recognizer blips through a
  // restart: turning "listening" on is instant, turning it off waits 800ms.
  private setListening(on: boolean): void {
    if (this.listenOffTimer) clearTimeout(this.listenOffTimer);
    if (on) this.handlers.onState({ listening: true });
    else this.listenOffTimer = setTimeout(() => this.handlers.onState({ listening: false }), 800);
  }

  private scheduleRestart(delay: number): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.startRecognition(), delay);
  }

  // Restart the silence countdown. Called whenever Aide hears something or
  // finishes speaking — i.e. whenever the conversation is demonstrably alive.
  private armIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.active || this.speaking || this.dormant) return;
      this.dormant = true;
      this.pauseRecognition();
      this.handlers.onState({ dormant: true, micStatus: "asleep — tap to wake" });
      // Say so, or a blind user has no way to know the mic just closed.
      this.speakNow(SLEEP_NOTICE);
    }, IDLE_SLEEP_MS);
  }

  // Bring the mic back after sleep. Triggered by any tap or key press.
  private wake(): void {
    if (!this.dormant) return;
    this.dormant = false;
    this.handlers.onState({ dormant: false, micStatus: "waking up…" });
    if (this.active) this.startRecognition();
    this.armIdleTimer();
  }

  // Close the mic and cancel anything that would reopen it. Used whenever Aide
  // is about to speak, so its own voice can never be transcribed as input.
  private pauseRecognition(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.detachRecognizer();
    this.rec = null;
    this.setListening(false);
  }

  private detachRecognizer(): void {
    if (this.openTimer) clearTimeout(this.openTimer);
    this.openTimer = null;
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

    // Per-session flags read in onend to tell "mic opened but stayed silent"
    // (a muted device) apart from "mic never opened" and "mic heard speech".
    let sawAudioStart = false;
    let sawSound = false;

    // Lifecycle diagnostics: these pinpoint WHERE hearing breaks — mic never
    // opens, opens but no sound (wrong input device), sound but no speech
    // recognized (service problem), or full success.
    rec.onaudiostart = () => {
      console.info("Aide mic: audio capture started");
      sawAudioStart = true;
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = null;
      // "Listening" is only true once the mic is genuinely open. Announcing it
      // at start() meant the orb claimed to be listening while the recognizer
      // was in fact dead — the worst possible lie to tell a blind user.
      this.setListening(true);
      onState({ micStatus: "mic open — no sound detected yet" });
    };
    rec.onsoundstart = () => {
      console.info("Aide mic: sound detected");
      sawSound = true;
      // A live mic clears the dead-mic bookkeeping: reset the silent streak,
      // remember hearing worked, and retract any spoken/visible mute warning.
      this.silentCycles = 0;
      this.everHeardSound = true;
      if (this.micWarned) {
        this.micWarned = false;
        onState({ error: null });
      }
      onState({ micStatus: "hearing sound" });
    };
    rec.onspeechstart = () => {
      console.info("Aide mic: speech detected");
      this.armIdleTimer(); // someone is talking — the session is alive
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
      // Belt and braces: the recognizer is stopped before Aide speaks, but a
      // result already in flight can still land here. Anything heard while
      // speaking is Aide's own voice coming back through the speaker.
      if (this.speaking) return;
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

      // Dead mic: it opened and ran a full window but never heard a sound, and
      // nothing has been heard all session. That's a muted/disabled device, not
      // a quiet user (a live mic trips onsoundstart on room tone within a cycle
      // or two). Say it aloud — a blind user has no other way to know.
      if (sawAudioStart && !sawSound && !this.everHeardSound && aliveMs >= MIC_SILENT_MIN_MS) {
        this.silentCycles += 1;
        if (this.silentCycles >= SILENT_CYCLES_BEFORE_WARNING && !this.micWarned && !this.speaking) {
          this.micWarned = true;
          onState({
            micStatus: "no sound from your microphone — it may be muted",
            error: "Aide can't hear your microphone. It may be muted or turned off — check it, then talk again, or type to Aide below.",
          });
          console.warn("Aide mic: opened but silent all session — warning the user aloud.");
          this.speak(MIC_SILENT_WARNING); // resumes recognition when it finishes
          return;
        }
      }

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
      this.scheduleRestart(this.restartDelay);
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
      this.handlers.onState({ micStatus: "mic starting…" });
      // A recognizer that never opens the mic also never fires onend, so
      // nothing would ever schedule a restart — Aide would sit there deaf
      // while the UI insists it's listening. Give it 4s to report audio.
      this.openTimer = setTimeout(() => {
        if (this.rec !== rec || !this.active) return;
        console.warn("Aide mic: recognizer never opened the mic — restarting.");
        onState({ micStatus: "mic did not open — restarting" });
        this.detachRecognizer();
        this.rec = null;
        this.scheduleRestart(500);
      }, 4000);
    } catch (err) {
      // Chrome throws InvalidStateError when a previous recognizer hasn't
      // released the mic yet. The instance is dead on arrival: it will never
      // fire onend, so the restart chain stops here unless we re-arm it.
      console.warn("Aide mic: start() threw, retrying shortly:", err);
      this.rec = null;
      this.setListening(false);
      this.scheduleRestart(Math.max(this.restartDelay, 500));
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
    // Mid-reply lull: hold the turn open rather than ending it. queueSpeak()
    // resumes playback the moment the next sentence arrives.
    if (this.replyPending) return;
    this.speaking = false;
    this.handlers.onState({ speaking: false });
    this.speechEndedAt = Date.now();
    // Aide just finished the sleep announcement — stay asleep rather than
    // reopening the mic it only just closed.
    if (this.dormant) return;
    if (this.active) this.startRecognition();
    this.armIdleTimer();
  }

  // Download a sentence's audio COMPLETELY before it plays. Pointing an
  // <audio> element straight at the endpoint let playback begin sooner, but it
  // stalled mid-sentence whenever synthesis fell behind the playback cursor —
  // the audible symptom was Aide stopping mid-word and resuming many seconds
  // later. A fully buffered clip always plays gapless.
  private async fetchSpeech(text: string): Promise<string | null> {
    try {
      const res = await fetch(`${TTS_PATH}?text=${encodeURIComponent(forSpeech(text))}`);
      if (!res.ok) return null;
      const blob = await res.blob();
      return blob.size > 0 ? URL.createObjectURL(blob) : null;
    } catch {
      return null;
    }
  }

  // Start synthesizing the NEXT sentence while the current one is still
  // speaking. Without this the queue is strictly serial and every sentence
  // boundary costs a full TTS round trip — seconds of dead air mid-thought.
  private primeNext(): void {
    const next = this.queue[0];
    if (!next) {
      this.prefetch = null;
      return;
    }
    if (this.prefetch?.text === next) return;
    this.prefetch = { text: next, audio: this.fetchSpeech(next) };
  }

  private async speakNow(text: string): Promise<void> {
    if (typeof window === "undefined") return;
    // HALF DUPLEX: the microphone is closed for as long as Aide is talking.
    // Leaving it open meant the recognizer transcribed Aide's own voice out of
    // the speakers and fed it back as if the user had said it. Echo
    // cancellation can't be applied to SpeechRecognition, so the only reliable
    // cure is to not listen while talking. Interrupting is by tap or keypress
    // instead (see the pointer/key listeners in start()).
    this.pauseRecognition();
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

    // Neural TTS, fully buffered then played. If this sentence was already
    // primed while the previous one spoke, its audio is here (or nearly here)
    // already, so the two run back to back with no audible seam.
    try {
      const pending = this.prefetch?.text === text ? this.prefetch.audio : this.fetchSpeech(text);
      this.prefetch = null;

      // The moment we know what is playing, start fetching what comes next.
      this.primeNext();

      const src = await pending;
      if (src === null) {
        console.warn("Neural TTS unavailable for this sentence — using the browser voice.");
        this.speakWithBrowserVoice(text);
        return;
      }

      // A newer utterance superseded this one while its audio downloaded
      // (an interrupt, or a fresh reply) — drop it rather than talk over them.
      if (this.currentSpeechText !== text) {
        URL.revokeObjectURL(src);
        return;
      }

      const audio = new Audio(src);
      this.currentAudio = audio;

      const release = () => {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        URL.revokeObjectURL(src);
        if (this.currentAudio === audio) this.currentAudio = null;
      };

      audio.onended = () => {
        release();
        this.finishOrNext();
      };
      audio.onerror = () => {
        console.warn("Neural audio playback failed — falling back to the browser voice.");
        const wasCurrent = this.currentAudio === audio;
        release();
        if (wasCurrent) this.speakWithBrowserVoice(text);
      };

      await audio.play();
    } catch (err) {
      // Phones block audio until the user has interacted with the page, so the
      // opening greeting is refused outright. Stash it and let the first tap or
      // keypress replay it — the browser voice would be blocked here too, so
      // falling through to it would just lose the words entirely.
      if ((err as Error)?.name === "NotAllowedError") {
        console.info("Speech blocked before first interaction — will replay on tap.");
        this.pendingSpeech = text;
        this.speaking = false;
        this.handlers.onState({ speaking: false });
        // Speaking was paused for a sentence that never played, so nothing
        // would reopen the mic. The user can still talk to Aide even if they
        // haven't heard it yet — start listening again.
        this.speechEndedAt = Date.now();
        if (this.active) this.startRecognition();
        return;
      }
      console.warn("Neural TTS failed, falling back to browser-native:", err);
      this.speakWithBrowserVoice(text);
    }
  }

  // Browser-native SpeechSynthesis fallback.
  private speakWithBrowserVoice(text: string): void {
    if (!window.speechSynthesis) return;

    const u = new SpeechSynthesisUtterance(forSpeech(text));
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

// Text written to be READ is not text meant to be HEARD. Em dashes make the
// neural voice stop dead mid-clause, currency symbols come out as "N" or get
// skipped, and digit-grouped amounts are read a digit at a time. This rewrites
// a line into something that sounds like a person saying it.
export function forSpeech(text: string): string {
  return (
    text
      // Currency: "₦12,000" / "NGN 12000" → "12000 naira", said naturally.
      .replace(/(?:₦|NGN)\s*([\d,]+(?:\.\d+)?)/gi, (_, n) => `${String(n).replace(/,/g, "")} naira`)
      // Thousands separators otherwise get spelled out digit by digit.
      .replace(/\b(\d{1,3})(?:,(\d{3}))+\b/g, (m) => m.replace(/,/g, ""))
      // Dashes used as punctuation become a comma's worth of pause.
      .replace(/\s*[—–]\s*/g, ", ")
      // A hyphen between words is a pause too; keep hyphenated words intact.
      .replace(/(\s)-(\s)/g, "$1, ")
      // Markdown and stray symbols the model sometimes emits.
      .replace(/[*_`#>|]/g, "")
      .replace(/\s*&\s*/g, " and ")
      // Collapse whatever that left behind.
      .replace(/\s{2,}/g, " ")
      .replace(/\s+([,.!?])/g, "$1")
      .replace(/,\s*,/g, ",")
      .trim()
  );
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
