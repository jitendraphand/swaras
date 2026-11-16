'use strict';

const { PitchTracker, midiToFreq, midiToName } = window.SwarasPitch;

// Low Sa to high Sa. Each step up the scale adds one side to the shape.
const NOTES = [
    { name: 'C3', swara: 'Sa',  midi: 48, shape: 'point', label: 'Dot',           color: '#f87171' },
    { name: 'D3', swara: 'Re',  midi: 50, shape: 'line',  label: 'Line',          color: '#fb923c' },
    { name: 'E3', swara: 'Ga',  midi: 52, shape: 'angle', label: 'Angle',         color: '#facc15' },
    { name: 'F3', swara: 'Ma',  midi: 53, sides: 3,       label: 'Triangle',      color: '#4ade80' },
    { name: 'G3', swara: 'Pa',  midi: 55, sides: 4,       label: 'Quadrilateral', color: '#2dd4bf' },
    { name: 'A3', swara: 'Dha', midi: 57, sides: 5,       label: 'Pentagon',      color: '#60a5fa' },
    { name: 'B3', swara: 'Ni',  midi: 59, sides: 6,       label: 'Hexagon',       color: '#a78bfa' },
    { name: 'C4', swara: 'Ṡa',  midi: 60, sides: 7,       label: 'Heptagon',      color: '#f472b6' }
].map((note, index) => ({ ...note, index, freq: midiToFreq(note.midi), rgb: hexToRgb(note.color) }));

const NOTE_MIDIS = new Set(NOTES.map(n => n.midi));
const KEY_TO_NOTE = { 1: 0, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, c: 0, d: 1, e: 2, f: 3, g: 4, a: 5, b: 6, h: 7 };

const WAVE_LEVEL = { sine: 0.9, triangle: 0.8, sawtooth: 0.4, square: 0.34 }; // roughly equal loudness
const NOTE_LENGTH = { min: 0.25, max: 5, step: 0.25 }; // seconds each scale note plays
const SCALE_STARTING = -1;     // tone.scaleTimer while the scale waits for audio to start
const DRAW_IN_SECONDS = 0.7;   // how long a played note takes to draw its shape
const HOLD_TO_DRAW = 1.0;      // seconds of in-tune singing that completes a shape
const IN_TUNE_CENTS = 15;
const CLOSE_CENTS = 30;
const GAP_BRIDGE = 0.16;       // trace breaks shorter than this (s) are joined up
const GRAPH = { low: 46.5, high: 61.5, maxSeconds: 8, gutter: 72, padRight: 16, padY: 14 };
const CHART_CENTER = (GRAPH.low + GRAPH.high) / 2;
const FONT = 'Inter, system-ui, sans-serif';
const TAU = Math.PI * 2;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const settings = loadSettings();

const $ = id => document.getElementById(id);
const els = {
    stage: $('stage'),
    stageMode: $('stageMode'),
    stageNote: $('stageNote'),
    stageSwara: $('stageSwara'),
    stageDetail: $('stageDetail'),
    tuner: $('tuner'),
    tunerNeedle: $('tunerNeedle'),
    tunerText: $('tunerText'),
    shapeCanvas: $('shapeCanvas'),
    traceCanvas: $('traceCanvas'),
    traceEmpty: $('traceEmpty'),
    micBtn: $('micBtn'),
    micStatus: $('micStatus'),
    meter: $('meter'),
    meterFill: $('meterFill'),
    meterGate: $('meterGate'),
    optOctave: $('optOctave'),
    optEcho: $('optEcho'),
    optSensitivity: $('optSensitivity'),
    keys: $('keys'),
    waveform: $('waveform'),
    volume: $('volume'),
    volumeValue: $('volumeValue'),
    noteLength: $('noteLength'),
    noteLengthValue: $('noteLengthValue'),
    optLoop: $('optLoop'),
    scaleBtn: $('scaleBtn'),
    stopBtn: $('stopBtn'),
    announcer: $('announcer')
};

const audio = { ctx: null, master: null, voice: null };
const tone = { index: -1, startedAt: 0, token: 0, scaleTimer: null, step: 0, stepStartedAt: 0 };
const mic = { stream: null, nodes: [], analyser: null, buffer: null, tracker: null, starting: false };
const voice = { result: null, display: null, octaveOffset: 0, lastFreshAt: -Infinity };
const trace = { points: [], bars: [], hasContent: false };
const stage = { index: -1, lastIndex: -1, progress: 0, locked: false, cents: null, sungIndex: -1 };
const views = { stage: makeView(els.shapeCanvas), trace: makeView(els.traceCanvas) };

// ---------------------------------------------------------------- settings

