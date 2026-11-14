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

// Release number. When you publish changes, raise it by 1 in THREE places so phones
// pick up the new version: here, version.json, and index.html (the app-version meta
// tag and the ?v= on styles.css and app.js).
const APP_VERSION = 7;

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
  tapThroughDetector: false,// on-screen keys are fed to the pitch detector (test mode)
  playbackSpeed: 1,         // "Hear it" speed: 1 = the song's real speed, 0.5 = half speed
  hearSeconds: 10,          // how long "Hear it" plays (seconds); 0 = the rest of the song
  sheetMusic: false,        // show sheet music instead of falling notes
  rollView: 'normal'        // falling notes: 'normal', 'full' (full screen) or 'hidden'
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
  kbHigh: 96,          // … C7
  speedMin: 0.25,      // playback speed slider: 25% …
  speedMax: 1.5,       // … to 150% of the song's real speed
  hearScheduleAheadSec: 1, // "Hear it" schedules notes this far ahead (keeps whole-song playback light)
  hearMaxGapSec: 1.5,  // long rests are shortened to this
  hearMuteTailMs: 400, // keep ignoring the mic this long after playback (echo)
  minWhiteKey: 18,     // on-screen piano: keys shrink to fit the song, down to this width (px) …
  maxWhiteKey: 44,     // … and are at most this wide
  rollPxPerSec: 80,    // falling notes: pixels per second of song (higher = more spread out)
  handColors: { R: '#3b82f6', L: '#f59e0b' } // falling-note colors: right hand blue, left hand orange
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

// Each note is "NAME" (1 beat) or "NAME:beats", e.g. "G4:2" is a half note,
// "E4:1.5" a dotted quarter. bpm = beats per minute (used by "Hear it").
const BUILTIN_SONGS = [
  {
    id: 'builtin-twinkle', name: 'Twinkle Twinkle Little Star', bpm: 100,
    notes: 'C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2 ' +
           'G4 G4 F4 F4 E4 E4 D4:2 G4 G4 F4 F4 E4 E4 D4:2 ' +
           'C4 C4 G4 G4 A4 A4 G4:2 F4 F4 E4 E4 D4 D4 C4:2'
  },
  {
    id: 'builtin-mary', name: 'Mary Had a Little Lamb', bpm: 110,
    notes: 'E4:1.5 D4:0.5 C4 D4 E4 E4 E4:2 D4 D4 D4:2 E4 G4 G4:2 ' +
           'E4:1.5 D4:0.5 C4 D4 E4 E4 E4 E4 D4 D4 E4 D4 C4:4'
  },
  {
    id: 'builtin-ode', name: 'Ode to Joy (Beethoven)', bpm: 100,
    notes: 'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 E4:1.5 D4:0.5 D4:2 ' +
           'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2 ' +
           'D4 D4 E4 C4 D4 E4:0.5 F4:0.5 E4 C4 D4 E4:0.5 F4:0.5 E4 D4 C4 D4 G3:2 ' +
           'E4 E4 F4 G4 G4 F4 E4 D4 C4 C4 D4 E4 D4:1.5 C4:0.5 C4:2'
  },
  {
    id: 'builtin-scale', name: 'Exercise: C scale, right then left hand', bpm: 90,
    notes: 'C4 D4 E4 F4 G4 A4 B4 C5 B4 A4 G4 F4 E4 D4 C4:2',
    left:  'C3 D3 E3 F3 G3 A3 B3 C4 B3 A3 G3 F3 E3 D3 C3:2'
  }
].map(s => ({ id: s.id, name: s.name, builtIn: true, notes: builtinEvents(s) }));

/**
 * Built-in songs → [{ midi, time, dur, hand }] with times in seconds.
 * `notes` is the right hand; optional `left` is played after it.
 */
function builtinEvents(s) {
  const secPerBeat = 60 / (s.bpm || 100);
  let beat = 0;
  const toEvents = (str, hand) => str.trim().split(/\s+/).map(token => {
    const [name, beats = '1'] = token.split(':');
    const ev = { midi: nameToMidi(name), time: beat * secPerBeat, dur: parseFloat(beats) * secPerBeat, hand };
    beat += parseFloat(beats);
    return ev;
  });
  const right = toEvents(s.notes, 'R');
  return s.left ? right.concat(toEvents(s.left, 'L')) : right;
}

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
      notes: t.notes.map(n => ({ midi: n.midi, time: n.time, dur: n.duration }))
    }))
    .filter(t => t.notes.length > 0);
}

/**
 * Turn notes into a sequence of single notes, keeping each note's start time.
 * Notes that start within `windowSec` of each other count as a chord;
 * only the top (or lowest) note of each chord is kept.
 */
