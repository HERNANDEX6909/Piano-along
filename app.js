/* =====================================================================
   Piano Wait Mode — app.js  (vanilla JS, no build step)

   The app shows a note, listens through the microphone, and only moves
   on when you play that note steadily for ~150 ms.

   Sections:
     1. Config & tunable constants
     2. Note helpers
     3. Pitch detection (YIN)  — pure functions, also testable in Node
     4. Built-in songs (public domain only)
     5. MIDI import → single-note sequence
     6. Storage (IndexedDB for songs, localStorage for settings)
     7. Audio engine (mic, AudioWorklet with ScriptProcessor fallback)
     8. Note matcher (stability, wrong notes, repeated notes)
     9. Play logic
    10. Rendering: staff (VexFlow), keyboard, meters
    11. Screens & UI wiring
   ===================================================================== */
'use strict';

/* ===================== 1. CONFIG ===================== */

// User-adjustable settings (also shown on the Settings screen).
const DEFAULT_SETTINGS = {
  anyOctave: true,          // accept the right note name in any octave
  toleranceCents: 40,       // how far from the exact pitch still counts (50 = anything nearest)
  gateDb: -50,              // noise gate: ignore sound quieter than this (dBFS)
  stableMs: 150,            // how long a note must be steady before it counts
  yinThreshold: 0.15,       // YIN strictness: higher = more sensitive, more mistakes
  clefSplit: 60,            // MIDI note: this and above go on the treble staff (60 = middle C)
  keyboardHint: true,       // highlight the target key on the on-screen piano
  tapSound: true,           // on-screen keys play a short tone
  tapThroughDetector: false // on-screen keys are fed to the pitch detector (test mode)
};

// Lower-level tuning. Change these if you know what you're doing.
const TUNING = {
  frameSize: 2048,     // samples analysed per pitch estimate (~43 ms at 48 kHz)
  hopSize: 1024,       // new estimate every this many samples (~21 ms)
  minFreq: 50,         // lowest detectable pitch (Hz) ≈ G1
  maxFreq: 2200,       // highest detectable pitch (Hz) ≈ C7
  dropoutGraceMs: 80,  // brief detection gaps shorter than this don't break a note
  onsetRatio: 2.0,     // a loudness jump of this factor = new key strike (for repeated notes)
  feedbackMs: 700,     // how long the green/red flash lasts
  lookahead: 4,        // upcoming notes drawn after the current one
  chordWindowSec: 0.03,// MIDI notes starting within 30 ms are treated as one chord
  kbLow: 36,           // on-screen piano range: C2 …
  kbHigh: 96           // … C7
};