function loadSettings() {
    const defaults = { waveform: 'sine', volume: 0.6, anyOctave: true, echoCancel: false, sensitivity: 0.5, noteLength: 1, loop: false };
    try {
        const saved = JSON.parse(localStorage.getItem('swaras.settings')) || {};
        if (saved.waveform in WAVE_LEVEL) defaults.waveform = saved.waveform;
        if (typeof saved.anyOctave === 'boolean') defaults.anyOctave = saved.anyOctave;
        if (typeof saved.echoCancel === 'boolean') defaults.echoCancel = saved.echoCancel;
        if (Number.isFinite(saved.volume)) defaults.volume = clamp(saved.volume, 0, 1);
        if (Number.isFinite(saved.sensitivity)) defaults.sensitivity = clamp(saved.sensitivity, 0, 1);
        if (Number.isFinite(saved.noteLength)) {
            const snapped = Math.round(saved.noteLength / NOTE_LENGTH.step) * NOTE_LENGTH.step;
            defaults.noteLength = clamp(snapped, NOTE_LENGTH.min, NOTE_LENGTH.max);
        }
        if (typeof saved.loop === 'boolean') defaults.loop = saved.loop;
    } catch (err) {
        // Storage unavailable (private mode etc.) — defaults are fine.
    }
    return defaults;
}

function saveSettings() {
    try {
        localStorage.setItem('swaras.settings', JSON.stringify(settings));
    } catch (err) {
        // Not persisting is harmless.
    }
}

// ---------------------------------------------------------------- tone playback

async function ensureAudio() {
    if (!audio.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) throw new Error('This browser does not support the Web Audio API.');
        audio.ctx = new Ctx();
        audio.master = audio.ctx.createGain();
        audio.master.gain.value = volumeToGain(settings.volume);
        audio.master.connect(audio.ctx.destination);
    }
    if (audio.ctx.state !== 'running') {
        try {
            await audio.ctx.resume();
        } catch (err) {
            console.warn('Could not resume audio:', err);
        }
    }
    return audio.ctx;
}

function volumeToGain(v) {
    return v * v; // perceptually smoother than linear
}

// keepScale: true when the scale sequencer (or a waveform switch) restarts the tone.
async function startTone(index, keepScale = false) {
    if (!keepScale) stopScale();
    const token = ++tone.token;
    let ctx;
    try {
        ctx = await ensureAudio();
    } catch (err) {
        els.stageDetail.textContent = err.message;
        return;
    }
    if (token !== tone.token) return; // stopped or replaced while audio was starting
    if (ctx.state !== 'running') {
        els.stageDetail.textContent = 'Tap again to enable sound.';
        return;
    }

    releaseVoice();
    const note = NOTES[index];
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    osc.type = settings.waveform;
    osc.frequency.value = note.freq;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(WAVE_LEVEL[settings.waveform], now + 0.03);
    osc.connect(gain);
    gain.connect(audio.master);
    osc.start(now);
    audio.voice = { osc, gain };
    setTone(index);
}

// Fade the sounding oscillator out and free it once it has actually stopped,
// so switching notes crossfades instead of clicking.
function releaseVoice() {
    const v = audio.voice;
    if (!v) return;
    audio.voice = null;
    const now = audio.ctx.currentTime;
    v.gain.gain.cancelScheduledValues(now);
    v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    v.gain.gain.setTargetAtTime(0, now, 0.02);
    v.osc.onended = () => {
        v.osc.disconnect();
        v.gain.disconnect();
    };
    v.osc.stop(now + 0.15);
}

function stopTone() {
    tone.token++;
    releaseVoice();
    setTone(-1);
}

function stopAll() {
    stopScale();
    stopTone();
}

function setTone(index) {
    if (index === tone.index) return;
    const now = clock();
    const open = trace.bars[trace.bars.length - 1];
    if (open && open.t1 === null) open.t1 = now;
    tone.index = index;
    if (index >= 0) {
        const note = NOTES[index];
        tone.startedAt = now;
        trace.bars.push({ index, t0: now, t1: null });
        trace.hasContent = true;
        announce(`${note.name}, ${note.swara}: ${note.label}`);
    }
    renderKeys();
    if (mic.analyser) renderMicStatus();
    requestFrame();
}

async function playScale() {
    if (tone.scaleTimer !== null) {
        stopAll();
        return;
    }
    // Marks the scale as running while audio starts up, so the first note's
    // timer only begins once it can actually sound.
    tone.scaleTimer = SCALE_STARTING;
    renderScaleButton();
    try {
        await ensureAudio();
    } catch (err) {
        // startTone reports the problem on the stage.
    }
    if (tone.scaleTimer !== SCALE_STARTING) return; // stopped while audio was starting
    tone.step = 0;
    tone.stepStartedAt = 0;
    advanceScale();
}

// Play the next note of the scale; after the last one, start over if looping.
function advanceScale() {
    if (tone.step >= NOTES.length) {
        if (!settings.loop) {
            tone.scaleTimer = null;
            stopTone();
            renderScaleButton();
            return;
        }
        tone.step = 0;
    }
    startTone(tone.step++, true);
    // Time each note from when it was due, not when the timer fired, so a long
    // loop doesn't drift; start afresh if we fell well behind (e.g. a busy tab).
    const now = performance.now();
    const due = tone.stepStartedAt + settings.noteLength * 1000;
    tone.stepStartedAt = tone.stepStartedAt && now - due < 100 ? due : now;
    scheduleScaleStep();
}