function collapseEvents(notes, mode = 'top', windowSec = TUNING.chordWindowSec) {
  const sorted = notes.slice().sort((a, b) => a.time - b.time || a.midi - b.midi);
  const result = [];
  let pick = null;
  for (const n of sorted) {
    if (!pick || n.time - pick.time > windowSec) {
      if (pick) result.push(pick);
      pick = { midi: n.midi, time: n.time, dur: n.dur };
    } else if (mode === 'bottom' ? n.midi < pick.midi : n.midi > pick.midi) {
      pick.midi = n.midi;
      pick.dur = n.dur;
    }
  }
  if (pick) result.push(pick);
  return result;
}

/** Same as collapseEvents, but just the MIDI numbers. */
function collapseToSequence(notes, mode = 'top', windowSec = TUNING.chordWindowSec) {
  return collapseEvents(notes, mode, windowSec).map(n => n.midi);
}

/**
 * Guess which hand plays each track. One track → split it by pitch.
 * Several tracks → each track goes to the hand that matches its average pitch.
 */
function guessTrackHand(track, tracks, split) {
  if (tracks.filter(t => !t.isDrums).length < 2) return 'split';
  const avg = track.notes.reduce((a, n) => a + n.midi, 0) / track.notes.length;
  return avg >= split ? 'R' : 'L';
}

/**
 * Build the song's notes with a hand for each: [{ midi, time, hand: 'R'|'L' }].
 * Each hand's chords are collapsed on their own, so the left hand isn't lost
 * under the right hand. chordMode 'smart' = right hand keeps its top note
 * (the melody), left hand keeps its lowest note (the bass).
 */
function buildHandEvents(tracks, chordMode, split) {
  const byHand = { R: [], L: [] };
  for (const t of tracks) {
    for (const n of t.notes) {
      const hand = t.hand === 'split' ? (n.midi >= split ? 'R' : 'L') : t.hand;
      byHand[hand].push(n);
    }
  }
  const modeFor = hand => chordMode === 'smart' ? (hand === 'R' ? 'top' : 'bottom') : chordMode;
  const events = [];
  for (const hand of ['R', 'L']) {
    collapseEvents(byHand[hand], modeFor(hand)).forEach(n => events.push({ midi: n.midi, time: n.time, dur: n.dur, hand }));
  }
  return orderEvents(events);
}

/** Sort by time; notes starting together (both hands) go lowest first. */
function orderEvents(events, windowSec = TUNING.chordWindowSec) {
  const sorted = events.slice().sort((a, b) => a.time - b.time);
  const out = [];
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].time - sorted[i].time <= windowSec) j++;
    out.push(...sorted.slice(i, j).sort((a, b) => a.midi - b.midi));
    i = j;
  }
  return out;
}

/**
 * A song's notes as [{ midi, time, dur, hand }] (seconds). Songs saved by the first
 * version of the app stored plain MIDI numbers: their hand is guessed from the clef
 * split and they get an even half-second per note. `dur` may be missing on older saves.
 */
function songEvents(song) {
  return song.notes.map((n, i) => typeof n === 'number'
    ? { midi: n, time: i * 0.5, hand: n >= settings.clefSplit ? 'R' : 'L' }
    : n);
}

/** The notes to play for a hand choice: 'R', 'L' or 'both'. */
function notesForHand(song, hand) {
  return songEvents(song).filter(n => hand === 'both' || n.hand === hand);
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
  // While "Hear it" is playing, the mic would hear the phone's own speaker
  // and could advance the song by itself, so note matching pauses.
  if (performance.now() < state.muteUntil) return;
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
  hand: 'both',       // which hand is practised: 'R', 'L' or 'both'
  events: [],         // notes for that hand: [{ midi, time, hand }]
  notes: [],          // just their MIDI numbers
  idx: 0,             // index of the current note
  screen: 'songs',
  prevScreen: 'songs',
  latest: null,       // latest analysis frame (for meters)
  pendingImport: null,
  calibration: null,
  feedbackTimer: 0,
  phrase: null,       // "Hear it" playback in progress
  muteUntil: 0,       // ignore the mic until this time (performance.now())
  wakeLock: null
};

function onStableNote(midi) {
  if (state.screen === 'play') handleNote(midi);
}

/** A note was played (by mic or on-screen key). Advance if it's right. */
function handleNote(midi) {
  const song = state.song;
  if (!song || state.idx >= state.notes.length) return;
  const target = state.notes[state.idx];
  const ok = settings.anyOctave ? midi % 12 === target % 12 : midi === target;
  if (ok) {
    state.idx++;
    showFeedback('good', state.idx >= state.notes.length ? 'Song complete! 🎉' : `✓ ${midiToName(midi)}`);
    renderPlay();
  } else {
    showFeedback('bad', `Heard ${midiToName(midi)} — try ${midiToName(target)}`);
  }
}