/* ===================== 2. NOTE HELPERS ===================== */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER_TO_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function midiToName(m) { return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1); }
function midiToFreq(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function freqToMidiFloat(f) { return 69 + 12 * Math.log2(f / 440); }
function isBlackKey(m) { return [1, 3, 6, 8, 10].includes(m % 12); }

// "C#4", "Eb3", "G2" → MIDI number
function nameToMidi(name) {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(name.trim());
  if (!m) throw new Error('Bad note name: ' + name);
  let pc = LETTER_TO_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (parseInt(m[3], 10) + 1) * 12 + pc;
}

// Beginner-friendly hint describing where the note is relative to middle C.
function noteHint(m) {
  if (m === 60) return 'Middle C';
  const octaves = Math.floor(Math.abs(m - 60) / 12);
  const dir = m > 60 ? 'above' : 'below';
  if (octaves === 0) return `just ${dir} middle C`;
  return `${octaves} octave${octaves > 1 ? 's' : ''}+ ${dir} middle C`;
}

/* ===================== 3. PITCH DETECTION (YIN) ===================== */

function computeRms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

let yinScratch = new Float32Array(0);

/**
 * YIN pitch detector (de Cheveigné & Kawahara, 2002).
 * Returns { freq, clarity } or null if no clear pitch.
 * clarity is 0..1 (1 = perfectly periodic).
 */
function yinDetect(buf, sampleRate, threshold, minFreq, maxFreq) {
  const tauMin = Math.max(2, Math.floor(sampleRate / maxFreq));
  const tauMax = Math.min(Math.floor(sampleRate / minFreq), Math.floor(buf.length / 2));
  const W = buf.length - tauMax; // integration window
  if (yinScratch.length < tauMax + 2) yinScratch = new Float32Array(tauMax + 2);
  const d = yinScratch;

  // Steps 2+3: difference function, then cumulative-mean-normalised difference.
  d[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let sum = 0;
    for (let j = 0; j < W; j++) {
      const diff = buf[j] - buf[j + tau];
      sum += diff * diff;
    }
    running += sum;
    d[tau] = running > 0 ? (sum * tau) / running : 1;
  }

  // Step 4: first dip below the threshold, then walk down to its local minimum.
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (d[t] < threshold) {
      while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;

  // Step 5: parabolic interpolation for sub-sample accuracy.
  let better = tau;
  if (tau > 1 && tau < tauMax) {
    const s0 = d[tau - 1], s1 = d[tau], s2 = d[tau + 1];
    const denom = s0 - 2 * s1 + s2;
    if (denom !== 0) better = tau + (s0 - s2) / (2 * denom);
  }
  return { freq: sampleRate / better, clarity: 1 - d[tau] };
}

/**
 * Analyse one frame: loudness, noise gate, pitch → nearest note.
 * `voiced` = loud enough AND has a pitch AND is within tolerance of a note.
 */
function analyzeFrame(buf, sampleRate, s) {
  const rms = computeRms(buf);
  const db = rms > 0 ? 20 * Math.log10(rms) : -120;
  const out = { rms, db, gated: db < s.gateDb, freq: 0, midi: null, cents: 0, clarity: 0, voiced: false };
  if (out.gated) return out;
  const p = yinDetect(buf, sampleRate, s.yinThreshold, TUNING.minFreq, TUNING.maxFreq);
  if (!p) return out;
  const mf = freqToMidiFloat(p.freq);
  out.freq = p.freq;
  out.midi = Math.round(mf);
  out.cents = Math.round((mf - out.midi) * 100);
  out.clarity = p.clarity;
  out.voiced = Math.abs(out.cents) <= s.toleranceCents;
  return out;
}

/**
 * Synthesize a test tone. type 'piano' = decaying harmonics with slight
 * inharmonicity + noise, roughly like a real piano picked up by a phone mic.
 */
function synthTone(freq, sampleRate, length, opts = {}) {
  const { type = 'piano', noise = 0.02, offset = 0 } = opts;
  const out = new Float32Array(length);
  const harmonics = type === 'sine' ? [1] : [1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08];
  const B = type === 'piano' ? 0.0004 : 0; // inharmonicity
  const phases = harmonics.map(() => Math.random() * 2 * Math.PI);
  for (let i = 0; i < length; i++) {
    const t = (i + offset) / sampleRate;
    let v = 0;
    for (let h = 0; h < harmonics.length; h++) {
      const n = h + 1;
      const f = freq * n * Math.sqrt(1 + B * n * n);
      if (f > sampleRate / 2) break;
      v += harmonics[h] * Math.exp(-t * (1.5 + n)) * Math.sin(2 * Math.PI * f * t + phases[h]);
    }
    out[i] = 0.3 * v + noise * (Math.random() * 2 - 1);
  }
  return out;
}

/** Self-test: run the detector on synthesized tones; returns rows of results. */
function runPitchSelfTest(s) {
  const notes = [36, 41, 45, 48, 52, 55, 57, 60, 62, 64, 65, 67, 69, 71, 72, 76, 79, 84, 88, 91, 96];
  const rows = [];
  for (const sr of [44100, 48000]) {
    for (const m of notes) {
      const buf = synthTone(midiToFreq(m), sr, TUNING.frameSize, { type: 'piano', noise: 0.02, offset: sr * 0.05 });
      const r = analyzeFrame(buf, sr, Object.assign({}, s, { gateDb: -90 }));
      rows.push({
        sr, expected: m, detected: r.midi, freq: r.freq, cents: r.cents,
        pass: r.midi === m, pcPass: r.midi !== null && r.midi % 12 === m % 12
      });
    }
  }
  return rows;
}

/* ===================== 4. BUILT-IN SONGS (public domain) ===================== */

const BUILTIN_SONGS = [
  {
    id: 'builtin-twinkle', name: 'Twinkle Twinkle Little Star',
    notes: 'C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4 ' +
           'G4 G4 F4 F4 E4 E4 D4 G4 G4 F4 F4 E4 E4 D4 ' +
           'C4 C4 G4 G4 A4 A4 G4 F4 F4 E4 E4 D4 D4 C4'
  },
  {
    id: 'builtin-mary', name: 'Mary Had a Little Lamb',
    notes: 'E4 D4 C4 D4 E4 E4 E4 D4 D4 D4 E4 G4 G4 ' +
           'E4 D4 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4'
  },
  {
    id: 'builtin-ode', name: 'Ode to Joy (Beethoven)',
    notes: 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4 D4 D4 ' +
           'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4 ' +
           'D4 D4 E4 C4 D4 E4 F4 E4 C4 D4 E4 F4 E4 D4 C4 D4 G3 ' +
           'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4 C4 C4'
  },
  {
    id: 'builtin-scale', name: 'Exercise: C scale, right then left hand',
    notes: 'C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4 ' +
           'C3 D3 E3 F3 G3 A3 B3 C4 B3 A3 G3 F3 E3 D3 C3'
  }
].map(s => ({ ...s, builtIn: true, notes: s.notes.trim().split(/\s+/).map(nameToMidi) }));

/* ===================== 5. MIDI IMPORT ===================== */

/** Parse a .mid ArrayBuffer into a list of tracks that contain notes. */
function parseMidiFile(arrayBuffer) {
  const lib = window.Midi;
  const MidiCtor = lib && (lib.Midi || lib);
  if (typeof MidiCtor !== 'function') throw new Error('MIDI library failed to load (are you online?).');
  const midi = new MidiCtor(arrayBuffer);
  return midi.tracks
    .map((t, i) => ({
      index: i,
      name: t.name || (t.instrument && t.instrument.name) || `Track ${i + 1}`,
      isDrums: !!(t.instrument && t.instrument.percussion) || t.channel === 9,
      notes: t.notes.map(n => ({ midi: n.midi, time: n.time }))
    }))
    .filter(t => t.notes.length > 0);
}

/**
 * Merge notes into ONE ordered sequence of single notes.
 * Notes that start within `windowSec` of each other count as a chord;
 * only the top (or lowest) note of each chord is kept. Timing is dropped.
 */
function collapseToSequence(notes, mode = 'top', windowSec = TUNING.chordWindowSec) {
  const sorted = notes.slice().sort((a, b) => a.time - b.time || a.midi - b.midi);
  const result = [];
  let groupStart = -Infinity, pick = null;
  for (const n of sorted) {
    if (n.time - groupStart > windowSec) {
      if (pick !== null) result.push(pick);
      groupStart = n.time;
      pick = n.midi;
    } else {
      pick = mode === 'bottom' ? Math.min(pick, n.midi) : Math.max(pick, n.midi);
    }
  }
  if (pick !== null) result.push(pick);
  return result;
}

/* ===================== 6. STORAGE ===================== */

const SongDB = {
  _db: null,
  open() {
    return new Promise((resolve, reject) => {
      if (this._db) return resolve(this._db);
      if (!('indexedDB' in window)) return reject(new Error('This browser cannot save songs (no IndexedDB).'));
      const req = indexedDB.open('piano-wait-mode', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
      req.onsuccess = () => { this._db = req.result; resolve(this._db); };
      req.onerror = () => reject(req.error);
    });
  },
  async _run(mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('songs', mode);
      const req = fn(tx.objectStore('songs'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  },
  all() { return this._run('readonly', s => s.getAll()); },
  put(song) { return this._run('readwrite', s => s.put(song)); },
  remove(id) { return this._run('readwrite', s => s.delete(id)); }
};

const SETTINGS_KEY = 'piano-wait-mode.settings';
function loadSettings() {
  try { return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); }
  catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* private mode etc. */ }
}

let settings = loadSettings();

/* ===================== 7. AUDIO ENGINE ===================== */

// AudioWorklet source, loaded from a Blob so we don't need an extra file.
// It just collects samples into overlapping frames and posts them to the main thread.
const WORKLET_SRC = `
class FrameTap extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.buf = new Float32Array(o.frameSize);
    this.hop = o.hopSize;
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      const n = ch.length, size = this.buf.length;
      this.buf.copyWithin(0, n);
      this.buf.set(ch, size - n);
      this.count += n;
      if (this.count >= this.hop) { this.count = 0; this.port.postMessage(this.buf.slice()); }
    }
    return true;
  }
}
registerProcessor('frame-tap', FrameTap);
`;

const Engine = {
  ctx: null,
  inputBus: null,   // everything to analyse (mic + test tones) goes into this
  sink: null,       // silent output that keeps the analysis node running
  tapNode: null,
  mode: '',
  micStream: null,
  micSource: null,
  micOn: false,

  /** Must be called synchronously inside a tap handler (iOS rule). */
  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('This browser does not support Web Audio.');
      this.ctx = new AC();
      this.inputBus = this.ctx.createGain();
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(this.ctx.destination);
      this.ctx.onstatechange = () => updateMicUI();
    }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  },

  /** Create the node that hands audio frames to the pitch detector. */
  async ensureAnalysis() {
    if (this.tapNode) return;
    if (this._analysisPromise) return this._analysisPromise;
    this._analysisPromise = (async () => {
      const ctx = this.ctx;
      if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
        try {
          const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
          await ctx.audioWorklet.addModule(url);
          URL.revokeObjectURL(url);
          const node = new AudioWorkletNode(ctx, 'frame-tap', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: { frameSize: TUNING.frameSize, hopSize: TUNING.hopSize }
          });
          node.port.onmessage = e => onFrame(e.data, ctx.sampleRate);
          this.inputBus.connect(node);
          node.connect(this.sink);
          this.tapNode = node;
          this.mode = 'AudioWorklet';
          return;
        } catch (err) {
          console.warn('AudioWorklet unavailable, using ScriptProcessor fallback:', err);
        }
      }
      // Fallback for older browsers.
      const sp = ctx.createScriptProcessor(TUNING.hopSize, 1, 1);
      const ring = new Float32Array(TUNING.frameSize);
      sp.onaudioprocess = e => {
        const input = e.inputBuffer.getChannelData(0);
        ring.copyWithin(0, input.length);
        ring.set(input, ring.length - input.length);
        onFrame(ring, ctx.sampleRate);
      };
      this.inputBus.connect(sp);
      sp.connect(this.sink);
      this.tapNode = sp;
      this.mode = 'ScriptProcessor';
    })();
    return this._analysisPromise;
  },

  async startMic() {
    if (!window.isSecureContext) throw Object.assign(new Error(), { name: 'InsecureContext' });
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error(), { name: 'Unsupported' });
    await this.ensureAnalysis();
    if (this.micOn) return;
    // Turn off voice processing: it squashes musical notes.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      video: false
    });
    this.micStream = stream;
    this.micSource = this.ctx.createMediaStreamSource(stream);
    this.micSource.connect(this.inputBus);
    this.micOn = true;
    stream.getAudioTracks().forEach(t => { t.onended = () => { this.stopMic(); updateMicUI('The microphone was turned off (maybe by another app or a phone call). Tap to start again.'); }; });
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});
  },

  stopMic() {
    if (this.micStream) this.micStream.getTracks().forEach(t => t.stop());
    if (this.micSource) this.micSource.disconnect();
    this.micStream = this.micSource = null;
    this.micOn = false;
  }
};

