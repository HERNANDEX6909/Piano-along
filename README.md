# Piano Wait Mode

A tiny web app that teaches piano one note at a time. It shows a note on the staff,
listens through your phone's microphone, and **waits until you play that note** before
moving on. No installs, no build step: just `index.html`, `app.js` and `styles.css`.

## Files

| File | What it is |
|---|---|
| `index.html` | The page and its four screens (songs, play, settings, MIDI import) |
| `app.js` | Everything else: pitch detection, MIDI import, storage, UI. Sections are numbered at the top. |
| `styles.css` | Mobile-first styles. Colors and sizes are variables at the top. |
| `test-pitch.js` | Optional offline test of the pitch detector with synthesized tones (`node test-pitch.js`) |

VexFlow (staff drawing) and @tonejs/midi (MIDI parsing) load from the jsDelivr CDN at
pinned versions, so the app needs an internet connection the first time it loads.

## Host it on GitHub Pages (free, HTTPS)

The microphone only works on **https://** pages, and GitHub Pages gives you that for free.

1. Create a GitHub account if you don't have one, then click **New repository**.
   Name it e.g. `piano-wait`, make it **Public**, and create it.
2. Click **Add file → Upload files**, drag in `index.html`, `app.js`, `styles.css`
   and `README.md`, then **Commit changes**. (Don't upload copyrighted MIDI files. You load
   those on your phone instead, and they stay on your phone.)
3. Go to **Settings → Pages**. Under *Build and deployment*, choose
   **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, then **Save**.
4. Wait a minute and refresh. The page shows your address, like
   `https://YOUR-NAME.github.io/piano-wait/`.

To update later, upload the changed files again. Pages redeploys in about a minute.

**Releasing an update:** raise the release number by 1 in three places: `APP_VERSION` near the
top of `app.js`, `version.json`, and `index.html` (the `app-version` meta tag and the `?v=` on
`styles.css` and `app.js`). Then upload those files plus anything else you changed. The app
checks `version.json` when it opens or comes back to the screen. If a newer version is online, it
downloads the new files and reloads. It waits until you're back on the song list, so it doesn't
interrupt practice. Settings → **Check for updates** does it on demand.

## Open it on iPhone

1. Open the `https://…github.io/…` link in **Safari**.
2. Pick a song, then tap **🎤 Start listening** and choose **Allow** for the microphone.
3. Put the phone on the music stand near the keyboard's speakers and play the blue note.

**Add it to the Home Screen** so it opens full-screen like an app:
tap the **Share** button (square with an arrow) → **Add to Home Screen** → **Add**.

> Keep using the Home Screen icon. Safari may delete a website's saved data after about
> 7 days without a visit, but Home Screen apps are exempt, so your uploaded songs are safer there.
> (Songs added in Safari and songs added from the Home Screen app are stored separately.)

### If the microphone doesn't work

- **"Microphone access is blocked"**: in Safari tap **aA** in the address bar →
  **Website Settings → Microphone → Allow**, or open the **Settings app → Apps → Safari →
  Microphone**. Then reload.
- **Nothing is heard**: watch the level meter. If the bar never passes the red line, move
  the noise gate down in **Settings**, or turn up the keyboard's volume.
- **Random notes in a noisy room**: Settings → **Set noise gate from room noise**.
- **Wrong octave**: keep **Accept any octave** ON (the default). Phone mics often hear piano notes an octave off.
- **It stopped after a call or switching apps**: tap **▶ Tap to resume listening**.
- The page must be `https://`. Opening `index.html` as a file won't allow the mic.

## How to use

- **Song list**: three public-domain starter songs plus a C-scale exercise. **Upload a MIDI
  file** to add your own. Uploads are saved in the browser (IndexedDB) and can be renamed or deleted.
- **MIDI import**: choose which tracks to include (drum tracks are unticked) and which hand plays
  each one. The app guesses: a single track is split at middle C, and with several tracks the
  higher one is the right hand. Each hand's chords become single notes on their own. By default
  the right hand keeps its top note (the melody) and the left hand keeps its lowest note (the bass).
  Timing is ignored. Only the order of notes matters.