function showFeedback(kind, text) {
  const cards = [$('#target-card'), $('#fs-bar')]; // the full-screen bar flashes too
  cards.forEach(card => {
    card.classList.remove('good', 'bad');
    void card.offsetWidth; // restart CSS animation
    card.classList.add(kind);
  });
  $('#feedback').textContent = text;
  clearTimeout(state.feedbackTimer);
  state.feedbackTimer = setTimeout(() => {
    cards.forEach(card => card.classList.remove('good', 'bad'));
    if (state.song && state.idx < state.notes.length) $('#feedback').textContent = '';
  }, TUNING.feedbackMs);
}

function startSong(song) {
  state.song = song;
  state.idx = 0;
  Roll.jump = true;
  setHand(loadSongHand(song), false);
  Matcher.reset();
  $('#feedback').textContent = '';
  show('play');
}

/**
 * Switch which hand is practised. Keeps your place: jumps to the first note
 * of the new hand that comes at or after the note you were on.
 */
function setHand(hand, keepPlace = true) {
  stopPhrase();
  const current = keepPlace && state.events[state.idx];
  state.hand = hand;
  state.events = notesForHand(state.song, hand);
  state.notes = state.events.map(n => n.midi);
  if (current) {
    const i = state.events.findIndex(n => n.time >= current.time);
    state.idx = i < 0 ? state.events.length : i;
  } else if (!keepPlace) {
    state.idx = 0;
  }
  saveSongHand(state.song, hand);
  $$('#hand-picker button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.hand === hand)));
}

// Remember the last hand choice for each song on this device.
const HANDS_KEY = 'piano-wait-mode.hands';
function loadSongHand(song) {
  try { return JSON.parse(localStorage.getItem(HANDS_KEY) || '{}')[song.id] || 'both'; }
  catch (e) { return 'both'; }
}
function saveSongHand(song, hand) {
  try {
    const all = JSON.parse(localStorage.getItem(HANDS_KEY) || '{}');
    all[song.id] = hand;
    localStorage.setItem(HANDS_KEY, JSON.stringify(all));
  } catch (e) { /* private mode etc. */ }
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
  const total = state.notes.length;
  const done = state.idx >= total;
  $('#play-title').textContent = song.name;
  $('#progress-text').textContent = done ? `${total} of ${total} ✓` : `Note ${state.idx + 1} of ${total}`;
  $('#fs-target').textContent = !total ? '—' : done ? '🎉' : midiToName(state.notes[state.idx]);
  $('#fs-progress').textContent = total ? `${Math.min(state.idx + 1, total)} / ${total}` : '';
  $('#progress-fill').style.width = (total ? 100 * state.idx / total : 0) + '%';
  if (!total) {
    $('#progress-text').textContent = '0 notes';
    $('#target-name').textContent = '—';
    $('#target-hint').textContent = `This song has no ${state.hand === 'L' ? 'left' : 'right'}-hand notes. Pick another hand above.`;
  } else if (done) {
    $('#target-name').textContent = '🎉';
    $('#target-hint').textContent = 'You finished the song! Tap Restart to play it again.';
  } else {
    const t = state.notes[state.idx];
    $('#target-name').textContent = midiToName(t);
    const hand = state.events[state.idx].hand === 'L' ? 'left hand' : 'right hand';
    const dot = el('span', { class: 'hand-dot' });
    dot.style.background = TUNING.handColors[state.events[state.idx].hand];
    $('#target-hint').replaceChildren(`${noteHint(t)} · `, dot, hand);
  }
  if (settings.sheetMusic) renderStaff();
  Roll.dirty = true;
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

  const upcoming = state.notes.slice(state.idx, state.idx + 1 + TUNING.lookahead);
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
  for (let m = TUNING.kbLow; m <= TUNING.kbHigh; m++) {
    const black = isBlackKey(m);
    const key = el('button', {
      class: 'key ' + (black ? 'black' : 'white') + (m === 60 ? ' middle-c' : ''),
      'aria-label': midiToName(m),
      type: 'button'
    });
    key.dataset.midi = m;
    if (!black && m % 12 === 0) key.textContent = midiToName(m);
    kb.append(key);
  }
  layoutKeyboard(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--white-w')) || 44);
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
  const outputs = [];
  if (toSpeakers) outputs.push(ctx.destination);
  if (toDetector) outputs.push(Engine.inputBus);
  scheduleNote(midi, ctx.currentTime, dur, outputs);
}

/**
 * Simple piano-like voice: a triangle wave plus a quieter octave above,
 * with a fast attack and a decay. Returns the oscillators so they can be stopped.
 */
function scheduleNote(midi, when, dur, outputs, volume = 0.35) {
  const ctx = Engine.ctx;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(volume, when + 0.01);
  g.gain.exponentialRampToValueAtTime(volume * 0.4, when + Math.min(0.3, dur));
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.15);
  outputs.forEach(o => g.connect(o));
  const oscs = [['triangle', 1, 1], ['sine', 2, 0.3]].map(([type, mult, level]) => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = midiToFreq(midi) * mult;
    const lg = ctx.createGain();
    lg.gain.value = level;
    osc.connect(lg).connect(g);
    osc.start(when);
    osc.stop(when + dur + 0.2);
    return osc;
  });
  return oscs;
}