/** Turn getUserMedia errors into advice a beginner can follow. */
function micErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. On iPhone: tap "aA" in the Safari address bar → Website Settings → Microphone → Allow, ' +
             'or open the Settings app → Apps → Safari → Microphone. Then reload this page. ' +
             'You can still practise with the on-screen piano below.';
    case 'NotFoundError':
      return 'No microphone was found on this device.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The microphone is busy (a call, voice memo or another app may be using it). Close that and try again.';
    case 'InsecureContext':
      return 'The microphone only works on a secure https:// page. Open the GitHub Pages link instead of a file or http:// address.';
    case 'Unsupported':
      return 'This browser does not allow microphone access. Use Safari on iPhone (iOS 14.5 or newer).';
    default:
      return 'Could not start the microphone: ' + ((err && err.message) || err);
  }
}

/** Called for every analysis frame (~45×/second). */
function onFrame(buf, sampleRate) {
  const res = analyzeFrame(buf, sampleRate, settings);
  state.latest = res;
  if (state.calibration) state.calibration.push(res.db);
  Matcher.update(res, performance.now());
}

/* ===================== 8. NOTE MATCHER ===================== */

/**
 * Turns a stream of per-frame pitches into discrete "note played" events.
 *  - A note fires once it has been steady for settings.stableMs.
 *  - After firing, that same note is "blocked" so holding a key doesn't
 *    count twice. It is unblocked by silence or by a fresh key strike
 *    (a jump in loudness) — that's how repeated notes like "C C G G" work.
 */