function scheduleScaleStep() {
    clearTimeout(tone.scaleTimer);
    const delay = tone.stepStartedAt + settings.noteLength * 1000 - performance.now();
    tone.scaleTimer = setTimeout(advanceScale, Math.max(0, delay));
}

function stopScale() {
    if (tone.scaleTimer === null) return;
    clearTimeout(tone.scaleTimer);
    tone.scaleTimer = null;
    renderScaleButton();
}

// ---------------------------------------------------------------- microphone

async function startListening() {
    if (mic.analyser || mic.starting) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        setMicStatus('The microphone needs a secure page (https:// or localhost).', 'error');
        return;
    }
    mic.starting = true;
    renderMicButton();
    setMicStatus('Waiting for microphone permission…');
    let stream = null;
    try {
        const ctx = await ensureAudio();
        // The browser's voice-call processing is built for speech: noise
        // suppression treats a held note as noise and fades it out, and auto
        // gain pumps the level. Both made detection drop out, so turn them off
        // and do our own noise handling instead.
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: settings.echoCancel,
                noiseSuppression: false,
                autoGainControl: false
            }
        });
        const source = ctx.createMediaStreamSource(stream);
        // Band-limit to the singing range: drops rumble/hum below and hiss above.
        const highpass = ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 70;
        const lowpass = ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = 1400;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = ctx.sampleRate > 50000 ? 4096 : 2048;
        // Some browsers only process nodes that reach the output; keep it silent.
        const sink = ctx.createGain();
        sink.gain.value = 0;
        source.connect(highpass);
        highpass.connect(lowpass);
        lowpass.connect(analyser);
        analyser.connect(sink);
        sink.connect(ctx.destination);

        mic.stream = stream;
        mic.nodes = [source, highpass, lowpass, analyser, sink];
        mic.analyser = analyser;
        mic.buffer = new Float32Array(analyser.fftSize);
        mic.tracker = new PitchTracker(ctx.sampleRate, { sensitivity: settings.sensitivity });
        voice.octaveOffset = 0;
        stream.getAudioTracks().forEach(track => {
            track.addEventListener('ended', () => stopListening('The microphone was disconnected.'));
        });
        trace.hasContent = true;
        requestFrame();
    } catch (err) {
        console.error('Microphone error:', err);
        if (stream && !mic.stream) stream.getTracks().forEach(track => track.stop());
        setMicStatus(micErrorMessage(err), 'error');
    } finally {
        mic.starting = false;
        renderMicButton();
        if (mic.analyser) renderMicStatus();
    }
}

function stopListening(message) {
    if (mic.stream) mic.stream.getTracks().forEach(track => track.stop());
    mic.nodes.forEach(node => node.disconnect());
    mic.stream = null;
    mic.nodes = [];
    mic.analyser = null;
    mic.tracker = null;
    voice.result = null;
    voice.display = null;
    els.meter.classList.remove('is-live', 'is-open');
    els.meterFill.style.width = '0%';
    renderMicButton();
    if (message) setMicStatus(message, 'error');
    else renderMicStatus();
    requestFrame();
}

function micErrorMessage(err) {
    switch (err && err.name) {
        case 'NotAllowedError':
        case 'SecurityError':
            return 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.';
        case 'NotFoundError':
        case 'OverconstrainedError':
            return 'No microphone was found. Connect one and try again.';
        case 'NotReadableError':
        case 'AbortError':
            return 'The microphone is in use by another app.';
        default:
            return 'Couldn’t start the microphone.';
    }
}

function analyseMic(now) {
    mic.analyser.getFloatTimeDomainData(mic.buffer);
    const r = mic.tracker.process(mic.buffer, now);
    voice.result = r;
    if (!r.voiced) {
        voice.display = null;
    } else if (r.fresh) {
        const offset = voice.octaveOffset;
        voice.display = toDisplayMidi(r.midi, now);
        voice.lastFreshAt = now;
        pushPoint(now, voice.display, voice.octaveOffset !== offset);
    }

    const open = r.voiced;
    els.meter.classList.add('is-live');
    els.meter.classList.toggle('is-open', open);
    els.meterFill.style.width = levelPercent(r.levelDb) + '%';
    els.meterGate.style.left = levelPercent(r.gateDb) + '%';
}

function levelPercent(db) {
    return clamp((db + 80) / 70, 0, 1) * 100;
}

// With "Any octave" on, voices outside the chart are shifted by whole octaves
// so their notes land on the matching lanes. The shift is kept for the whole
// phrase so the line doesn't jump around, and re-chosen after a pause.
function toDisplayMidi(midi, now) {
    if (!settings.anyOctave) return midi;
    if (now - voice.lastFreshAt > 1.5) voice.octaveOffset = 0;
    const inChart = m => m >= GRAPH.low && m <= GRAPH.high;
    if (!inChart(midi + voice.octaveOffset)) {
        voice.octaveOffset = inChart(midi) ? 0 : -12 * Math.round((midi - CHART_CENTER) / 12);
    }
    return midi + voice.octaveOffset;
}