- **Left hand / Right hand / Both**: at the top of the play screen. Practise each hand on its own
  until it flows, then try Both. Switching keeps your place in the song, and the app remembers
  your choice for each song.
- **Play screen**: fits on one phone screen without scrolling. The big name is the note to play. Above the on-screen piano, **falling notes**
  come down onto the keys to press: right hand in blue, left hand in orange. The note to play
  sits on the line above the keys (white outline) and waits there until you play it, then the
  next one slides down. The keyboard shrinks its keys so the whole song fits on screen.
  Use **⤢ Full screen** (top-right of the falling notes) to hide everything except the notes, the
  keys and a slim bar with the note, Hear it and the speed slider. **Hide notes** removes them;
  **Show falling notes** brings them back. The app remembers your choice.
  Prefer reading music? Settings → **Show sheet music instead of falling notes**.
  **Skip** moves past a note, **Back** goes back one, **Restart** starts over. The on-screen
  piano works without the mic.
- **🔊 Hear it** plays the song from the note you're on at its real speed. The menu next to it
  sets how long: 5, 10, 20 or 30 seconds, 1 minute, or the whole song. Tap **■ Stop** at any time.
  The falling notes move in time with the sound and each key lights up. The mic is ignored while
  it plays, so the phone's speaker can't move the song along. Slow it down with
  the **Speed** slider (25%–150%). Drag it while it plays: the speed changes instantly, without losing your place.
- **Heard** shows what the mic detects (note, Hz, and how sharp/flat in cents) with a level meter.

## Settings

| Setting | Default | What it does |
|---|---|---|
| Accept any octave | On | Right note name in any octave counts |
| Pitch tolerance | ±40 cents | How out-of-tune a note may be and still count |
| Noise gate | −50 dB | Ignore sound quieter than this |
| Hold time | 150 ms | How long a note must be steady before it counts |
| Detection sensitivity | 0.15 | YIN threshold: higher catches more, but with more mistakes |
| Treble / bass split | C4 | Notes from here up go on the treble staff |
| Playback speed | 100% | Hear it speed, 25–150% (also a slider on the play screen) |
| Sheet music | Off | Show the music staff instead of falling notes |
| Test mode | Off | On-screen keys play a synthesized tone *through the pitch detector* |

**Self-test** (in Settings) runs the detector on synthesized piano-like tones from C2 to C7
at 44.1 and 48 kHz and shows a pass/fail table, all without the mic.

## How it works (for tweaking)

- **Audio**: the mic goes through an `AudioWorklet` (or a `ScriptProcessor` on older browsers)
  that sends 2048-sample frames every 1024 samples to the main thread.
- **Pitch**: the [YIN algorithm](http://audition.ens.fr/adc/pdf/2002_JASA_YIN.pdf) (`yinDetect` in `app.js`)
  with parabolic interpolation. Range is 50–2200 Hz (`TUNING.minFreq/maxFreq`).
- **Matching** (`Matcher`): a note counts once it has been steady for the hold time. Holding the key
  doesn't count twice. Playing the *same* note again (like "C C" in Twinkle) is recognized by
  silence in between or by a jump in loudness from a fresh key press (`TUNING.onsetRatio`).
- Low-level constants are in `TUNING` at the top of `app.js`. Defaults for the settings screen are in `DEFAULT_SETTINGS`.

### Testing

```bash
node test-pitch.js
```

This checks detection on synthesized tones, the noise gate, the repeated-note logic, and chord
collapsing. To try the app on your computer, serve the folder locally (the mic works on `localhost`):

```bash
python -m http.server 8000
```

then open http://localhost:8000.

## Copyright note

Only public-domain melodies are built in (Twinkle Twinkle, Mary Had a Little Lamb, Ode to Joy).
Don't commit copyrighted songs or MIDI files to the repository. Upload them in the app, and they stay on your device.
