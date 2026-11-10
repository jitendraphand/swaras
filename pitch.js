/*
 * Swaras pitch tracking.
 *
 * `mcleodPitch` estimates the fundamental of one frame with the McLeod Pitch
 * Method (normalised square difference function). Besides a frequency it
 * returns a `clarity` score (0–1) that says how periodic the frame is: sung
 * or played notes score ~0.9+, background noise scores low. That score is
 * what lets us ignore noise instead of relying on loudness alone.
 *
 * `PitchTracker` wraps it for live use: an adaptive noise gate (tracks the
 * room's noise floor), onset/hold logic so short dropouts don't blank the
 * display, and median + exponential smoothing so the reading is steady.
 *
 * Loaded as a plain <script> (exposes window.SwarasPitch) and from Node for tests.
 */
(function (root) {
    'use strict';

    const A4 = 440;
    const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

    function freqToMidi(freq) { return 69 + 12 * Math.log2(freq / A4); }
    function midiToFreq(midi) { return A4 * Math.pow(2, (midi - 69) / 12); }
    function midiToName(midi) {
        const n = Math.round(midi);
        return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
    }

    function rmsDb(buf) {
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        return 10 * Math.log10(sum / buf.length + 1e-12);
    }

    /**
     * McLeod Pitch Method. Returns { freq, clarity } or null when no usable
     * periodicity is found. `nsdf` is a scratch Float32Array (length > maxLag)
     * reused between calls so the hot loop doesn't allocate. Removes the DC
     * offset from `buf` in place.
     */
    function mcleodPitch(buf, sampleRate, minFreq, maxFreq, nsdf) {
        const n = buf.length;
        const maxLag = Math.min(Math.floor(sampleRate / minFreq), Math.floor(n / 2), nsdf.length - 2);
        const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));

        let mean = 0;
        for (let i = 0; i < n; i++) mean += buf[i];
        mean /= n;
        let m = 0;
        for (let i = 0; i < n; i++) {
            buf[i] -= mean;
            m += buf[i] * buf[i];
        }
        m *= 2;
        if (m <= 0) return null;

        // n'(tau) = 2 r'(tau) / m'(tau); m' is updated incrementally, r' is only
        // computed up to the longest period we care about.
        for (let tau = 0; tau <= maxLag; tau++) {
            let acf = 0;
            for (let j = 0, end = n - tau; j < end; j++) acf += buf[j] * buf[j + tau];
            nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
            m -= buf[tau] * buf[tau] + buf[n - 1 - tau] * buf[n - 1 - tau];
        }

        // Key maxima: the highest point of each positive lobe after the first
        // negative-going zero crossing.
        let pos = 0;
        while (pos < maxLag && nsdf[pos] > 0) pos++;
        const firstLobe = pos;
        let highest = 0;
        while (pos < maxLag) {
            while (pos < maxLag && nsdf[pos] <= 0) pos++;
            let peak = pos;
            while (pos < maxLag && nsdf[pos] > 0) {
                if (nsdf[pos] > nsdf[peak]) peak = pos;
                pos++;
            }
            if (peak >= minLag && peak < maxLag && nsdf[peak] >= nsdf[peak + 1] && nsdf[peak] > highest) highest = nsdf[peak];
        }
        if (highest < 0.3) return null;

        // The first peak close to the highest one is the fundamental; later
        // ones are multiples of the period (octave errors). Second scan
        // instead of a list of peaks, so nothing is allocated per frame.
        const threshold = 0.9 * highest;
        let best = -1;
        pos = firstLobe;
        while (pos < maxLag && best < 0) {
            while (pos < maxLag && nsdf[pos] <= 0) pos++;
            let peak = pos;
            while (pos < maxLag && nsdf[pos] > 0) {
                if (nsdf[pos] > nsdf[peak]) peak = pos;
                pos++;
            }
            if (peak >= minLag && peak < maxLag && nsdf[peak] >= nsdf[peak + 1] && nsdf[peak] >= threshold) best = peak;
        }
        if (best < 0) return null;

        const a = nsdf[best - 1], b = nsdf[best], c = nsdf[best + 1];
        const denom = a - 2 * b + c;
        const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
        const period = best + shift;
        const clarity = Math.min(1, b - 0.25 * (a - c) * shift);
        return { freq: sampleRate / period, clarity };
    }

    const DEFAULTS = {
        minFreq: 70,        // Hz; below a bass's E2, above 50/60 Hz mains hum
        maxFreq: 1100,      // Hz; soprano C6
        clarityOn: 0.85,    // periodicity needed to start a note
        clarityHold: 0.7,   // ...and to keep one going (hysteresis)
        silenceDb: -70,     // never analyse anything quieter than this
        floorRiseDb: 6,     // dB/s the noise floor may rise while no one sings
        holdTime: 0.15,     // s a note survives a dropout (consonant, breath noise)
        onsetFrames: 2,     // consistent frames needed before a new note shows
        jumpSemitones: 0.75 // larger moves are note changes: snap, don't glide
    };

    class PitchTracker {
        constructor(sampleRate, options = {}) {
            this.sampleRate = sampleRate;
            this.opts = Object.assign({}, DEFAULTS, options);
            // The input is band-limited to the singing range, so analysing it
            // at ~22–24 kHz loses nothing and makes the O(n·lag) search about
            // four times cheaper than at the 44.1/48 kHz capture rate.
            this.decimation = Math.max(1, Math.floor(sampleRate / 22050));
            this.analysisRate = sampleRate / this.decimation;
            this.nsdf = new Float32Array(Math.ceil(this.analysisRate / this.opts.minFreq) + 2);
            this.work = null;
            this.sorted = new Float64Array(5);
            this.setSensitivity(options.sensitivity == null ? 0.5 : options.sensitivity);
            this.reset();
        }

        // 0 = only clear, loud notes get through; 1 = quiet singing too.
        setSensitivity(value) {
            this.sensitivity = Math.min(1, Math.max(0, value));
            this.marginDb = 16 - 12 * this.sensitivity; // dB above the noise floor
        }

        reset() {
            this.floorDb = null;
            this.voiced = false;
            this.history = [];
            this.midi = null;
            this.clarity = 0;
            this.lastVoicedAt = -Infinity;
            this.lastTime = null;
        }

        /**
         * Analyse one frame captured at `time` (seconds). `buf` may be modified.
         * Returns the tracker state: `voiced` is true while a note is showing
         * (including during a short hold); `fresh` is true only when this frame
         * itself measured the pitch.
         */
        process(buf, time) {
            const o = this.opts;
            const dt = this.lastTime == null ? 0 : Math.min(0.25, Math.max(0, time - this.lastTime));
            this.lastTime = time;

            const levelDb = rmsDb(buf);
            if (this.floorDb == null) this.floorDb = Math.min(levelDb, -60);

            // Hysteresis: a note that's already sounding may get a little quieter.
            const gateDb = Math.max(o.silenceDb, this.floorDb + this.marginDb - (this.voiced ? 6 : 0));
            const estimate = levelDb > o.silenceDb ? this.estimate(buf) : null;
            const periodic = !!estimate &&
                estimate.clarity >= (this.voiced ? o.clarityHold : o.clarityOn) &&
                estimate.freq >= o.minFreq && estimate.freq <= o.maxFreq;
            const ok = periodic && levelDb > gateDb;

            if (!periodic) {
                // Learn the background level from frames that aren't a note: drop
                // fast, rise slowly. A held note never raises its own gate.
                if (levelDb < this.floorDb) this.floorDb += (levelDb - this.floorDb) * 0.3;
                else this.floorDb += Math.min(levelDb - this.floorDb, o.floorRiseDb * dt);
            }

            let fresh = false;
            if (ok) {
                const midi = freqToMidi(estimate.freq);
                if (!this.voiced) {
                    const recent = this.history[this.history.length - 1];
                    if (recent === undefined || Math.abs(midi - recent) > o.jumpSemitones) this.history.length = 0;
                }
                this.history.push(midi);
                if (this.history.length > 5) this.history.shift();

                if (this.voiced || this.isConsistentOnset()) {
                    const med = this.medianOfHistory();
                    if (this.midi == null || Math.abs(med - this.midi) > o.jumpSemitones) this.midi = med;
                    else this.midi += (med - this.midi) * 0.5;
                    this.voiced = true;
                    this.clarity = estimate.clarity;
                    this.lastVoicedAt = time;
                    fresh = true;
                }
            } else if (this.voiced && time - this.lastVoicedAt > o.holdTime) {
                this.voiced = false;
                this.midi = null;
                this.history.length = 0;
            } else if (!this.voiced) {
                this.history.length = 0;
            }

            return {
                voiced: this.voiced,
                fresh,
                midi: this.midi,
                freq: this.midi == null ? 0 : midiToFreq(this.midi),
                clarity: this.voiced ? this.clarity : 0,
                levelDb,
                floorDb: this.floorDb,
                gateDb
            };
        }

        estimate(buf) {
            const o = this.opts;
            const d = this.decimation;
            if (d === 1) return mcleodPitch(buf, this.sampleRate, o.minFreq, o.maxFreq, this.nsdf);
            const n = Math.floor(buf.length / d);
            if (!this.work || this.work.length !== n) this.work = new Float32Array(n);
            const work = this.work;
            // Averaging each group of samples is a cheap anti-alias filter.
            for (let i = 0, j = 0; i < n; i++) {
                let sum = 0;
                for (let k = 0; k < d; k++) sum += buf[j++];
                work[i] = sum / d;
            }
            return mcleodPitch(work, this.analysisRate, o.minFreq, o.maxFreq, this.nsdf);
        }

        isConsistentOnset() {
            const h = this.history;
            const n = this.opts.onsetFrames;
            if (h.length < n) return false;
            let lo = Infinity;
            let hi = -Infinity;
            for (let i = h.length - n; i < h.length; i++) {
                if (h[i] < lo) lo = h[i];
                if (h[i] > hi) hi = h[i];
            }
            return hi - lo <= this.opts.jumpSemitones;
        }

        // Insertion sort into a scratch array: no per-frame garbage.
        medianOfHistory() {
            const h = this.history;
            const s = this.sorted;
            const n = h.length;
            for (let i = 0; i < n; i++) {
                let j = i;
                while (j > 0 && s[j - 1] > h[i]) { s[j] = s[j - 1]; j--; }
                s[j] = h[i];
            }
            const mid = n >> 1;
            return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
        }
    }

    const api = { mcleodPitch, PitchTracker, freqToMidi, midiToFreq, midiToName, rmsDb };
    root.SwarasPitch = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
