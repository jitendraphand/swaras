# Swaras

Interactive web app that pairs each musical tone (C3 to C4) with a geometric shape, so the ear and the eye learn the scale together. Play the notes, then sing them and watch your voice drawn live against the notes.

## Concept

Each step up the scale adds one side to the shape:

| Note | Swara | Frequency (Hz) | Shape              |
|------|-------|----------------|--------------------|
| C3   | Sa    | 130.81         | Dot (Point)        |
| D3   | Re    | 146.83         | Line               |
| E3   | Ga    | 164.81         | Angle              |
| F3   | Ma    | 174.61         | Triangle           |
| G3   | Pa    | 196.00         | Quadrilateral      |
| A3   | Dha   | 220.00         | Pentagon           |
| B3   | Ni    | 246.94         | Hexagon            |
| C4   | Ṡa    | 261.63         | Heptagon           |

## Features

- **Play notes** — tap a note (or press <kbd>1</kbd>–<kbd>8</kbd>) for a continuous tone; its shape draws itself on the stage. Tap again to stop.
- **Play scale** — ascending Sa to Ṡa.
- **Waveforms** — Sine, Triangle, Saw, Square, loudness-matched and switchable while a note plays.
- **Live pitch trace** — a scrolling graph with one lane per note. Your voice is drawn as a line coloured by the note it is closest to, so slides (meend), vibrato and drifting off-pitch are easy to see.
- **Sing along** — notes you play appear on the graph as target bars; the stage measures your voice against the playing note and the tuner shows how many cents flat or sharp you are.
- **Sing to draw** — with the mic on, holding a note in tune for about a second draws its shape. Drawn shapes are ticked off on the keys — try to collect all eight.
- **Live tuning tag** — a label beside the moving point shows the swara you're on and how many cents off, so you can keep your eyes on the graph.
- **Any octave** — higher and lower voices are folded onto the C3–C4 lanes, so everyone can practise the same notes.
- Settings are remembered between visits. No dependencies — pure HTML/CSS/JS.

Keyboard: <kbd>1</kbd>–<kbd>8</kbd> (or C D E F G A B H) play a note · <kbd>P</kbd> play scale · <kbd>M</kbd> microphone · <kbd>Esc</kbd> or <kbd>Space</kbd> stop.

## How pitch detection works

`pitch.js` contains the detector:

1. **Raw audio.** The browser's call-processing (noise suppression, auto gain) is switched off. Noise suppression treats a held note as noise and fades it out, which made detection drop out mid-note.
2. **Band-pass filter** (70 Hz – 1.4 kHz) removes rumble, mains hum and hiss before analysis.
3. **McLeod Pitch Method** (run on a 2× down-sampled copy of the band-limited signal, which is about four times cheaper and just as accurate) estimates the pitch and a *clarity* score — how periodic the sound is. Voices and instruments score high; fans, traffic, typing and breath noise score low and are ignored.
4. **Adaptive noise gate** learns the room's background level and only opens a few dB above it (adjust with *Sensitivity*).
5. **Smoothing** — a new note must be consistent for two frames; short dropouts (consonants) are held over for 150 ms; a median filter removes stray octave jumps.

**Tip:** if you play tones through speakers while singing, use headphones or turn on *Echo cancel*, otherwise the mic hears the tone too.

Microphone access needs a secure page (https:// or localhost) and your permission.

## GitHub Pages

This repository is set up for GitHub Pages.

### To publish:

1. Go to the repository **Settings** → **Pages**
2. Under **Build and deployment** → **Source**: select **Deploy from a branch**
3. Branch: `main` / `/ (root)`
4. Click **Save**
5. The site will be available at: `https://jitendraphand.github.io/Swaras/`

(It may take a minute or two for the first deployment.)

## Local Development

Open `index.html` in a modern browser to play notes. For the microphone, serve the folder over localhost, e.g. `python3 -m http.server`, and open `http://localhost:8000`. Audio needs a click or key press before it can start (browser policy).

## License

MIT