function nearestNote(midi) {
    let best = NOTES[0];
    for (const note of NOTES) {
        if (Math.abs(midi - note.midi) < Math.abs(midi - best.midi)) best = note;
    }
    return { index: best.index, cents: Math.round((midi - best.midi) * 100) };
}

// ---------------------------------------------------------------- frame loop

let rafId = 0;
let lastTick = 0;

function clock() {
    return performance.now() / 1000;
}

function requestFrame() {
    if (!rafId) rafId = requestAnimationFrame(tick);
}

function tick(ms) {
    rafId = 0;
    const now = ms / 1000;
    const dt = lastTick ? Math.min(0.1, Math.max(0, now - lastTick)) : 0;
    lastTick = now;

    if (mic.analyser) analyseMic(now);
    pruneTrace(now);
    updateStage(now, dt);
    drawStage(now);
    drawTrace(now);
    renderReadouts(now);

    if (mic.analyser || tone.index >= 0) requestFrame();
    else lastTick = 0;
}

function updateStage(now, dt) {
    const listening = !!mic.analyser;
    const singing = listening && voice.result && voice.result.voiced && voice.display !== null;
    let index = tone.index;
    let cents = null;
    let sungIndex = -1;

    if (singing) {
        const near = nearestNote(voice.display);
        if (Math.abs(near.cents) <= 50) sungIndex = near.index;
        if (index >= 0) {
            // Singing along: measure against the note being played.
            let diff = voice.display - NOTES[index].midi;
            if (settings.anyOctave) diff -= 12 * Math.round(diff / 12);
            cents = Math.round(diff * 100);
        } else {
            index = near.index;
            cents = near.cents;
        }
    }

    if (index !== stage.index) {
        stage.index = index;
        stage.progress = 0;
        stage.locked = false;
        if (index >= 0) stage.lastIndex = index;
    }

    if (index >= 0 && listening) {
        // With the mic on, your voice draws the shape: hold the note in tune.
        if (cents !== null && Math.abs(cents) <= IN_TUNE_CENTS) stage.progress = Math.min(1, stage.progress + dt / HOLD_TO_DRAW);
        else stage.progress = Math.max(0, stage.progress - dt / 1.5);
    } else if (index >= 0) {
        stage.progress = reducedMotion.matches ? 1 : clamp((now - tone.startedAt) / DRAW_IN_SECONDS, 0, 1);
    }

    if (stage.progress >= 1 && !stage.locked) {
        stage.locked = true;
        if (singing) announce(`${NOTES[index].name} held in tune`);
    } else if (stage.progress < 0.6) {
        stage.locked = false;
    }

    if (sungIndex !== stage.sungIndex && sungIndex >= 0 && tone.index < 0) {
        announce(`Singing ${NOTES[sungIndex].name}, ${NOTES[sungIndex].swara}`);
    }
    stage.cents = cents;
    stage.sungIndex = sungIndex;
}

// `remapped`: the octave shift changed here, so don't join it to the previous point.
function pushPoint(t, midi, remapped) {
    const near = nearestNote(midi);
    trace.points.push({ t, m: midi, c: Math.abs(near.cents) <= 50 ? near.index : -1, remapped });
}

// About 130 px per second of history: 8 s on desktop, less on a phone.
function graphSeconds() {
    return clamp((views.trace.width - GRAPH.gutter - GRAPH.padRight) / 130, 4, GRAPH.maxSeconds);
}

function pruneTrace(now) {
    const cutoff = now - GRAPH.maxSeconds - 1;
    let drop = 0;
    while (drop < trace.points.length && trace.points[drop].t < cutoff) drop++;
    if (drop) trace.points.splice(0, drop);
    while (trace.bars.length && trace.bars[0].t1 !== null && trace.bars[0].t1 < cutoff) trace.bars.shift();
}

// ---------------------------------------------------------------- shapes

// Geometry for a note's shape, centred on (cx, cy) with radius r.
function shapeGeometry(note, cx, cy, r) {
    if (note.shape === 'point') return { point: true, cx, cy, r };
    if (note.shape === 'line') return { points: [[cx - 0.8 * r, cy], [cx + 0.8 * r, cy]], closed: false };
    if (note.shape === 'angle') {
        return { points: [[cx - 0.65 * r, cy + 0.5 * r], [cx, cy - 0.55 * r], [cx + 0.65 * r, cy + 0.5 * r]], closed: false };
    }
    const n = note.sides;
    // Odd polygons sit point-up; nudge them down so they look centred.
    const dy = n % 2 ? (r - r * Math.cos(Math.PI / n)) / 2 : 0;
    const points = [];
    for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU - Math.PI / 2;
        points.push([cx + r * Math.cos(a), cy + dy + r * Math.sin(a)]);
    }
    return { points, closed: true };
}

// Path of the first `progress` (0–1) of the outline; returns the vertices reached.
function outlinePath(ctx, geo, progress) {
    const pts = geo.closed ? geo.points.concat([geo.points[0]]) : geo.points;
    const lengths = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        lengths.push(len);
        total += len;
    }
    let remaining = total * progress;
    const reached = [pts[0]];
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length && remaining > 0; i++) {
        const len = lengths[i - 1];
        if (remaining >= len - 1e-6) {
            ctx.lineTo(pts[i][0], pts[i][1]);
            if (!geo.closed || i < pts.length - 1) reached.push(pts[i]);
            remaining -= len;
        } else {
            const f = remaining / len;
            ctx.lineTo(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * f, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * f);
            remaining = 0;
        }
    }
    if (geo.closed && progress >= 1) ctx.closePath();
    return reached;
}

