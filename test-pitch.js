// Offline tests for the pitch detector and note matcher. Run: node test-pitch.js
// Uses synthesized tones, so no microphone or browser is needed.
const A = require('./app.js');
let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log((ok ? 'PASS ' : 'FAIL ') + msg); };

// 1) Single frames of piano-like and sine tones across the range, at both common sample rates.
const s = Object.assign({}, A.DEFAULT_SETTINGS);
const rows = A.runPitchSelfTest(s);
const exact = rows.filter(r => r.pass).length;
check(exact === rows.length, `piano-like tones: ${exact}/${rows.length} exact`);
rows.filter(r => !r.pass).forEach(r => console.log('   ', r.sr, A.midiToName(r.expected), '->', r.detected === null ? 'none' : A.midiToName(r.detected), r.freq && r.freq.toFixed(1)));

for (const m of [40, 60, 69, 81]) {
  const buf = A.synthTone(A.midiToFreq(m), 48000, A.TUNING.frameSize, { type: 'sine', noise: 0 });
  const r = A.analyzeFrame(buf, 48000, s);
  check(r.midi === m && Math.abs(r.cents) <= 2, `sine ${A.midiToName(m)} -> ${r.midi && A.midiToName(r.midi)} (${r.freq.toFixed(2)} Hz, ${r.cents}¢)`);
}

// 2) Quarter-tone off (50 cents) should be rejected with a 40-cent tolerance.
{
  const f = A.midiToFreq(60) * Math.pow(2, 0.45 / 12);
  const r = A.analyzeFrame(A.synthTone(f, 48000, 2048, { type: 'sine', noise: 0 }), 48000, s);
  check(!r.voiced, `45 cents sharp is not accepted (cents=${r.cents})`);
}

// 3) Noise gate: quiet noise is gated, pure noise yields no note.
{
  const quiet = new Float32Array(2048).map(() => (Math.random() * 2 - 1) * 0.001);
  check(A.analyzeFrame(quiet, 48000, s).gated, 'quiet noise is gated');
  const loud = new Float32Array(2048).map(() => (Math.random() * 2 - 1) * 0.3);
  check(!A.analyzeFrame(loud, 48000, s).voiced, 'loud white noise is not a note');
}

// 4) Matcher on a simulated stream: C held, silence, C again, then G with legato re-strike.
{
  const sr = 48000, hop = A.TUNING.hopSize, frame = A.TUNING.frameSize;
  const events = [];
  A.Matcher.reset();
  A.Matcher.onNote = m => events.push(A.midiToName(m));
  // Build a continuous signal: [note midi | null, seconds, restrike?]
  const plan = [[60, 0.6], [null, 0.25], [60, 0.6], [67, 0.6], [67, 0.6], [null, 0.3]];
  const parts = [];
  for (const [m, sec] of plan) {
    const n = Math.round(sec * sr);
    parts.push(m === null ? new Float32Array(n).map(() => (Math.random() * 2 - 1) * 0.0005)
                          : A.synthTone(A.midiToFreq(m), sr, n, { type: 'piano', noise: 0.002 }));
  }
  const total = parts.reduce((a, p) => a + p.length, 0);
  const sig = new Float32Array(total);
  let off = 0; for (const p of parts) { sig.set(p, off); off += p.length; }
  for (let end = frame; end <= total; end += hop) {
    const res = A.analyzeFrame(sig.subarray(end - frame, end), sr, s);
    A.Matcher.update(res, (end / sr) * 1000);
  }
  const want = 'C4 C4 G4 G4';
  check(events.join(' ') === want, `matcher events "${events.join(' ')}" (want "${want}")`);
}

// 5) MIDI chord collapsing.
{
  const notes = [{ midi: 60, time: 0 }, { midi: 64, time: 0.01 }, { midi: 67, time: 0.005 }, { midi: 62, time: 0.5 }, { midi: 48, time: 1 }, { midi: 72, time: 1 }];
  check(A.collapseToSequence(notes, 'top').join() === '67,62,72', 'collapse top: ' + A.collapseToSequence(notes, 'top'));
  check(A.collapseToSequence(notes, 'bottom').join() === '60,62,48', 'collapse bottom: ' + A.collapseToSequence(notes, 'bottom'));
}

