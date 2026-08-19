// The voice engine: no React in here. It owns the one Web Speech recognizer
// and the one TTS pipeline (neural streaming with browser-native fallback),
// including the sentence queue, restart backoff, echo handling, the
// "aide stop talking" voice interrupt, and tab-visibility arbitration.
// The React provider in ./index.tsx is a thin wrapper over this class.

type SR = any; // Web Speech API isn't in lib.dom

// A sentence waiting its turn at the speaker, together with its audio once
// synthesis has been started for it. Holding the promise ON the queue entry
// (rather than in a single text-keyed slot) means a sentence can never be
// confused with an identical one earlier in the reply.
type QueuedSpeech = { text: string; audio?: Promise<string | null> };

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
// The budget above is silence measured from the USER's point of view, which
// starts when they stop talking — not when the request goes out. The quiet
// period that decides they finished is part of that silence, so it is
// subtracted, and this is the floor so the filler can never fire on top of
// its own trigger.
const FILLER_MIN_WAIT_MS = 1500;

// Holding the microphone open forever costs battery, keeps a recognizer
// streaming the room to a speech service, and means every stray noise is being
// listened to. After this much quiet Aide closes the mic and waits to be woken.
const IDLE_SLEEP_MS = 90_000;
const SLEEP_NOTICE = "I'll stop listening for now. Tap the screen or press any key when you want me.";

// Echo defence, part one: audio.onended fires when playback reaches the end
// of the buffer, but the speaker and the room keep sounding briefly after
// that. Keeping the mic shut across that decay means the tail is never
// captured at all. Deliberately short — every millisecond here is a
// millisecond of a fast user's first word that would be clipped.
const MIC_REOPEN_DELAY_MS = 150;
// Echo defence, part two: how long after Aide's voice stops that a transcript
// is still checked against what Aide just said. A time-only guard cannot do
// this job — recognizer results surface well after the audio was captured, so
// a window wide enough to catch echo also throws away a quick reply. Matching
// on CONTENT instead lets a fast user through and still rejects Aide's own
// words coming back.
const ECHO_WINDOW_MS = 1500;

// A "final" result from the Web Speech API means the recognizer heard a
// pause — not that the user finished their thought. Thinking mid-sentence,
// reading out an account number, or taking a breath all produce one. So a
// final is buffered rather than acted on, and only becomes a turn once the
// user has been quiet this long. Any interim result (or speech starting
// again) restarts the countdown, so this is the wait after someone genuinely
// stops — not a flat tax on every turn.
const FINAL_QUIET_MS = 450;

// How many sentences ahead to synthesize. The model streams sentences faster
// than TTS can render them, so fetching only one ahead leaves each sentence
// waiting on a round trip that could have run during the previous one. A
// small lookahead overlaps them; a large one would waste synthesis on
// sentences an interrupt is about to discard.
const PREFETCH_AHEAD = 2;

const MIC_SILENT_WARNING =
  "I can't hear your microphone. It may be muted or turned off. Please check your microphone, then talk to me again. You can also type to me in the box on the screen.";

export class VoiceEngine {
  private handlers: VoiceEngineHandlers;

  private rec: SR | null = null;
  private active = false;
  private speaking = false;
  private speechEndedAt = 0;

  // Which utterance owns the speaker. `speechSeq` is a monotonic id handed to
  // each accepted sentence; `activeSpeech` is the id currently holding the
  // floor, and is claimed SYNCHRONOUSLY — before the TTS fetch is awaited.
  // That matters: synthesis takes seconds, and until this existed a sentence
  // arriving mid-fetch saw no <audio> element yet, assumed the speaker was
  // free, and started itself — so the earlier sentence was thrown away when
  // its audio finally landed. Whole opening paragraphs went unspoken. 0 means
  // nothing holds the floor.
  private speechSeq = 0;
  private activeSpeech = 0;