/* ---------- "Hear it": play the next few notes at the song's real speed ---------- */

/**
 * Pick what "Hear it" plays: from the current note for `maxSec` seconds of
 * song (0 = to the end). Long rests are shortened so you're not left waiting.
 * Returns [{ midi, at, dur, idx }] with `at` in seconds from the start (before speed).
 */
function phraseFrom(events, idx, maxSec = 0) {
  const out = [];
  let at = 0;
  for (let i = idx; i < events.length; i++) {
    const n = events[i];
    if (i > idx) at += Math.min(n.time - events[i - 1].time, TUNING.hearMaxGapSec);
    if (maxSec && out.length && at > maxSec) break;
    out.push({ midi: n.midi, at, dur: Math.min(noteLength(events, i), 2), idx: i });
  }
  return out;
}

function hearPhrase() {
  if (state.phrase) { stopPhrase(); return; }
  if (!state.song || state.idx >= state.events.length) return;
  try { Engine.ensureContext(); } catch (e) { return; }
  const ctx = Engine.ctx;
  // start/speed/notes also let the falling notes move in time with the sound.
  // scheduled = notes already handed to the audio engine (so they can be re-timed).
  state.phrase = {
    start: ctx.currentTime + 0.08,
    speed: settings.playbackSpeed,
    notes: phraseFrom(state.events, state.idx, settings.hearSeconds),
    next: 0, scheduled: [], pump: 0, endTimer: 0
  };
  // Schedule about a second ahead at a time, so even a whole song starts
  // instantly and a speed change can re-time everything not yet played.
  schedulePhrase();
  state.phrase.pump = setInterval(schedulePhrase, 250);
  armPhraseEnd();
  Matcher.reset();
  $$('[data-hear]').forEach(b => { b.textContent = '■ Stop'; });
}

function schedulePhrase() {
  const p = state.phrase;
  if (!p) return;
  const ctx = Engine.ctx;
  const horizon = ctx.currentTime + TUNING.hearScheduleAheadSec;
  while (p.next < p.notes.length) {
    const n = p.notes[p.next];
    const when = p.start + n.at / p.speed;
    if (when > horizon) break;
    const oscs = scheduleNote(n.midi, when, n.dur / p.speed, [ctx.destination], 0.3);
    // Light up each key on the on-screen piano as it plays.
    const timer = setTimeout(() => flashKey(n.midi, Math.max(150, n.dur / p.speed * 1000)),
      Math.max(0, (when - ctx.currentTime) * 1000));
    p.scheduled.push({ i: p.next, when, oscs, timer });
    p.next++;
  }
  // Forget notes that finished a while ago.
  p.scheduled = p.scheduled.filter(sch => sch.when > ctx.currentTime - 3);
}

/** Stop when the last note ends (at the current speed); keep the mic muted until then. */
function armPhraseEnd() {
  const p = state.phrase, ctx = Engine.ctx;
  const last = p.notes[p.notes.length - 1];
  const endsIn = Math.max(0, p.start + (last.at + last.dur) / p.speed + 0.3 - ctx.currentTime);
  clearTimeout(p.endTimer);
  p.endTimer = setTimeout(stopPhrase, endsIn * 1000);
  state.muteUntil = performance.now() + endsIn * 1000 + TUNING.hearMuteTailMs;
}

/**
 * Change speed while playing: keep the current spot in the song, cancel the
 * notes that haven't started yet and schedule them again at the new speed.
 */
function retimePhrase(speed) {
  const p = state.phrase;
  if (!p || speed === p.speed) return;
  const now = Engine.ctx.currentTime;
  const at = Math.max(0, (now - p.start) * p.speed);
  p.start = now - at / speed;
  p.speed = speed;
  let first = p.next;
  p.scheduled = p.scheduled.filter(sch => {
    if (sch.when <= now + 0.01) return true; // already sounding
    sch.oscs.forEach(o => { try { o.stop(); } catch (e) { /* never started */ } });
    clearTimeout(sch.timer);
    first = Math.min(first, sch.i);
    return false;
  });
  p.next = first;
  schedulePhrase();
  armPhraseEnd();
}