// `detailed` adds the stage-only extras: the ring around the dot and vertex dots.
function drawShape(ctx, note, cx, cy, r, { progress = 1, alpha = 1, width = 2, glow = 0, fill = 0, detailed = false }) {
    const geo = shapeGeometry(note, cx, cy, r);
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = width;
    ctx.strokeStyle = rgba(note.rgb, alpha);
    ctx.fillStyle = rgba(note.rgb, alpha);
    if (glow) {
        ctx.shadowColor = note.color;
        ctx.shadowBlur = glow;
    }
    if (geo.point) {
        ctx.beginPath();
        ctx.arc(cx, cy, r * (detailed ? 0.16 : 0.38), 0, TAU);
        ctx.fill();
        if (detailed && progress > 0) {
            ctx.beginPath();
            ctx.arc(cx, cy, r * 0.42, -Math.PI / 2, -Math.PI / 2 + TAU * progress);
            ctx.stroke();
        }
    } else if (progress > 0) {
        const reached = outlinePath(ctx, geo, progress);
        if (fill) {
            ctx.save();
            ctx.shadowBlur = 0;
            ctx.fillStyle = rgba(note.rgb, fill);
            ctx.fill();
            ctx.restore();
        }
        ctx.stroke();
        if (detailed) {
            ctx.shadowBlur = 0;
            for (const [x, y] of reached) {
                ctx.beginPath();
                ctx.arc(x, y, width * 0.95, 0, TAU);
                ctx.fill();
            }
        }
    }
    ctx.restore();
}

function shapeSvg(note) {
    const geo = shapeGeometry(note, 20, 20, 15);
    if (geo.point) return '<circle class="dot" cx="20" cy="20" r="5"/>';
    const pts = geo.points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    return geo.closed ? `<polygon points="${pts}"/>` : `<polyline points="${pts}"/>`;
}

// ---------------------------------------------------------------- drawing

function makeView(canvas) {
    return { canvas, ctx: canvas.getContext('2d'), width: 0, height: 0 };
}

function fitView(view) {
    const rect = view.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    view.width = Math.max(1, Math.round(rect.width));
    view.height = Math.max(1, Math.round(rect.height));
    view.canvas.width = Math.round(view.width * dpr);
    view.canvas.height = Math.round(view.height * dpr);
    view.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawStage(now) {
    const { ctx, width: w, height: h } = views.stage;
    ctx.clearRect(0, 0, w, h);
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.3;

    if (stage.index < 0 && stage.lastIndex < 0) {
        // Nothing played yet: show the whole family of shapes in a ring.
        NOTES.forEach((note, i) => {
            const a = (i / NOTES.length) * TAU - Math.PI / 2;
            drawShape(ctx, note, cx + Math.cos(a) * r * 1.05, cy + Math.sin(a) * r * 1.05, r * 0.22, { alpha: 0.55, width: 1.6 });
        });
        return;
    }

    const active = stage.index >= 0;
    const note = NOTES[active ? stage.index : stage.lastIndex];
    const pulse = stage.locked && !reducedMotion.matches ? 0.5 + 0.5 * Math.sin(now * 4) : 0;

    if (active) {
        const glow = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r * 1.7);
        glow.addColorStop(0, rgba(note.rgb, 0.1 + 0.18 * stage.progress + 0.06 * pulse));
        glow.addColorStop(1, rgba(note.rgb, 0));
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, w, h);
    }

    // The target outline, then the part drawn so far on top.
    drawShape(ctx, note, cx, cy, r, { alpha: active ? 0.22 : 0.18, width: Math.max(2, r * 0.025), detailed: true });
    if (!active) return;
    drawShape(ctx, note, cx, cy, r, {
        progress: stage.progress,
        width: Math.max(3, r * 0.055),
        glow: r * (0.1 + 0.08 * pulse),
        fill: stage.locked ? 0.14 + 0.06 * pulse : 0,
        detailed: true
    });
}

