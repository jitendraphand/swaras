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
const SCALE_STEP_MS = 850;
const DRAW_IN_SECONDS = 0.7;   // how long a played note takes to draw its shape
const HOLD_TO_DRAW = 1.0;      // seconds of in-tune singing that completes a shape
const IN_TUNE_CENTS = 15;
const CLOSE_CENTS = 30;
const GAP_BRIDGE = 0.16;       // trace breaks shorter than this (s) are joined up
const ANALYSIS_INTERVAL = 0.014; // s; caps pitch analysis near 60 Hz on 120/144 Hz screens
const IDLE_SUSPEND_MS = 30000; // release the audio hardware after this long with nothing playing
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
    drawnCount: $('drawnCount'),
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
    scaleBtn: $('scaleBtn'),
    stopBtn: $('stopBtn'),
    announcer: $('announcer')
};

const audio = { ctx: null, master: null, voice: null, idleTimer: 0 };
const tone = { index: -1, startedAt: 0, token: 0, scaleTimer: null };
const mic = { stream: null, nodes: [], analyser: null, buffer: null, tracker: null, starting: false, echo: false, analysedAt: -Infinity };
const voice = { result: null, display: null, octaveOffset: 0, lastFreshAt: -Infinity, label: '', labelAt: -Infinity };
const trace = { points: [], bars: [], hasContent: false };
const stage = { index: -1, lastIndex: -1, progress: 0, locked: false, cents: null, sungIndex: -1, notice: '', noticeUntil: 0, drawnKey: '' };
const drawn = new Set(); // notes whose shape has been drawn by voice this session
const views = { stage: makeView(els.shapeCanvas), trace: makeView(els.traceCanvas) };

// ---------------------------------------------------------------- settings