function stopPhrase() {
  const p = state.phrase;
  if (!p) return;
  state.phrase = null;
  clearInterval(p.pump);
  clearTimeout(p.endTimer);
  p.scheduled.forEach(sch => {
    clearTimeout(sch.timer);
    sch.oscs.forEach(o => { try { o.stop(); } catch (e) { /* already stopped */ } });
  });
  $$('.key.playing').forEach(k => k.classList.remove('playing'));
  state.muteUntil = Math.min(state.muteUntil, performance.now() + TUNING.hearMuteTailMs);
  Matcher.reset();
  $$('[data-hear]').forEach(b => { b.textContent = '🔊 Hear it'; });
}

function flashKey(midi, ms) {
  const key = $(`.key[data-midi="${midi}"]`);
  if (!key) return;
  // Lit for 80% of the note, so the same note played twice blinks twice.
  clearTimeout(key._flashTimer);
  key.classList.add('playing');
  key._flashTimer = setTimeout(() => key.classList.remove('playing'), ms * 0.8);
}

/* ---------- Falling-notes view: normal, full screen or hidden ---------- */

function setView(view) {
  settings.rollView = view;
  saveSettings();
  applyView();
}

function applyView() {
  const screen = $('#screen-play');
  screen.classList.toggle('view-full', settings.rollView === 'full');
  screen.classList.toggle('view-hidden', settings.rollView === 'hidden');
  // Layout changed: re-measure the keys and the falling-notes area.
  fitKeyboardToSong();
  Roll.show();
}

/* ---------- Playback speed slider ---------- */

function setSpeed(speed) {
  settings.playbackSpeed = Math.max(TUNING.speedMin, Math.min(TUNING.speedMax, speed));
  saveSettings();
  syncSpeedUI();
  retimePhrase(settings.playbackSpeed); // takes effect immediately if Hear it is playing
}

function syncSpeedUI() {
  $$('.speed-slider').forEach(sl => { sl.value = settings.playbackSpeed; });
  $$('[data-speed-value]').forEach(v => { v.textContent = Math.round(settings.playbackSpeed * 100) + '%'; });
}

/* ---------- Falling notes ---------- */

/** How long to draw a note: its real length, or the gap to the next note if unknown. */
function noteLength(events, i) {
  const n = events[i], next = events[i + 1];
  const fallback = next ? Math.max(0.15, next.time - n.time) : 0.6;
  return Math.min(n.dur || fallback, 4);
}

/**
 * Notes fall down a lane above each key. The note to play sits on the line
 * just above the keyboard and waits there; when you play it, everything
 * slides down so the next note lands on the line. During "Hear it" the notes
 * fall in real time, reaching the line as each one sounds.
 */