const Matcher = {
  note: null, start: 0, fired: false,
  blocked: null, floor: Infinity,
  lastVoiced: 0, lastLoud: 0,
  onNote: midi => onStableNote(midi), // swapped out by tests

  reset() {
    this.note = null; this.fired = false; this.blocked = null; this.floor = Infinity;
  },

  update(res, now) {
    if (!res.gated) this.lastLoud = now;

    // Fresh key strike while a note is blocked → allow it again.
    if (this.blocked !== null) {
      this.floor = Math.min(this.floor, res.rms);
      if (!res.gated && res.rms > this.floor * TUNING.onsetRatio) {
        this.blocked = null;
        this.note = null;
      }
    }

    if (res.voiced) {
      this.lastVoiced = now;
      if (res.midi !== this.note) { this.note = res.midi; this.start = now; this.fired = false; }
      if (!this.fired && this.note !== this.blocked && now - this.start >= settings.stableMs) {
        this.fired = true;
        this.blocked = this.note;
        this.floor = res.rms;
        this.onNote(this.note);
      }
    } else if (now - this.lastVoiced > TUNING.dropoutGraceMs) {
      this.note = null;
      this.fired = false;
    }

    // Real silence for a moment → nothing is held any more.
    if (res.gated && now - this.lastLoud > TUNING.dropoutGraceMs) {
      this.blocked = null;
      this.floor = Infinity;
    }
  }
};

/* ===================== 9. PLAY LOGIC ===================== */

const state = {
  songs: [],          // user songs from IndexedDB
  song: null,         // song being played
  idx: 0,             // index of the current note
  screen: 'songs',
  prevScreen: 'songs',
  latest: null,       // latest analysis frame (for meters)
  pendingImport: null,
  calibration: null,
  feedbackTimer: 0,
  wakeLock: null
};

function onStableNote(midi) {
  if (state.screen === 'play') handleNote(midi);
}

/** A note was played (by mic or on-screen key). Advance if it's right. */
function handleNote(midi) {
  const song = state.song;
  if (!song || state.idx >= song.notes.length) return;
  const target = song.notes[state.idx];
  const ok = settings.anyOctave ? midi % 12 === target % 12 : midi === target;
  if (ok) {
    state.idx++;
    showFeedback('good', state.idx >= song.notes.length ? 'Song complete! 🎉' : `✓ ${midiToName(midi)}`);
    renderPlay();
  } else {
    showFeedback('bad', `Heard ${midiToName(midi)} — try ${midiToName(target)}`);
  }
}

function showFeedback(kind, text) {
  const card = $('#target-card');
  card.classList.remove('good', 'bad');
  void card.offsetWidth; // restart CSS animation
  card.classList.add(kind);
  $('#feedback').textContent = text;
  clearTimeout(state.feedbackTimer);
  state.feedbackTimer = setTimeout(() => {
    card.classList.remove('good', 'bad');
    if (state.song && state.idx < state.song.notes.length) $('#feedback').textContent = '';
  }, TUNING.feedbackMs);
}

function startSong(song) {
  state.song = song;
  state.idx = 0;
  Matcher.reset();
  $('#feedback').textContent = '';
  show('play');
}

/* ===================== 10. RENDERING ===================== */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function renderPlay() {
  const song = state.song;
  if (!song) return;
  const total = song.notes.length;
  const done = state.idx >= total;
  $('#play-title').textContent = song.name;
  $('#progress-text').textContent = done ? `${total} of ${total} ✓` : `Note ${state.idx + 1} of ${total}`;
  $('#progress-fill').style.width = (100 * state.idx / total) + '%';
  if (done) {
    $('#target-name').textContent = '🎉';
    $('#target-hint').textContent = 'You finished the song! Tap Restart to play it again.';
  } else {
    const t = song.notes[state.idx];
    $('#target-name').textContent = midiToName(t);
    $('#target-hint').textContent = noteHint(t) + (t < settings.clefSplit ? ' · bass clef' : ' · treble clef');
  }
  renderStaff();
  highlightTargetKey();
}