// 6) Hands: each hand's chords collapse separately, so left-hand notes survive.
{
  const rh = { hand: 'R', notes: [{ midi: 64, time: 0 }, { midi: 67, time: 0 }, { midi: 65, time: 0.5 }, { midi: 64, time: 1 }] };
  const lh = { hand: 'L', notes: [{ midi: 48, time: 0 }, { midi: 52, time: 0 }, { midi: 43, time: 1 }] };
  const ev = A.buildHandEvents([rh, lh], 'smart', 60);
  const str = ev.map(n => n.hand + A.midiToName(n.midi)).join(' ');
  check(str === 'LC3 RG4 RF4 LG2 RE4', 'both hands, smart chords: ' + str);
  const one = { hand: 'split', notes: [{ midi: 48, time: 0 }, { midi: 72, time: 0 }, { midi: 59, time: 1 }, { midi: 60, time: 2 }] };
  const sp = A.buildHandEvents([one], 'smart', 60).map(n => n.hand + A.midiToName(n.midi)).join(' ');
  check(sp === 'LC3 RC5 LB3 RC4', 'one track split by pitch: ' + sp);
  const tracks = [{ notes: [{ midi: 72 }, { midi: 76 }] }, { notes: [{ midi: 40 }, { midi: 62 }] }];
  check(A.guessTrackHand(tracks[0], tracks, 60) === 'R' && A.guessTrackHand(tracks[1], tracks, 60) === 'L', 'guess track hands by average pitch');
  const song = { notes: ev };
  check(A.notesForHand(song, 'L').map(n => n.midi).join() === '48,43', 'left hand only');
  check(A.notesForHand(song, 'R').length === 3 && A.notesForHand(song, 'both').length === 5, 'right hand only / both');
  check(A.notesForHand({ notes: [60, 48, 64] }, 'L').map(n => n.midi).join() === '48', 'old saved songs still work');
}

// 7) Built-in songs parsed.
check(A.BUILTIN_SONGS.every(s => s.notes.length > 10 && s.notes.every(n => Number.isInteger(n.midi) && 'RL'.includes(n.hand))), 'built-in songs parse');
check(A.notesForHand(A.BUILTIN_SONGS[3], 'L').length === 15, 'scale exercise has 15 left-hand notes');

// 8) Rhythm for "Hear it".
{
  const tw = A.BUILTIN_SONGS[0].notes; // 100 bpm → 0.6 s per beat
  check(Math.abs(tw[6].dur - 1.2) < 1e-9 && Math.abs(tw[7].time - 4.8) < 1e-9, 'Twinkle: "G4:2" is a half note, next note starts on beat 9');
  const ph = A.phraseFrom(tw, 0, 4.8);
  check(ph.length === 8 && ph[0].at === 0 && Math.abs(ph[7].at - 4.8) < 1e-9, 'phrase: 4.8 s = 8 notes at real timing');
  const ten = A.phraseFrom(tw, 0, 10);
  check(ten.every(n => n.at <= 10) && ten.length > 8, `"Hear it" 10 s: ${ten.length} notes`);
  check(A.phraseFrom(tw, 5, 0).length === tw.length - 5, '"Whole song" plays to the end');
  const rests = [{ midi: 60, time: 0, dur: 0.5 }, { midi: 62, time: 10, dur: 0.5 }, { midi: 64, time: 10.5 }];
  const pr = A.phraseFrom(rests, 0);
  check(pr[1].at === A.TUNING.hearMaxGapSec && pr[2].dur === 0.6, 'long rests shortened; missing length gets a default');
  const ev = A.buildHandEvents([{ hand: 'R', notes: [{ midi: 60, time: 0, dur: 0.25 }, { midi: 64, time: 0, dur: 0.75 }] }], 'top', 60);
  check(ev[0].dur === 0.75, 'chord keeps the length of the kept note');
}

// 9) Speed: frames per second the detector can handle (needs ~47/s).
{
  const buf = A.synthTone(110, 48000, 2048);
  const t0 = Date.now(); let n = 0;
  while (Date.now() - t0 < 500) { A.analyzeFrame(buf, 48000, s); n++; }
  console.log(`INFO detector speed: ~${Math.round(n * 2)} frames/s on this machine`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll tests passed');
process.exit(failures ? 1 : 0);