const Roll = {
  canvas: null, ctx: null, keyPos: {}, w: 0, h: 0,
  display: 0,      // song time (seconds) currently drawn at the line
  jump: false,     // snap instead of animating (new song)
  dirty: true, raf: 0, lastFrame: 0,

  /** Show the lane (play screen, falling-notes view). */
  show() {
    if (settings.sheetMusic || settings.rollView === 'hidden') return;
    this.measure();
    this.start();
  },

  /** Size the canvas to the keyboard and record where each key is. */
  measure() {
    this.canvas = this.canvas || $('#roll');
    this.ctx = this.ctx || this.canvas.getContext('2d');
    this.keyPos = {};
    $$('.key').forEach(k => {
      this.keyPos[k.dataset.midi] = { x: k.offsetLeft, w: k.offsetWidth, black: k.classList.contains('black') };
    });
    const box = $('#roll-box');
    const w = $('#keyboard').offsetWidth;
    box.style.width = w + 'px';
    const h = box.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2); // capped to keep the canvas small on iPhone
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = w;
    this.h = h;
    this.dirty = true;
  },

  start() {
    if (this.raf) return;
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(t => this.frame(t));
  },

  frame(now) {
    this.raf = 0;
    if (state.screen !== 'play' || settings.sheetMusic || settings.rollView === 'hidden') return;
    const dt = Math.min(0.1, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const target = this.targetTime();
    const before = this.display;
    if (this.jump || state.phrase) { this.display = target; this.jump = false; }
    else this.display += (target - this.display) * Math.min(1, dt * 9); // ease toward the next note
    if (Math.abs(target - this.display) < 0.002) this.display = target;
    if (this.dirty || this.display !== before) { this.draw(); this.dirty = false; }
    this.raf = requestAnimationFrame(t => this.frame(t));
  },

  /** The song time that should be at the line right now. */
  targetTime() {
    const ev = state.events;
    if (!ev.length) return 0;
    const p = state.phrase;
    if (p && Engine.ctx) {
      // Follow the sound: map playback time back to song time, note by note
      // (phraseFrom may have shortened long rests).
      const at = (Engine.ctx.currentTime - p.start) * p.speed;
      const ns = p.notes;
      if (at <= 0) return ev[ns[0].idx].time;
      for (let k = 0; k < ns.length - 1; k++) {
        if (at < ns[k + 1].at) {
          const a = ns[k], b = ns[k + 1];
          const f = (at - a.at) / ((b.at - a.at) || 1);
          return ev[a.idx].time + f * (ev[b.idx].time - ev[a.idx].time);
        }
      }
      const last = ns[ns.length - 1];
      return ev[last.idx].time + (at - last.at);
    }
    if (state.idx >= ev.length) return ev[ev.length - 1].time + noteLength(ev, ev.length - 1) + 0.5;
    return ev[state.idx].time;
  },

  draw() {
    const c = this.ctx, W = this.w, H = this.h, pps = TUNING.rollPxPerSec;
    if (!c || !W) return;
    c.fillStyle = '#15171d';
    c.fillRect(0, 0, W, H);
    // Lanes: darker strips over black keys, faint lines between white keys, brighter at each C.
    for (const [m, k] of Object.entries(this.keyPos)) {
      if (k.black) { c.fillStyle = '#0f1014'; c.fillRect(k.x, 0, k.w, H); }
      else { c.fillStyle = Number(m) % 12 === 0 ? 'rgba(255,255,255,.16)' : 'rgba(255,255,255,.05)'; c.fillRect(k.x, 0, 1, H); }
    }

    const ev = state.events;
    c.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'bottom';
    for (let i = Math.max(0, state.idx - 6); i < ev.length; i++) {
      const n = ev[i];
      const bottom = H - (n.time - this.display) * pps;
      if (bottom < -40) break;              // above the top edge: the rest are later still
      const len = Math.max(16, noteLength(ev, i) * pps - 3);
      const top = bottom - len;
      const k = this.keyPos[n.midi];
      if (!k || top > H) continue;
      const current = i === state.idx;
      const pad = k.black ? 1 : 3;
      const x = k.x + pad, w = k.w - pad * 2;
      c.globalAlpha = i < state.idx ? 0.3 : current ? 1 : 0.75;
      c.fillStyle = TUNING.handColors[n.hand] || TUNING.handColors.R;
      if (current) { c.shadowColor = c.fillStyle; c.shadowBlur = 14; }
      roundRect(c, x, top, w, len, 5);
      c.fill();
      c.shadowBlur = 0;
      if (current) { c.lineWidth = 2; c.strokeStyle = '#fff'; c.stroke(); }
      if (len >= 18 && k.w >= 18) {
        c.fillStyle = n.hand === 'L' ? '#1b1206' : '#fff';
        c.fillText(midiToName(n.midi), k.x + k.w / 2, bottom - 4);
      }
    }
    c.globalAlpha = 1;
    // The line notes land on (top of the keyboard).
    c.fillStyle = 'rgba(255,255,255,.55)';
    c.fillRect(0, H - 2, W, 2);
  }
};

/** Rounded rectangle path (falls back to a plain one on older Safari). */
function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  if (c.roundRect) c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  else c.rect(x, y, w, h);
}

/** Position the keys for a given white-key width (black keys are ~64% as wide). */
function layoutKeyboard(W) {
  const kb = $('#keyboard');
  const B = Math.round(W * 0.64);
  kb.style.setProperty('--white-w', W + 'px');
  kb.style.setProperty('--black-w', B + 'px');
  let whiteIndex = 0;
  for (const key of kb.children) {
    if (key.classList.contains('black')) key.style.left = (whiteIndex * W - B / 2) + 'px';
    else { key.style.left = (whiteIndex * W) + 'px'; whiteIndex++; }
  }
  kb.style.width = (whiteIndex * W) + 'px';
}

/**
 * Shrink the keys so the whole song (both hands) fits on screen, so notes
 * never fall onto keys you can't see. Keys never get narrower than
 * TUNING.minWhiteKey; very wide songs still scroll.
 */
function fitKeyboardToSong() {
  const wrap = $('#kb-wrap');
  const midis = state.song ? songEvents(state.song).map(n => n.midi) : [];
  if (!midis.length || !wrap.clientWidth) return;
  // Song range, widened to white keys at both ends.
  let lo = Math.max(TUNING.kbLow, Math.min(...midis)), hi = Math.min(TUNING.kbHigh, Math.max(...midis));
  if (isBlackKey(lo)) lo--;
  if (isBlackKey(hi)) hi++;
  let whites = 0;
  for (let m = lo; m <= hi; m++) if (!isBlackKey(m)) whites++;
  const W = Math.max(TUNING.minWhiteKey, Math.min(TUNING.maxWhiteKey, Math.floor(wrap.clientWidth / whites)));
  layoutKeyboard(W);
  Roll.measure();
  // Centre the song's range.
  const loKey = $(`.key[data-midi="${lo}"]`);
  wrap.scrollLeft = Math.max(0, loKey.offsetLeft + (whites * W - wrap.clientWidth) / 2);
}