function drawTrace(now) {
    const { ctx, width: w, height: h } = views.trace;
    ctx.clearRect(0, 0, w, h);
    const left = GRAPH.gutter;
    const right = w - GRAPH.padRight;
    const top = GRAPH.padY;
    const bottom = h - GRAPH.padY;
    const span = GRAPH.high - GRAPH.low;
    const pxPerSemitone = (bottom - top) / span;
    const y = m => top + (GRAPH.high - clamp(m, GRAPH.low, GRAPH.high)) * pxPerSemitone;
    const seconds = graphSeconds();
    const x = t => right - ((now - t) / seconds) * (right - left);
    const start = now - seconds;
    const band = Math.max(3, (IN_TUNE_CENTS / 100) * pxPerSemitone);

    ctx.lineWidth = 1;

    // Second markers drift left as time passes.
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.07)';
    ctx.beginPath();
    for (let s = Math.ceil(start); s <= now; s++) {
        const xs = Math.round(x(s)) + 0.5;
        ctx.moveTo(xs, top);
        ctx.lineTo(xs, bottom);
    }
    ctx.stroke();

    // Sharps/flats between the lanes.
    ctx.setLineDash([2, 5]);
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.beginPath();
    for (let m = Math.ceil(GRAPH.low); m <= GRAPH.high; m++) {
        if (NOTE_MIDIS.has(m)) continue;
        const ym = Math.round(y(m)) + 0.5;
        ctx.moveTo(left, ym);
        ctx.lineTo(right, ym);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // A lane per note, labelled with its shape.
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (const note of NOTES) {
        const ym = y(note.midi);
        const hot = note.index === stage.sungIndex || note.index === tone.index;
        ctx.fillStyle = rgba(note.rgb, hot ? 0.13 : 0.04);
        ctx.fillRect(left, ym - band, right - left, band * 2);
        ctx.strokeStyle = rgba(note.rgb, hot ? 0.8 : 0.28);
        ctx.beginPath();
        ctx.moveTo(left, Math.round(ym) + 0.5);
        ctx.lineTo(right, Math.round(ym) + 0.5);
        ctx.stroke();

        drawShape(ctx, note, 14, ym, 6.5, { alpha: hot ? 1 : 0.75, width: 1.6 });
        ctx.font = `700 11px ${FONT}`;
        ctx.fillStyle = hot ? '#ffffff' : 'rgba(232, 237, 247, 0.72)';
        ctx.fillText(note.name, 27, ym);
        ctx.font = `500 11px ${FONT}`;
        ctx.fillStyle = hot ? note.color : 'rgba(160, 171, 194, 0.6)';
        ctx.fillText(note.swara, 49, ym);
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, 0, right - left + GRAPH.padRight, h);
    ctx.clip();

    // Notes that were played: target bars to sing along with.
    for (const bar of trace.bars) {
        const end = bar.t1 === null ? now : bar.t1;
        if (end < start) continue;
        const note = NOTES[bar.index];
        const ym = y(note.midi);
        const x0 = x(bar.t0);
        roundRect(ctx, x0, ym - band, Math.max(band * 2, x(end) - x0), band * 2, band);
        ctx.fillStyle = rgba(note.rgb, bar.t1 === null ? 0.3 : 0.2);
        ctx.fill();
        ctx.strokeStyle = rgba(note.rgb, 0.6);
        ctx.stroke();
    }

    // The voice: a glow pass, then the line, coloured by the nearest note.
    const pts = trace.points;
    let first = 0;
    while (first < pts.length && pts[first].t < start - GAP_BRIDGE) first++;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const pass of [{ width: 9, alpha: 0.14 }, { width: 3, alpha: 1 }]) {
        ctx.lineWidth = pass.width;
        let prev = null;
        let color = null;
        for (let i = first; i < pts.length; i++) {
            const p = pts[i];
            const joined = prev && p.t - prev.t <= GAP_BRIDGE && !p.remapped;
            if (!joined || p.c !== color) {
                if (color !== null) ctx.stroke();
                ctx.strokeStyle = p.c >= 0 ? rgba(NOTES[p.c].rgb, pass.alpha) : `rgba(203, 213, 225, ${pass.alpha * 0.8})`;
                ctx.beginPath();
                const from = joined ? prev : p;
                ctx.moveTo(x(from.t), y(from.m));
                color = p.c;
            }
            ctx.lineTo(x(p.t), y(p.m));
            prev = p;
        }
        if (color !== null) ctx.stroke();
    }

    // Live head of the line.
    const last = pts[pts.length - 1];
    if (last && voice.display !== null && now - last.t < 0.3) {
        const hx = x(last.t);
        const hy = y(last.m);
        const rgb = last.c >= 0 ? NOTES[last.c].rgb : [226, 232, 240];
        ctx.fillStyle = rgba(rgb, 0.22);
        ctx.beginPath();
        ctx.arc(hx, hy, 11, 0, TAU);
        ctx.fill();
        ctx.fillStyle = rgba(rgb, 1);
        ctx.beginPath();
        ctx.arc(hx, hy, 5, 0, TAU);
        ctx.fill();
        if (last.m > GRAPH.high || last.m < GRAPH.low) {
            // Off the chart: point the way.
            const dir = last.m > GRAPH.high ? 1 : -1;
            ctx.beginPath();
            ctx.moveTo(hx - 12, hy + dir * 4);
            ctx.lineTo(hx - 6, hy - dir * 3);
            ctx.lineTo(hx, hy + dir * 4);
            ctx.strokeStyle = rgba(rgb, 1);
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    }
    ctx.restore();

    // "Now" edge.
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(right) + 0.5, top);
    ctx.lineTo(Math.round(right) + 0.5, bottom);
    ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
}

// ---------------------------------------------------------------- DOM readouts

const shown = {};
let detailUpdatedAt = 0;