  // Streamed replies are spoken sentence by sentence: each finished utterance
  // pulls the next queued sentence, and only when the queue runs dry does the
  // mic get the floor back.
  private queue: QueuedSpeech[] = [];
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
  // Delays the mic reopening after Aide finishes speaking (echo settle time).
  private reopenTimer: ReturnType<typeof setTimeout> | null = null;
  // The last few things Aide said, for the echo check. Only recent utterances
  // matter: echo can only ever be sound that just left the speaker.
  private recentSpeech: string[] = [];
  // "Is the user actually done talking?" — final results accumulate here and
  // only become a turn once the room has been quiet for FINAL_QUIET_MS.
  private finalQuietTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingFinalText = "";
  // When the user was last heard making any sound we accepted. Lets the
  // thinking-filler stay honest about how long they have actually waited.
  private lastHeardAt = 0;

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
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    if (this.finalQuietTimer) clearTimeout(this.finalQuietTimer);
    this.finalQuietTimer = null;
    this.pendingFinalText = "";
    this.detachRecognizer();
    this.stopAllSpeech();
  }

  // True while anything is playing or queued — lets callers wait for Aide to
  // finish a sentence before doing something disruptive (e.g. reload on logout).
  isSpeakingNow(): boolean {
    // activeSpeech covers the gap where a sentence has been accepted and its
    // audio is still downloading — nothing is audible yet, but a turn is very
    // much still in progress.
    return !!(this.currentAudio || this.currentUtter) || this.activeSpeech !== 0 || this.queue.length > 0;
  }

  // Public speak: interrupts whatever is queued and says this instead.
  speak(text: string): void {
    this.discardQueue(); // primed sentences from the old reply must not play
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
    //
    // The countdown starts from when the USER stopped talking, not from this
    // call: deciding they had finished already cost them a beat of silence,
    // and that beat is part of the same wait they are sitting through. Typed
    // messages (nothing heard recently) just get the full budget.
    const sinceHeard = Date.now() - this.lastHeardAt;
    const alreadyWaited = this.lastHeardAt && sinceHeard < 3000 ? sinceHeard : 0;
    const fillerDelay = Math.max(FILLER_MIN_WAIT_MS, FILLER_AFTER_MS - alreadyWaited);

    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.replyAbandoned || !this.replyPending) return;
      if (this.currentAudio || this.currentUtter || this.queue.length > 0) return;
      this.fillerIndex = (this.fillerIndex + 1) % THINKING_FILLERS.length;
      this.speakNow(THINKING_FILLERS[this.fillerIndex]);
    }, fillerDelay);
  }

  endReply(): void {
    this.replyPending = false;
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    // The last chunk may have finished playing while we were still holding the
    // turn open — close it out now. activeSpeech must be clear too, or this
    // would end the turn on top of a sentence still being synthesized.
    if (!this.currentAudio && !this.currentUtter && this.activeSpeech === 0 && this.queue.length === 0 && this.speaking) {
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
    // The speaker is taken — either audible, or downloading the sentence
    // ahead of this one. Queue behind it and get synthesis started early.
    if (this.activeSpeech !== 0) {
      this.queue.push({ text });
      this.primeQueue();
      return;
    }
    // Genuinely free: either idle, or holding the turn open mid-reply waiting
    // for exactly this. Speak it straight away.
    this.speakNow(text);
  }

  // Tap Aide while it talks — or say "aide stop talking" — to cut it off.
  interrupt(): void {
    this.discardQueue();
    this.activeSpeech = 0; // supersedes any synthesis still in flight
    // Whatever is still streaming from the model must not be spoken.
    this.replyPending = false;
    this.replyAbandoned = true;
    if (this.ackTimer) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    // A deliberate interrupt means "start fresh" — any not-yet-dispatched
    // fragment from before belongs to a turn the user just cut off.
    if (this.finalQuietTimer) clearTimeout(this.finalQuietTimer);
    this.finalQuietTimer = null;
    this.pendingFinalText = "";
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
    this.stopAllSpeech();
    this.speaking = false;
    this.handlers.onState({ speaking: false });
    this.speechEndedAt = Date.now();
    // A tap or keypress is the user saying they are about to talk RIGHT NOW —
    // reopen at once rather than paying the decay delay. stopAllSpeech() cut
    // the audio dead, so there is no tail to wait out.
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
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = null;
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

  // Hold a final result rather than acting on it: the Web Speech API
  // finalizes on any short pause, not just at end-of-turn, so several of
  // these can make up one spoken sentence. They accumulate here and are
  // handed over as a single turn once the user actually stops.
  private bufferFinal(text: string): void {
    this.pendingFinalText = this.pendingFinalText ? `${this.pendingFinalText} ${text}` : text;
    this.armFinalDispatch();
  }

  // (Re)start the quiet period that decides the user has finished. Called
  // again on every further word — a pause only counts as the end of a turn
  // if nothing follows it.
  private armFinalDispatch(): void {
    if (!this.pendingFinalText) return;
    if (this.finalQuietTimer) clearTimeout(this.finalQuietTimer);
    this.finalQuietTimer = setTimeout(() => {
      this.finalQuietTimer = null;
      const full = this.pendingFinalText.trim();
      this.pendingFinalText = "";
      if (full) this.handlers.onFinal(full);
    }, FINAL_QUIET_MS);
  }

  // Is this transcript Aide hearing itself? The mic is shut while Aide talks
  // and stays shut through the speaker's decay, so this only has to catch
  // what slips past that — which makes a content match affordable, and a
  // content match is what lets a user who answers instantly still be heard.
  private looksLikeEcho(heard: string): boolean {
    if (!this.speechEndedAt || Date.now() - this.speechEndedAt > ECHO_WINDOW_MS) return false;
    const said = normalizeForMatch(this.recentSpeech.join(" "));
    const h = normalizeForMatch(heard);
    if (!said || !h) return false;
    // A clean capture of the tail is a literal fragment of what was just said.
    if (said.includes(h)) return true;
    // Echo often comes back garbled, so also reject a transcript made almost
    // entirely of Aide's own words. Short utterances are exempt: "yes", "no",
    // or "my balance" are far likelier to be the user than a mangled echo,
    // and wrongly swallowing those is worse than hearing one stray word.
    const words = h.split(" ");
    if (words.length < 4) return false;
    const overlap = words.filter((w) => said.includes(w)).length;
    return overlap / words.length >= 0.8;
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
      // Talking again after a pause: they had not finished after all, so hold
      // the buffered fragment back and wait for the rest.
      this.armFinalDispatch();
      onState({ micStatus: "hearing speech…" });
    };

    rec.onresult = (e: any) => {
      // Belt and braces: the recognizer is stopped before Aide speaks, but a
      // result already in flight can still land here. Anything heard while
      // Aide is talking is its own voice out of the speaker, never the user.
      if (this.speaking) return;
      onState({ micStatus: "recognizing speech" });
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += t;
        else interimText += t;
      }

      const partial = interimText.trim();
      if (partial && !this.looksLikeEcho(partial)) {
        onState({ interim: interimText });
        this.lastHeardAt = Date.now();
        // Still mid-sentence: whatever is buffered is not a finished turn yet.
        this.armFinalDispatch();
      }

      const clean = finalText.trim();
      if (!clean) return;
      if (this.looksLikeEcho(clean)) {
        console.info("Aide mic: ignored an echo of Aide's own voice:", clean);
        return;
      }
      this.rapidEnds = 0;
      this.lastHeardAt = Date.now();
      onState({ interim: "" });
      this.bufferFinal(clean);
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
    // The utterance that was holding the floor is done with it.
    this.activeSpeech = 0;
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.primeQueue(); // keep the lookahead topped up
      this.speakNow(queued.text, queued.audio);
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
    if (this.active) {
      // Let the speaker's decay pass before the mic reopens, rather than
      // racing it the instant playback ends. Kept very short so a user who
      // answers straight away is not clipped.
      if (this.reopenTimer) clearTimeout(this.reopenTimer);
      this.reopenTimer = setTimeout(() => {
        this.reopenTimer = null;
        if (this.active && !this.speaking && !this.dormant) this.startRecognition();
      }, MIC_REOPEN_DELAY_MS);
    }
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

  // Start synthesizing the next few sentences while the current one is still
  // speaking. Without this the queue is strictly serial and every sentence
  // boundary costs a full TTS round trip — seconds of dead air mid-thought.
  private primeQueue(): void {
    const ahead = Math.min(PREFETCH_AHEAD, this.queue.length);
    for (let i = 0; i < ahead; i++) {
      const item = this.queue[i];
      if (!item.audio) item.audio = this.fetchSpeech(item.text);
    }
  }

  // Drop everything still waiting to be said. Any audio already synthesized
  // for those sentences has an object URL attached, so it is revoked rather
  // than left to leak once the promise resolves into nothing.
  private discardQueue(): void {
    for (const item of this.queue) {
      void item.audio?.then((src) => src && URL.revokeObjectURL(src)).catch(() => {});
    }
    this.queue = [];
  }

  private async speakNow(text: string, prefetched?: Promise<string | null>): Promise<void> {
    if (typeof window === "undefined") return;
    // Claim the speaker BEFORE the first await. Everything below this line
    // takes seconds, and a sentence arriving in the meantime must queue rather
    // than assume the floor is free and start talking over this one.
    const seq = ++this.speechSeq;
    this.activeSpeech = seq;
    // HALF DUPLEX: the microphone is closed for as long as Aide is talking.
    // Leaving it open meant the recognizer transcribed Aide's own voice out of
    // the speakers and fed it back as if the user had said it. Echo
    // cancellation can't be applied to SpeechRecognition, so the only reliable
    // cure is to not listen while talking. Interrupting is by tap or keypress
    // instead (see the pointer/key listeners in start()).
    this.pauseRecognition();
    this.speaking = true;
    // Remember it for looksLikeEcho(). Only the last few utterances can
    // possibly still be in the air, so the rest is dropped.
    this.recentSpeech.push(text);
    if (this.recentSpeech.length > 3) this.recentSpeech.shift();
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
      // Either this sentence was already being synthesized while the previous
      // one played, or it starts now.
      const pending = prefetched ?? this.fetchSpeech(text);

      // The moment we know what is playing, start fetching what comes next.
      this.primeQueue();

      const src = await pending;

      // A newer utterance took the floor while this audio downloaded (an
      // interrupt, or a fresh reply) — drop it rather than talk over them.
      // Checked before the null branch so a superseded failure cannot drag
      // the browser voice in on top of whatever is now speaking.
      if (this.activeSpeech !== seq) {
        if (src) URL.revokeObjectURL(src);
        return;
      }

      if (src === null) {
        console.warn("Neural TTS unavailable for this sentence — using the browser voice.");
        this.speakWithBrowserVoice(text, seq);
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
        if (wasCurrent) this.speakWithBrowserVoice(text, seq);
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
        // Release the floor, or every later sentence queues behind a turn
        // that will never finish and the reply is lost.
        if (this.activeSpeech === seq) this.activeSpeech = 0;
        this.handlers.onState({ speaking: false });
        // Speaking was paused for a sentence that never played, so nothing
        // would reopen the mic. The user can still talk to Aide even if they
        // haven't heard it yet — start listening again.
        this.speechEndedAt = Date.now();
        if (this.active) this.startRecognition();
        return;
      }
      if (this.activeSpeech !== seq) return; // superseded while failing
      console.warn("Neural TTS failed, falling back to browser-native:", err);
      this.speakWithBrowserVoice(text, seq);
    }
  }

  // Browser-native SpeechSynthesis fallback.
  private speakWithBrowserVoice(text: string, seq: number): void {
    // No synthesis at all in this browser. Hand the floor on rather than
    // returning holding it — otherwise the rest of the reply queues behind a
    // sentence that can never finish, and nothing more is ever spoken.
    if (!window.speechSynthesis) {
      this.finishOrNext();
      return;
    }

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
      if (this.currentUtter !== u || this.activeSpeech !== seq) return; // superseded
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

// Flatten text to bare lowercase words for the echo comparison. Punctuation
// and casing never survive the round trip through a speaker and a recognizer,
// so matching on them would only produce misses.
function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