function highlightTargetKey() {
  $$('.key.target').forEach(k => k.classList.remove('target'));
  const song = state.song;
  if (!song || state.idx >= state.notes.length) return;
  const m = state.notes[state.idx];
  const key = $(`.key[data-midi="${m}"]`);
  if (!key) return;
  if (settings.keyboardHint) key.classList.add('target');
  // Only scroll if the key is off screen, so the view stays steady.
  const wrap = $('#kb-wrap');
  const margin = 0;
  if (key.offsetLeft < wrap.scrollLeft + margin || key.offsetLeft + key.offsetWidth > wrap.scrollLeft + wrap.clientWidth - margin) {
    const left = key.offsetLeft - wrap.clientWidth / 2 + key.offsetWidth / 2;
    wrap.scrollTo({ left: Math.max(0, left), behavior: 'smooth' });
  }
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
    const target = state.song && state.notes[state.idx];
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
  stopPhrase();
  if (name !== state.screen) state.prevScreen = state.screen;
  state.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  window.scrollTo(0, 0);
  if (name === 'play') {
    $('#screen-play').classList.toggle('sheet-view', !!settings.sheetMusic);
    fitKeyboardToSong();
    renderPlay();
    updateMicUI();
    applyView();
    syncSpeedUI();
  }
  if (name === 'settings') renderSettings();
  if (name === 'songs') {
    renderSongList();
    if (state.updatePending) checkForUpdate(); // update waited until you left the song
  }
  if (name === 'play' || name === 'settings') startMeters();
  if (name !== 'play' && name !== 'settings') keepAwake(false);
}

/* ---------- Song list ---------- */

function songMeta(song) {
  const events = songEvents(song);
  if (!events.length) return 'empty';
  const midis = events.map(n => n.midi);
  const left = events.filter(n => n.hand === 'L').length;
  const hands = left === 0 ? 'right hand' : left === events.length ? 'left hand' : 'both hands';
  return `${events.length} notes · ${midiToName(Math.min(...midis))}–${midiToName(Math.max(...midis))} · ${hands}`;
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
    // Which hand plays this track (guessed; you can change it).
    const hand = el('select', { class: 'hand-select', onchange: updateImportSummary, 'aria-label': `Hand for ${t.name}` },
      el('option', { value: 'R' }, 'Right hand'),
      el('option', { value: 'L' }, 'Left hand'),
      el('option', { value: 'split' }, `Split at ${midiToName(settings.clefSplit)}`));
    hand.value = guessTrackHand(t, imp.tracks, settings.clefSplit);
    hand.dataset.index = t.index;
    return el('li', {}, el('label', {}, box,
      el('span', { class: 'track-info' },
        el('span', { class: 'song-name' }, t.name + (t.isDrums ? ' (drums)' : '')),
        el('span', { class: 'song-meta' }, `${t.notes.length} notes · ${midiToName(lo)}–${midiToName(hi)}`)),
      hand));
  }));
  updateImportSummary();
}

function buildImportSequence() {
  const imp = state.pendingImport;
  const chosen = new Set($$('#import-tracks input:checked').map(b => parseInt(b.dataset.index, 10)));
  const handOf = i => ($(`#import-tracks select[data-index="${i}"]`) || {}).value || 'split';
  const tracks = imp.tracks.filter(t => chosen.has(t.index)).map(t => ({ notes: t.notes, hand: handOf(t.index) }));
  const mode = ($('input[name="chord"]:checked') || {}).value || 'smart';
  return {
    notes: buildHandEvents(tracks, mode, settings.clefSplit),
    mode,
    trackNames: imp.tracks.filter(t => chosen.has(t.index)).map(t => t.name)
  };
}