/** Draw a grand staff: current note (blue) + the next few (grey). */
function renderStaff() {
  const host = $('#staff');
  host.innerHTML = '';
  const VF = window.Vex && window.Vex.Flow;
  if (!VF) {
    host.append(el('p', { class: 'muted', style: 'padding:16px' }, 'Staff library failed to load — check your internet connection.'));
    return;
  }
  const song = state.song;
  const width = Math.max(300, host.clientWidth || 340);
  const height = 230;
  const renderer = new VF.Renderer(host, VF.Renderer.Backends.SVG);
  renderer.resize(width, height);
  const ctx = renderer.getContext();

  const x = 28, staveW = width - x - 8;
  const treble = new VF.Stave(x, 4, staveW).addClef('treble');
  const bass = new VF.Stave(x, 114, staveW).addClef('bass');
  treble.setContext(ctx).draw();
  bass.setContext(ctx).draw();
  new VF.StaveConnector(treble, bass).setType('brace').setContext(ctx).draw();
  new VF.StaveConnector(treble, bass).setType('singleLeft').setContext(ctx).draw();

  const upcoming = song.notes.slice(state.idx, state.idx + 1 + TUNING.lookahead);
  if (!upcoming.length) return;

  const trebleNotes = [], bassNotes = [];
  upcoming.forEach((m, i) => {
    const clef = m < settings.clefSplit ? 'bass' : 'treble';
    const name = NOTE_NAMES[m % 12];
    const key = name.toLowerCase() + '/' + (Math.floor(m / 12) - 1);
    const note = new VF.StaveNote({ clef, keys: [key], duration: 'q' });
    if (name.includes('#')) note.addModifier(new VF.Accidental('#'), 0);
    const label = new VF.Annotation(midiToName(m));
    label.setVerticalJustification(VF.Annotation.VerticalJustify.BOTTOM);
    note.addModifier(label, 0);
    const color = i === 0 ? '#2563eb' : '#8a8f99';
    note.setStyle({ fillStyle: color, strokeStyle: color });
    const ghost = new VF.GhostNote({ duration: 'q' });
    if (clef === 'treble') { trebleNotes.push(note); bassNotes.push(ghost); }
    else { bassNotes.push(note); trebleNotes.push(ghost); }
  });

  const makeVoice = notes => new VF.Voice({ num_beats: notes.length, beat_value: 4 })
    .setMode(VF.Voice.Mode.SOFT).addTickables(notes);
  const tv = makeVoice(trebleNotes), bv = makeVoice(bassNotes);
  const formatWidth = staveW - (treble.getNoteStartX() - x) - 24;
  new VF.Formatter().joinVoices([tv]).joinVoices([bv]).format([tv, bv], formatWidth);
  tv.draw(ctx, treble);
  bv.draw(ctx, bass);
}

/** Build the on-screen piano once. */
function buildKeyboard() {
  const kb = $('#keyboard');
  const css = getComputedStyle(document.documentElement);
  const W = parseFloat(css.getPropertyValue('--white-w')) || 44;
  const B = parseFloat(css.getPropertyValue('--black-w')) || 28;
  let whiteIndex = 0;
  for (let m = TUNING.kbLow; m <= TUNING.kbHigh; m++) {
    const black = isBlackKey(m);
    const key = el('button', {
      class: 'key ' + (black ? 'black' : 'white') + (m === 60 ? ' middle-c' : ''),
      'aria-label': midiToName(m),
      type: 'button'
    });
    key.dataset.midi = m;
    if (black) key.style.left = (whiteIndex * W - B / 2) + 'px';
    else {
      key.style.left = (whiteIndex * W) + 'px';
      if (m % 12 === 0) key.textContent = midiToName(m);
      whiteIndex++;
    }
    kb.append(key);
  }
  kb.style.width = (whiteIndex * W) + 'px';
  // "click" (not pointerdown) so swiping to scroll the keyboard doesn't play notes.
  kb.addEventListener('click', e => {
    const key = e.target.closest('.key');
    if (key) onKeyTap(parseInt(key.dataset.midi, 10), key);
  });
}

function onKeyTap(midi, keyEl) {
  keyEl.classList.add('pressed');
  setTimeout(() => keyEl.classList.remove('pressed'), 150);
  const through = settings.tapThroughDetector;
  if (settings.tapSound || through) {
    try {
      Engine.ensureContext();
      if (through) Engine.ensureAnalysis().then(updateMicUI);
      playTone(midi, settings.tapSound, through);
    } catch (e) { console.warn(e); }
  }
  // In test mode the detector decides; otherwise the tap counts directly.
  if (!through) handleNote(midi);
}