function setText(el, key, value) {
    if (shown[key] === value) return;
    shown[key] = value;
    el.textContent = value;
}

function renderReadouts(now) {
    const listening = !!mic.analyser;
    const singing = listening && voice.display !== null;
    const active = stage.index >= 0;
    const index = active ? stage.index : stage.lastIndex;
    const note = index >= 0 ? NOTES[index] : null;

    let mode = 'idle';
    let modeLabel = 'Ready';
    if (tone.index >= 0 && listening) { mode = 'along'; modeLabel = 'Sing along'; }
    else if (tone.index >= 0) { mode = 'tone'; modeLabel = 'Playing'; }
    else if (singing) { mode = 'voice'; modeLabel = 'Hearing you'; }
    else if (listening) { mode = 'listening'; modeLabel = 'Listening'; }
    if (shown.mode !== mode) {
        shown.mode = mode;
        els.stageMode.dataset.mode = mode;
        els.stageMode.textContent = modeLabel;
    }

    if (shown.noteIndex !== index) {
        shown.noteIndex = index;
        els.stage.style.setProperty('--note', note ? note.color : 'var(--accent)');
        els.shapeCanvas.setAttribute('aria-label', note ? `${note.name} (${note.swara}): ${note.label}` : 'No note selected');
    }
    if (shown.active !== active) {
        shown.active = active;
        els.stage.dataset.active = String(active);
    }
    if (shown.empty !== !note) {
        shown.empty = !note;
        els.stage.dataset.empty = String(!note);
    }
    setText(els.stageNote, 'stageNote', note ? note.name : '');
    setText(els.stageSwara, 'stageSwara', note ? note.swara : '');

    // Frequencies change every frame; refresh the text a few times a second.
    if (now - detailUpdatedAt > 0.12 || !singing) {
        detailUpdatedAt = now;
        let detail;
        if (singing && note) {
            const r = voice.result;
            detail = `${note.label} · you: ${r.freq.toFixed(1)} Hz (${midiToName(r.midi)})`;
        } else if (note && tone.index >= 0) {
            detail = `${note.label} · ${note.freq.toFixed(2)} Hz · ${settings.waveform}`;
        } else if (listening) {
            detail = 'Sing a steady note…';
        } else if (note) {
            detail = `${note.label} · ${note.freq.toFixed(2)} Hz`;
        } else {
            detail = 'Tap a note to hear it, or start listening and sing.';
        }
        setText(els.stageDetail, 'detail', detail);
    }

    const cents = singing ? stage.cents : null;
    let tunerState = 'off';
    let tunerText = listening ? 'Sing…' : '—';
    if (cents !== null) {
        const abs = Math.abs(cents);
        tunerState = abs <= IN_TUNE_CENTS ? 'good' : abs <= CLOSE_CENTS ? 'close' : 'far';
        if (abs <= IN_TUNE_CENTS) tunerText = 'In tune';
        else if (abs <= 50) tunerText = `${cents > 0 ? '+' : '−'}${abs}¢ ${cents > 0 ? 'sharp' : 'flat'}`;
        else tunerText = cents < 0 ? 'Sing higher ↑' : 'Sing lower ↓';
        els.tunerNeedle.style.left = `${50 + clamp(cents, -50, 50)}%`;
    }
    if (shown.tunerState !== tunerState) {
        shown.tunerState = tunerState;
        els.tuner.dataset.state = tunerState;
    }
    setText(els.tunerText, 'tunerText', tunerText);

    if (shown.sungIndex !== stage.sungIndex) {
        shown.sungIndex = stage.sungIndex;
        els.keys.querySelectorAll('.key').forEach((key, i) => key.classList.toggle('is-sung', i === stage.sungIndex));
    }

    els.traceEmpty.hidden = trace.hasContent;
}

function renderKeys() {
    els.keys.querySelectorAll('.key').forEach((key, i) => {
        const playing = i === tone.index;
        key.classList.toggle('is-playing', playing);
        key.setAttribute('aria-pressed', String(playing));
    });
}

function renderScaleButton() {
    const running = tone.scaleTimer !== null;
    els.scaleBtn.setAttribute('aria-pressed', String(running));
    els.scaleBtn.querySelector('.btn-label').textContent = running ? 'Stop scale' : 'Play scale';
}

function renderNoteLength() {
    els.noteLengthValue.textContent = `${settings.noteLength} s`;
    syncRangeFill(els.noteLength);
}

function renderMicButton() {
    const on = !!mic.analyser;
    els.micBtn.setAttribute('aria-pressed', String(on));
    els.micBtn.disabled = mic.starting;
    els.micBtn.querySelector('.btn-label').textContent = on ? 'Stop listening' : mic.starting ? 'Starting…' : 'Start listening';
}

function renderMicStatus() {
    if (mic.starting) return;
    if (!mic.analyser) setMicStatus('Sing and watch your voice move between the notes.');
    else if (tone.index >= 0 && !settings.echoCancel) setMicStatus('Tip: use headphones so the mic hears only your voice, not the tone.', 'hint');
    else setMicStatus('Listening — background noise is filtered out.');
}