function loadSettings() {
    const defaults = { waveform: 'sine', volume: 0.6, anyOctave: true, echoCancel: false, sensitivity: 0.5 };
    try {
        const saved = JSON.parse(localStorage.getItem('swaras.settings')) || {};
        if (saved.waveform in WAVE_LEVEL) defaults.waveform = saved.waveform;
        if (typeof saved.anyOctave === 'boolean') defaults.anyOctave = saved.anyOctave;
        if (typeof saved.echoCancel === 'boolean') defaults.echoCancel = saved.echoCancel;
        if (Number.isFinite(saved.volume)) defaults.volume = clamp(saved.volume, 0, 1);
        if (Number.isFinite(saved.sensitivity)) defaults.sensitivity = clamp(saved.sensitivity, 0, 1);
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
    clearTimeout(audio.idleTimer);
    if (audio.ctx.state !== 'running') {
        try {
            await audio.ctx.resume();
        } catch (err) {
            console.warn('Could not resume audio:', err);
        }
    }
    return audio.ctx;
}

// A running AudioContext keeps the audio hardware awake even when silent, so
// let it sleep once nothing has played for a while. ensureAudio() wakes it.
function scheduleIdleSuspend() {
    clearTimeout(audio.idleTimer);
    if (!audio.ctx) return;
    audio.idleTimer = setTimeout(() => {
        if (audio.voice || mic.analyser || mic.starting || audio.ctx.state !== 'running') return;
        audio.ctx.suspend().catch(() => {});
    }, IDLE_SUSPEND_MS);
}

// The browser can pause audio on its own (phone call, tab put to sleep). If
// something should be sounding or listening, the next gesture wakes it.
function reviveAudio() {
    if (!audio.ctx || audio.ctx.state === 'running' || audio.ctx.state === 'closed') return;
    if (audio.voice || mic.analyser) audio.ctx.resume().catch(() => {});
}

function showNotice(text) {
    stage.notice = text;
    stage.noticeUntil = clock() + 4;
    requestFrame();
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
        stopScale();
        showNotice(err.message);
        return;
    }
    if (token !== tone.token) return; // stopped or replaced while audio was starting
    if (ctx.state !== 'running') {
        stopAll(); // don't leave a silent scale running or a key lit
        showNotice('Sound is blocked — tap a note again to enable it.');
        return;
    }
    stage.notice = '';

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
    // cancelAndHoldAtTime freezes the attack ramp where it is; reading .value
    // mid-ramp isn't reliable everywhere and would click.
    if (v.gain.gain.cancelAndHoldAtTime) {
        v.gain.gain.cancelAndHoldAtTime(now);
    } else {
        v.gain.gain.cancelScheduledValues(now);
        v.gain.gain.setValueAtTime(v.gain.gain.value, now);
    }
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
    scheduleIdleSuspend();
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

function playScale() {
    if (tone.scaleTimer !== null) {
        stopAll();
        return;
    }
    let i = 0;
    const step = () => {
        if (i < NOTES.length) {
            startTone(i++, true);
            tone.scaleTimer = setTimeout(step, SCALE_STEP_MS);
        } else {
            tone.scaleTimer = null;
            stopTone();
            renderScaleButton();
        }
    };
    step();
    renderScaleButton();
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
    const echo = settings.echoCancel;
    try {
        const ctx = await ensureAudio();
        // The browser's voice-call processing is built for speech: noise
        // suppression treats a held note as noise and fades it out, and auto
        // gain pumps the level. Both made detection drop out, so turn them off
        // and do our own noise handling instead.
        stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: echo,
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
        mic.echo = echo;
        mic.analysedAt = -Infinity;
        mic.nodes = [source, highpass, lowpass, analyser, sink];
        mic.analyser = analyser;
        mic.buffer = new Float32Array(analyser.fftSize);
        mic.tracker = new PitchTracker(ctx.sampleRate, { sensitivity: settings.sensitivity });
        voice.octaveOffset = 0;
        stream.getAudioTracks().forEach(track => {
            track.addEventListener('ended', () => {
                // Ignore a stream that has already been replaced or closed.
                if (mic.stream === stream) stopListening('The microphone was disconnected.');
            });
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
    // "Echo cancel" was flipped while the permission prompt was open.
    if (mic.analyser && mic.echo !== settings.echoCancel) await restartListening();
}

function restartListening() {
    stopListening();
    return startListening();
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
    els.meterFill.style.transform = 'scaleX(0)';
    shown.meterLevel = shown.meterGate = shown.meterOpen = undefined;
    renderMicButton();
    scheduleIdleSuspend();
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
    // One analysis per ~60 Hz frame is plenty; faster screens would only
    // re-analyse nearly the same samples and change how the smoothing behaves.
    if (now - mic.analysedAt < ANALYSIS_INTERVAL) return;
    mic.analysedAt = now;
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

    // Transforms, and only when the value moved: no layout work per frame.
    const level = Math.round(levelFraction(r.levelDb) * 100) / 100;
    const gate = Math.round(levelFraction(r.gateDb) * 100);
    if (shown.meterOpen !== r.voiced) {
        shown.meterOpen = r.voiced;
        els.meter.classList.add('is-live');
        els.meter.classList.toggle('is-open', r.voiced);
    }
    if (shown.meterLevel !== level) {
        shown.meterLevel = level;
        els.meterFill.style.transform = `scaleX(${level})`;
    }
    if (shown.meterGate !== gate) {
        shown.meterGate = gate;
        els.meterGate.style.left = `${gate}%`;
    }
}

function levelFraction(db) {
    return clamp((db + 80) / 70, 0, 1);
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
let idleAt = null; // while nothing is live the graph is frozen at this time

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

    const live = !!mic.analyser || tone.index >= 0;
    if (live) {
        idleAt = null;
        if (mic.analyser) analyseMic(now);
        pruneTrace(now);
    } else if (idleAt === null) {
        idleAt = now;
    }
    updateStage(now, dt);
    render(now);

    if (live) requestFrame();
    else {
        lastTick = 0;
        // Come back once to clear a temporary notice.
        if (stage.notice) setTimeout(requestFrame, Math.max(0, stage.noticeUntil - clock()) * 1000 + 30);
    }
}

// Redraws that happen while idle (resize, fonts arriving) keep the graph where
// it stopped instead of scrolling the history away.
function render(now) {
    if (stage.notice && clock() >= stage.noticeUntil) stage.notice = '';
    const viewNow = idleAt === null ? now : idleAt;
    drawStage(viewNow);
    drawTrace(viewNow);
    renderReadouts(viewNow);
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
        if (singing) {
            announce(`${NOTES[index].name} held in tune`);
            markDrawn(index);
        }
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
    return { canvas, ctx: canvas.getContext('2d'), width: 0, height: 0, dpr: 0 };
}

function fitView(view) {
    const rect = view.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    // Assigning canvas.width clears it, so only do that for a real change.
    if (width === view.width && height === view.height && dpr === view.dpr) return false;
    view.width = width;
    view.height = height;
    view.dpr = dpr;
    view.canvas.width = Math.round(width * dpr);
    view.canvas.height = Math.round(height * dpr);
    view.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
}

function drawStage(now) {
    const { ctx, width: w, height: h, dpr } = views.stage;
    const pulsing = stage.locked && stage.index >= 0 && !reducedMotion.matches;
    // While listening the stage is usually static: skip identical redraws.
    const key = pulsing ? '' : `${w}x${h}@${dpr}|${stage.index}|${stage.lastIndex}|${stage.progress}|${stage.locked}`;
    if (key && key === stage.drawnKey) return;
    stage.drawnKey = key;
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
    const pulse = pulsing ? 0.5 + 0.5 * Math.sin(now * 4) : 0;

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
        drawHeadLabel(ctx, last, now, hx, hy, top, rgb);
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

// A small tag beside the live point: the note you're on and how far off it is,
// so you can read your tuning without looking away from the graph.
function drawHeadLabel(ctx, point, now, hx, hy, top, rgb) {
    if (now - voice.labelAt > 0.12 || !voice.label) {
        voice.labelAt = now;
        if (point.c >= 0) {
            const cents = Math.round((point.m - NOTES[point.c].midi) * 100);
            const off = Math.abs(cents) <= IN_TUNE_CENTS ? '' : ` ${cents > 0 ? '+' : '−'}${Math.abs(cents)}¢`;
            voice.label = `${NOTES[point.c].swara}${off}`;
        } else {
            voice.label = point.m > GRAPH.high ? 'too high' : point.m < GRAPH.low ? 'too low' : 'between notes';
        }
    }
    ctx.font = `700 11.5px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = Math.ceil(ctx.measureText(voice.label).width) + 16;
    const th = 22;
    const bx = hx - 16 - tw;
    const by = hy - th - 10 < top - 8 ? hy + 10 : hy - th - 10; // flip below near the top edge
    roundRect(ctx, bx, by, tw, th, 8);
    ctx.fillStyle = 'rgba(9, 13, 25, 0.9)';
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgba(rgb, 0.7);
    ctx.stroke();
    ctx.fillStyle = rgba(rgb, 1);
    ctx.fillText(voice.label, bx + tw / 2, by + th / 2 + 0.5);
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
        if (stage.notice) {
            detail = stage.notice;
        } else if (singing && note) {
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
        const offset = clamp(cents, -50, 50);
        if (shown.needle !== offset) {
            shown.needle = offset;
            // The needle element spans the scale, so ±50% is either end.
            els.tunerNeedle.style.transform = `translateX(${offset}%)`;
        }
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

    if (shown.traceEmpty !== !trace.hasContent) {
        shown.traceEmpty = !trace.hasContent;
        els.traceEmpty.hidden = trace.hasContent;
    }
}

function markDrawn(index) {
    if (drawn.has(index)) return;
    drawn.add(index);
    const note = NOTES[index];
    const key = els.keys.children[index];
    key.classList.add('is-drawn');
    key.setAttribute('aria-label', `${note.name}, ${note.swara}: ${note.label} (drawn)`);
    els.drawnCount.hidden = false;
    els.drawnCount.textContent = drawn.size === NOTES.length
        ? 'All eight shapes drawn with your voice'
        : `${drawn.size} of ${NOTES.length} shapes drawn with your voice`;
    els.drawnCount.classList.toggle('is-complete', drawn.size === NOTES.length);
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
    if (shown.scaleRunning === running) return;
    shown.scaleRunning = running;
    els.scaleBtn.setAttribute('aria-pressed', String(running));
    els.scaleBtn.querySelector('.btn-label').textContent = running ? 'Stop scale' : 'Play scale';
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
            await restartListening();
        } else {
            renderMicStatus();
        }
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

    document.addEventListener('pointerdown', reviveAudio, { passive: true });
    document.addEventListener('keydown', reviveAudio);

    document.addEventListener('keydown', e => {
        if (e.ctrlKey || e.metaKey || e.altKey || e.repeat || !e.key) return;
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
        }
    });
}

function init() {
    buildKeys();
    bindControls();
    renderMicButton();
    renderScaleButton();

    // Redraw in the same frame as the resize: a resized canvas is blank, and
    // waiting for the next animation frame shows that as a flicker.
    const refit = () => {
        const a = fitView(views.stage);
        const b = fitView(views.trace);
        if (a || b) render(clock());
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(els.shapeCanvas);
    observer.observe(els.traceCanvas);
    // Moving to a screen with another pixel density, or zooming, changes the
    // resolution the canvases need without changing their CSS size.
    const watchDensity = () => {
        window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
            .addEventListener('change', () => { refit(); watchDensity(); }, { once: true });
    };
    watchDensity();
    if (document.fonts) document.fonts.ready.then(() => { stage.drawnKey = ''; render(clock()); });
    requestFrame();
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