/** Short synthesized tone for on-screen keys (and detector testing). */
function playTone(midi, toSpeakers, toDetector, dur = 0.9) {
  const ctx = Engine.ctx;
  const t = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.value = midiToFreq(midi);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  if (toSpeakers) g.connect(ctx.destination);
  if (toDetector) g.connect(Engine.inputBus);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function highlightTargetKey() {
  $$('.key.target').forEach(k => k.classList.remove('target'));
  const song = state.song;
  if (!song || state.idx >= song.notes.length) return;
  const m = song.notes[state.idx];
  const key = $(`.key[data-midi="${m}"]`);
  if (!key) return;
  if (settings.keyboardHint) key.classList.add('target');
  const wrap = $('#kb-wrap');
  const left = key.offsetLeft - wrap.clientWidth / 2 + key.offsetWidth / 2;
  wrap.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
}

/** Meters: level, gate line, heard note, cents. Runs on requestAnimationFrame. */
let meterRaf = 0, lastHeardKey = null;
function meterLoop() {
  meterRaf = 0;
  if (state.screen !== 'play' && state.screen !== 'settings') return;
  const r = state.latest;
  const pct = db => Math.max(0, Math.min(100, (db + 80) / 80 * 100)); // -80..0 dB → 0..100 %
  $$('.gate-mark').forEach(g => { g.style.left = pct(settings.gateDb) + '%'; });
  if (r) {
    $$('.level-fill').forEach(f => { f.style.width = pct(r.db) + '%'; f.classList.toggle('open', !r.gated); });
    const heard = !r.gated && r.midi !== null;
    const target = state.song && state.song.notes[state.idx];
    const match = heard && target != null && (settings.anyOctave ? r.midi % 12 === target % 12 : r.midi === target);
    $$('[data-heard-name]').forEach(n => { n.textContent = heard ? midiToName(r.midi) : '—'; n.classList.toggle('match', match && r.voiced); });
    $$('[data-heard-freq]').forEach(n => { n.textContent = heard ? `${r.freq.toFixed(1)} Hz · ${r.cents > 0 ? '+' : ''}${r.cents}¢` : `${r.db.toFixed(0)} dB`; });
    $$('[data-cents]').forEach(c => { c.style.left = (heard ? 50 + r.cents : 50) + '%'; });
    // Light up the heard key on the on-screen piano.
    const k = heard && r.voiced ? r.midi : null;
    if (k !== lastHeardKey) {
      if (lastHeardKey !== null) { const old = $(`.key[data-midi="${lastHeardKey}"]`); if (old) old.classList.remove('heard'); }
      if (k !== null) { const nk = $(`.key[data-midi="${k}"]`); if (nk) nk.classList.add('heard'); }
      lastHeardKey = k;
    }
  }
  meterRaf = requestAnimationFrame(meterLoop);
}
function startMeters() { if (!meterRaf) meterRaf = requestAnimationFrame(meterLoop); }

function updateMicUI(message) {
  const btn = $('#mic-btn');
  const msg = $('#mic-msg');
  const ctx = Engine.ctx;
  if (Engine.micOn && ctx && ctx.state !== 'running') {
    btn.textContent = '▶ Tap to resume listening';
    btn.classList.add('primary');
  } else if (Engine.micOn) {
    btn.textContent = '🎤 Listening… (tap to stop)';
    btn.classList.remove('primary');
  } else {
    btn.textContent = '🎤 Start listening';
    btn.classList.add('primary');
  }
  if (message !== undefined) {
    msg.hidden = !message;
    msg.textContent = message || '';
    msg.classList.toggle('error', !!message);
  }
  $('#engine-info').textContent = Engine.ctx
    ? `Audio: ${Engine.mode || 'starting'} · ${Engine.ctx.sampleRate} Hz · ${Engine.ctx.state}`
    : 'Tap "Start listening" and allow the microphone.';
}

/** Start the mic from a tap. ensureContext() runs synchronously first (iOS). */
async function startListeningFromTap() {
  try {
    Engine.ensureContext();
  } catch (e) {
    updateMicUI(e.message);
    return false;
  }
  updateMicUI('');
  $('#mic-btn').textContent = 'Starting microphone…';
  try {
    await Engine.startMic();
    updateMicUI('');
    keepAwake(true);
    return true;
  } catch (err) {
    console.warn(err);
    updateMicUI(micErrorMessage(err));
    return false;
  }
}

/** Keep the screen on while practising (iOS 16.4+). */
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } else if (!on && state.wakeLock) {
      await state.wakeLock.release();
      state.wakeLock = null;
    }
  } catch (e) { /* not supported or not allowed — fine */ }
}

/* ===================== 11. SCREENS & UI ===================== */

function show(name) {
  if (name !== state.screen) state.prevScreen = state.screen;
  state.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  window.scrollTo(0, 0);
  if (name === 'play') { renderPlay(); updateMicUI(); }
  if (name === 'settings') renderSettings();
  if (name === 'songs') renderSongList();
  if (name === 'play' || name === 'settings') startMeters();
  if (name !== 'play' && name !== 'settings') keepAwake(false);
}

/* ---------- Song list ---------- */

function songMeta(song) {
  const n = song.notes.length;
  if (!n) return 'empty';
  const lo = Math.min(...song.notes), hi = Math.max(...song.notes);
  return `${n} notes · ${midiToName(lo)}–${midiToName(hi)}`;
}

function songItem(song) {
  const main = el('button', { class: 'song-main', type: 'button', onclick: () => startSong(song) },
    el('span', { class: 'song-name' }, song.name),
    el('span', { class: 'song-meta' }, songMeta(song)));
  const li = el('li', {}, main);
  if (!song.builtIn) {
    li.append(el('div', { class: 'song-actions' },
      el('button', { class: 'btn small', type: 'button', onclick: () => renameSong(song) }, 'Rename'),
      el('button', { class: 'btn small danger', type: 'button', onclick: () => deleteSong(song) }, 'Delete')));
  }
  return li;
}

function renderSongList() {
  const builtin = $('#builtin-songs');
  builtin.replaceChildren(...BUILTIN_SONGS.map(songItem));
  const mine = state.songs.slice().sort((a, b) => (b.created || 0) - (a.created || 0));
  $('#my-songs').replaceChildren(...mine.map(songItem));
  $('#my-empty').hidden = mine.length > 0;
}

function listMessage(text, isError) {
  const m = $('#list-msg');
  m.hidden = !text;
  m.textContent = text || '';
  m.classList.toggle('error', !!isError);
}

async function loadUserSongs() {
  try { state.songs = (await SongDB.all()) || []; }
  catch (e) { listMessage('Could not load saved songs: ' + e.message, true); }
  renderSongList();
}

async function renameSong(song) {
  const name = prompt('New name for this song:', song.name);
  if (!name || !name.trim()) return;
  song.name = name.trim();
  try { await SongDB.put(song); } catch (e) { listMessage('Could not rename: ' + e.message, true); }
  renderSongList();
}

async function deleteSong(song) {
  if (!confirm(`Delete "${song.name}" from this device?`)) return;
  try {
    await SongDB.remove(song.id);
    state.songs = state.songs.filter(s => s.id !== song.id);
  } catch (e) { listMessage('Could not delete: ' + e.message, true); }
  renderSongList();
}