function setMicStatus(text, kind) {
    els.micStatus.textContent = text;
    if (kind) els.micStatus.dataset.tone = kind;
    else delete els.micStatus.dataset.tone;
}

let announceTimer = 0;
function announce(text) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { els.announcer.textContent = text; }, 400);
}

// ---------------------------------------------------------------- setup

function buildKeys() {
    const frag = document.createDocumentFragment();
    NOTES.forEach((note, i) => {
        const key = document.createElement('button');
        key.type = 'button';
        key.className = 'key';
        key.style.setProperty('--note', note.color);
        key.setAttribute('aria-pressed', 'false');
        key.setAttribute('aria-label', `${note.name}, ${note.swara}: ${note.label}`);
        key.innerHTML = `
            <span class="key-hint" aria-hidden="true">${i + 1}</span>
            <span class="key-voice" aria-hidden="true"></span>
            <svg class="key-shape" viewBox="0 0 40 40" aria-hidden="true">${shapeSvg(note)}</svg>
            <span class="key-name">${note.name}</span>
            <span class="key-swara">${note.swara}</span>
            <span class="key-label">${note.label}</span>`;
        key.addEventListener('click', () => toggleNote(i));
        frag.appendChild(key);
    });
    els.keys.appendChild(frag);
}

function toggleNote(index) {
    if (index === tone.index && tone.scaleTimer === null) stopTone();
    else startTone(index);
}

function toggleListening() {
    if (mic.analyser) stopListening();
    else startListening();
}

function syncRangeFill(input) {
    const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
}

function bindControls() {
    els.waveform.querySelector(`input[value="${settings.waveform}"]`).checked = true;
    els.waveform.addEventListener('change', e => {
        settings.waveform = e.target.value;
        saveSettings();
        if (tone.index >= 0) startTone(tone.index, true); // crossfade to the new sound
    });

    els.volume.value = settings.volume;
    els.volumeValue.textContent = `${Math.round(settings.volume * 100)}%`;
    syncRangeFill(els.volume);
    els.volume.addEventListener('input', () => {
        settings.volume = parseFloat(els.volume.value);
        els.volumeValue.textContent = `${Math.round(settings.volume * 100)}%`;
        syncRangeFill(els.volume);
        if (audio.master) audio.master.gain.setTargetAtTime(volumeToGain(settings.volume), audio.ctx.currentTime, 0.02);
        saveSettings();
    });

    els.optOctave.checked = settings.anyOctave;
    els.optOctave.addEventListener('change', () => {
        settings.anyOctave = els.optOctave.checked;
        voice.octaveOffset = 0;
        saveSettings();
    });

    els.optEcho.checked = settings.echoCancel;
    els.optEcho.addEventListener('change', async () => {
        settings.echoCancel = els.optEcho.checked;
        saveSettings();
        if (mic.analyser) {
            // Echo cancellation is fixed when the stream opens, so reopen it.
            stopListening();
            await startListening();
        } else {
            renderMicStatus();
        }
    });

    els.noteLength.value = settings.noteLength;
    renderNoteLength();
    els.noteLength.addEventListener('input', () => {
        settings.noteLength = parseFloat(els.noteLength.value);
        renderNoteLength();
        // The sounding note gets the new length too.
        if (tone.scaleTimer !== null && tone.scaleTimer !== SCALE_STARTING) scheduleScaleStep();
        saveSettings();
    });

    els.optLoop.checked = settings.loop;
    els.optLoop.addEventListener('change', () => {
        settings.loop = els.optLoop.checked;
        saveSettings();
    });

    els.optSensitivity.value = settings.sensitivity;
    syncRangeFill(els.optSensitivity);
    els.optSensitivity.addEventListener('input', () => {
        settings.sensitivity = parseFloat(els.optSensitivity.value);
        syncRangeFill(els.optSensitivity);
        if (mic.tracker) mic.tracker.setSensitivity(settings.sensitivity);
        saveSettings();
    });

    els.micBtn.addEventListener('click', toggleListening);
    els.scaleBtn.addEventListener('click', playScale);
    els.stopBtn.addEventListener('click', stopAll);

    document.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
        if (e.target.closest('input[type="text"], textarea, [contenteditable="true"]')) return;
        const key = e.key.toLowerCase();
        if (key in KEY_TO_NOTE) {
            toggleNote(KEY_TO_NOTE[key]);
        } else if (key === 'escape') {
            stopAll();
        } else if (key === ' ' && e.target === document.body) {
            e.preventDefault();
            stopAll();
        } else if (key === 'm') {
            toggleListening();
        } else if (key === 'p') {
            playScale();
        } else if (key === 'l') {
            els.optLoop.click();
        }
    });
}

function init() {
    buildKeys();
    bindControls();
    renderMicButton();
    renderScaleButton();

    const refit = () => {
        fitView(views.stage);
        fitView(views.trace);
        requestFrame();
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(els.shapeCanvas);
    observer.observe(els.traceCanvas);
    if (document.fonts) document.fonts.ready.then(requestFrame);
}

// ---------------------------------------------------------------- helpers

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(rgb, a) {
    return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a})`;
}

init();