function updateImportSummary() {
  const { notes } = buildImportSequence();
  const left = notes.filter(n => n.hand === 'L').length;
  $('#import-summary').textContent = notes.length
    ? `This makes ${notes.length - left} right-hand and ${left} left-hand notes.`
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
  { key: 'playbackSpeed', type: 'range', min: TUNING.speedMin, max: TUNING.speedMax, step: 0.01, label: 'Playback speed', fmt: v => `${Math.round(v * 100)}%`,
    help: 'How fast the Hear it button plays the next notes. 100% is the real speed of the song; slow it down while learning.' },
  { key: 'keyboardHint', type: 'toggle', label: 'Highlight the target key', help: 'Shows which key to press on the on-screen piano.' },
  { key: 'tapSound', type: 'toggle', label: 'On-screen keys make a sound', help: '' },
  { key: 'sheetMusic', type: 'toggle', label: 'Show sheet music instead of falling notes',
    help: 'Falling notes come down onto the keys you should play. Turn this on to read from a music staff instead.' },
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

/* ---------- Updates ----------
   GitHub Pages lets a phone keep each file for up to 10 minutes, and a Home
   Screen app can't be pulled down to refresh. So the app checks version.json
   itself: if a newer version is online, or the page and the code it loaded
   don't match, it downloads the files again and reloads. */

async function checkForUpdate(manual = false) {
  try {
    const meta = document.querySelector('meta[name="app-version"]');
    const pageVersion = Number(meta ? meta.content : 0);
    const res = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
    const online = Number((await res.json()).version);
    const mismatched = pageVersion !== APP_VERSION;   // old page + new code (or the reverse)
    if (online === APP_VERSION && !mismatched) {
      if (manual) alert(`You have the latest version (${APP_VERSION}).`);
      return;
    }
    // Don't reload in the middle of practising: wait until you go back to the song list.
    if (!manual && !mismatched && state.screen !== 'songs') { state.updatePending = true; return; }
    // Only try once per version per visit, in case GitHub is still publishing it.
    const key = 'piano-wait-mode.updated-to';
    if (!manual && sessionStorage.getItem(key) === String(online)) return;
    try { sessionStorage.setItem(key, String(online)); } catch (e) { /* private mode */ }
    state.updatePending = false;
    const files = ['./', 'index.html', 'app.js', 'styles.css', `app.js?v=${online}`, `styles.css?v=${online}`];
    await Promise.all(files.map(f => fetch(f, { cache: 'reload' }).catch(() => {})));
    location.reload();
  } catch (e) {
    if (manual) alert('Could not check for updates. Are you online?');
  }
}

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

  $$('[data-hear]').forEach(b => b.addEventListener('click', hearPhrase));
  // Full screen / hide / show buttons for the falling notes.
  $('#screen-play').addEventListener('click', e => {
    const b = e.target.closest('[data-view]');
    if (b) setView(b.dataset.view);
  });
  // Speed sliders (one on the play screen, one in the full-screen bar) stay in sync.
  $$('.speed-slider').forEach(sl => {
    sl.min = TUNING.speedMin;
    sl.max = TUNING.speedMax;
    sl.addEventListener('input', () => setSpeed(parseFloat(sl.value)));
  });
  const hearLength = $('#hear-length');
  hearLength.value = String(settings.hearSeconds);
  if (hearLength.selectedIndex < 0) hearLength.value = '10';
  hearLength.addEventListener('change', () => { settings.hearSeconds = parseFloat(hearLength.value); saveSettings(); });
  // The free space for falling notes changes with the screen (rotation, Safari toolbars, messages).
  if ('ResizeObserver' in window) {
    new ResizeObserver(() => { if (state.screen === 'play' && !settings.sheetMusic) Roll.measure(); }).observe($('#roll-box'));
  }
  $('#hand-picker').addEventListener('click', e => {
    const b = e.target.closest('button[data-hand]');
    if (!b || !state.song || b.dataset.hand === state.hand) return;
    setHand(b.dataset.hand);
    Matcher.reset();
    $('#feedback').textContent = '';
    renderPlay();
  });
  $('#btn-restart').addEventListener('click', () => {
    stopPhrase(); state.idx = 0; Matcher.reset(); $('#feedback').textContent = ''; renderPlay(); });
  $('#btn-skip').addEventListener('click', () => {
    stopPhrase();
    if (state.song && state.idx < state.notes.length) { state.idx++; $('#feedback').textContent = ''; renderPlay(); }
  });
  $('#btn-prev').addEventListener('click', () => {
    stopPhrase();
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
      checkForUpdate();
    }
  });

  $('#btn-update').addEventListener('click', () => checkForUpdate(true));
  $('#app-version').textContent = `Version ${APP_VERSION}`;
  checkForUpdate();

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.screen === 'play') { renderStaff(); fitKeyboardToSong(); } }, 150);
  });

  updateMicUI();
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', init);
}

// Allow unit tests in Node: `node test-pitch.js`
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { yinDetect, analyzeFrame, synthTone, runPitchSelfTest, collapseToSequence, collapseEvents,
    buildHandEvents, guessTrackHand, notesForHand, phraseFrom, noteLength,
    midiToName, nameToMidi, midiToFreq, Matcher, DEFAULT_SETTINGS, TUNING, BUILTIN_SONGS };
}