/* ---------- MIDI import screen ---------- */

async function onFileChosen(file) {
  listMessage('');
  if (!file) return;
  if (!/\.(mid|midi|kar)$/i.test(file.name)) {
    listMessage(`"${file.name}" doesn't look like a MIDI file (.mid). Trying anyway…`);
  }
  try {
    const tracks = parseMidiFile(await file.arrayBuffer());
    if (!tracks.length) throw new Error('No notes found in this file.');
    state.pendingImport = { fileName: file.name, tracks };
    renderImport();
    show('import');
  } catch (e) {
    console.warn(e);
    listMessage('Could not read that MIDI file: ' + e.message, true);
  }
}

function renderImport() {
  const imp = state.pendingImport;
  $('#import-name').value = imp.fileName.replace(/\.(mid|midi|kar)$/i, '').replace(/[_-]+/g, ' ').trim();
  const list = $('#import-tracks');
  list.replaceChildren(...imp.tracks.map(t => {
    const lo = Math.min(...t.notes.map(n => n.midi)), hi = Math.max(...t.notes.map(n => n.midi));
    const box = el('input', { type: 'checkbox', checked: !t.isDrums, onchange: updateImportSummary });
    box.dataset.index = t.index;
    return el('li', {}, el('label', {}, box,
      el('span', {},
        el('span', { class: 'song-name' }, t.name + (t.isDrums ? ' (drums)' : '')),
        el('span', { class: 'song-meta' }, `${t.notes.length} notes · ${midiToName(lo)}–${midiToName(hi)}`))));
  }));
  updateImportSummary();
}

function buildImportSequence() {
  const imp = state.pendingImport;
  const chosen = new Set($$('#import-tracks input:checked').map(b => parseInt(b.dataset.index, 10)));
  const notes = imp.tracks.filter(t => chosen.has(t.index)).flatMap(t => t.notes);
  const mode = ($('input[name="chord"]:checked') || {}).value || 'top';
  return { notes: collapseToSequence(notes, mode), mode, trackNames: imp.tracks.filter(t => chosen.has(t.index)).map(t => t.name) };
}

function updateImportSummary() {
  const { notes } = buildImportSequence();
  $('#import-summary').textContent = notes.length
    ? `This makes a sequence of ${notes.length} single notes.`
    : 'Pick at least one track with notes.';
  $('#btn-import-save').disabled = !notes.length;
}

async function saveImport() {
  const { notes, mode, trackNames } = buildImportSequence();
  if (!notes.length) return;
  const song = {
    id: 'user-' + Date.now(),
    name: $('#import-name').value.trim() || state.pendingImport.fileName,
    notes,
    created: Date.now(),
    source: { fileName: state.pendingImport.fileName, tracks: trackNames, chordMode: mode }
  };
  try {
    await SongDB.put(song);
    state.songs.push(song);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    state.pendingImport = null;
    show('songs');
    listMessage(`Saved "${song.name}".`);
  } catch (e) {
    alert('Could not save the song: ' + e.message);
  }
}

/* ---------- Settings screen ---------- */

const SETTINGS_SCHEMA = [
  { key: 'anyOctave', type: 'toggle', label: 'Accept any octave',
    help: 'ON: the right note name anywhere on the keyboard counts. Recommended — phone mics often hear a note an octave off.' },
  { key: 'toleranceCents', type: 'range', min: 15, max: 50, step: 5, label: 'Pitch tolerance', fmt: v => `±${v} cents`,
    help: 'How out-of-tune a note may be and still count. Lower it if neighbouring notes get accepted by mistake.' },
  { key: 'gateDb', type: 'range', min: -80, max: -20, step: 1, label: 'Noise gate', fmt: v => `${v} dB`,
    help: 'Sounds quieter than this are ignored (red line on the level meter). Raise it in a noisy room.' },
  { key: 'stableMs', type: 'range', min: 60, max: 400, step: 10, label: 'Hold time', fmt: v => `${v} ms`,
    help: 'How long a note must be heard steadily before it counts.' },
  { key: 'yinThreshold', type: 'range', min: 0.05, max: 0.40, step: 0.01, label: 'Detection sensitivity', fmt: v => v.toFixed(2),
    help: 'Higher catches quieter or messier notes but makes more mistakes. 0.15 is a good start.' },
  { key: 'clefSplit', type: 'range', min: 48, max: 72, step: 1, label: 'Treble / bass split', fmt: v => `${midiToName(v)}+ = treble`,
    help: 'Notes from this pitch up are drawn on the treble staff, lower ones on the bass staff.' },
  { key: 'keyboardHint', type: 'toggle', label: 'Highlight the target key', help: 'Shows which key to press on the on-screen piano.' },
  { key: 'tapSound', type: 'toggle', label: 'On-screen keys make a sound', help: '' },
  { key: 'tapThroughDetector', type: 'toggle', label: 'Test mode: send on-screen keys through the pitch detector',
    help: 'Tapping a key synthesizes a tone and feeds it to the same detector the mic uses, so you can test detection without a piano.' }
];

function renderSettings() {
  const form = $('#settings-form');
  const card = el('div', { class: 'card' });
  for (const item of SETTINGS_SCHEMA) {
    const row = el('div', { class: 'setting' });
    if (item.type === 'toggle') {
      const input = el('input', { type: 'checkbox', class: 'switch', checked: !!settings[item.key],
        onchange: () => { settings[item.key] = input.checked; saveSettings(); } });
      row.append(el('label', { class: 'setting-head' }, el('span', { class: 'setting-label' }, item.label), input));
    } else {
      const value = el('span', { class: 'setting-value' }, item.fmt(settings[item.key]));
      const input = el('input', { type: 'range', min: item.min, max: item.max, step: item.step, value: settings[item.key],
        oninput: () => { settings[item.key] = parseFloat(input.value); value.textContent = item.fmt(settings[item.key]); saveSettings(); } });
      row.append(el('div', { class: 'setting-head' }, el('span', { class: 'setting-label' }, item.label), value), input);
    }
    if (item.help) row.append(el('div', { class: 'setting-help' }, item.help));
    card.append(row);
  }
  form.replaceChildren(card);
}

/** Listen to the room for 2 s and set the gate a bit above the noise. */
async function calibrateGate() {
  const btn = $('#btn-calibrate');
  if (!Engine.micOn) {
    const ok = await startListeningFromTap();
    if (!ok) { btn.textContent = 'Microphone unavailable — see the Play screen message'; return; }
  }
  btn.disabled = true;
  btn.textContent = 'Listening to room noise… stay quiet';
  state.calibration = [];
  await new Promise(r => setTimeout(r, 2000));
  const dbs = state.calibration.sort((a, b) => a - b);
  state.calibration = null;
  btn.disabled = false;
  if (!dbs.length) { btn.textContent = 'No audio received — try again'; return; }
  const p90 = dbs[Math.floor(dbs.length * 0.9)];
  settings.gateDb = Math.round(Math.max(-80, Math.min(-20, p90 + 8)));
  saveSettings();
  renderSettings();
  btn.textContent = `Noise gate set to ${settings.gateDb} dB (room ≈ ${p90.toFixed(0)} dB). Tap to redo.`;
}

function showSelfTest() {
  const rows = runPitchSelfTest(settings);
  const passed = rows.filter(r => r.pass).length;
  const pcPassed = rows.filter(r => r.pcPass).length;
  const table = el('table', { class: 'selftest' },
    el('tr', {}, el('th', {}, 'Rate'), el('th', {}, 'Played'), el('th', {}, 'Detected'), el('th', {}, 'Hz'), el('th', {}, '')));
  for (const r of rows) {
    table.append(el('tr', {},
      el('td', {}, (r.sr / 1000).toFixed(1) + 'k'),
      el('td', {}, midiToName(r.expected)),
      el('td', {}, r.detected === null ? '—' : midiToName(r.detected)),
      el('td', {}, r.freq ? r.freq.toFixed(1) : '—'),
      el('td', { class: r.pass ? 'pass' : r.pcPass ? 'muted' : 'fail' }, r.pass ? '✓' : r.pcPass ? 'octave' : '✗')));
  }
  $('#selftest-out').replaceChildren(
    el('p', { class: passed === rows.length ? 'pass' : 'fail' },
      `${passed}/${rows.length} exact · ${pcPassed}/${rows.length} correct note name`),
    table);
}

/* ---------- Wiring ---------- */

function init() {
  buildKeyboard();
  renderSongList();
  loadUserSongs();

  $$('[data-go="settings"]').forEach(b => b.addEventListener('click', () => show('settings')));
  $('#btn-settings-done').addEventListener('click', () => show(state.prevScreen === 'settings' ? 'songs' : state.prevScreen));
  $('#btn-back').addEventListener('click', () => show('songs'));

  $('#file-input').addEventListener('change', e => { onFileChosen(e.target.files[0]); e.target.value = ''; });
  $('#btn-import-cancel').addEventListener('click', () => { state.pendingImport = null; show('songs'); });
  $('#btn-import-save').addEventListener('click', saveImport);
  $$('input[name="chord"]').forEach(r => r.addEventListener('change', updateImportSummary));

  $('#btn-restart').addEventListener('click', () => { state.idx = 0; Matcher.reset(); $('#feedback').textContent = ''; renderPlay(); });
  $('#btn-skip').addEventListener('click', () => {
    if (state.song && state.idx < state.song.notes.length) { state.idx++; $('#feedback').textContent = ''; renderPlay(); }
  });
  $('#btn-prev').addEventListener('click', () => {
    if (state.idx > 0) { state.idx--; $('#feedback').textContent = ''; renderPlay(); }
  });

  $('#mic-btn').addEventListener('click', () => {
    if (Engine.micOn && Engine.ctx && Engine.ctx.state !== 'running') {
      Engine.ctx.resume().then(() => updateMicUI(''), () => {});
    } else if (Engine.micOn) {
      Engine.stopMic();
      keepAwake(false);
      updateMicUI('');
    } else {
      startListeningFromTap();
    }
  });

  $('#btn-calibrate').addEventListener('click', calibrateGate);
  $('#btn-selftest').addEventListener('click', showSelfTest);
  $('#btn-reset-settings').addEventListener('click', () => {
    if (!confirm('Reset all settings to their defaults?')) return;
    settings = Object.assign({}, DEFAULT_SETTINGS);
    saveSettings();
    renderSettings();
  });

  // iOS suspends audio when the app is in the background; show "tap to resume".
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      updateMicUI();
      if (Engine.micOn && state.screen === 'play') keepAwake(true);
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.screen === 'play') renderStaff(); }, 150);
  });

  updateMicUI();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// Allow unit tests in Node: `node test-pitch.js`
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { yinDetect, analyzeFrame, synthTone, runPitchSelfTest, collapseToSequence,
    midiToName, nameToMidi, midiToFreq, Matcher, DEFAULT_SETTINGS, TUNING, BUILTIN_SONGS };
}
