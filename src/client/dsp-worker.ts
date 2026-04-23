import init, { DspProcessor, set_panic_hook, alloc_iq_buffer, free_iq_buffer } from "/hackrf-web/pkg/hackrf_web.js";
import { RationalResampler } from './worker/dsp-pipeline';

// --- Worker State ---
let wasmInitPromise: Promise<void> | null = null;
let _wasm: any;
let ddc: any;
let ismDdc: any;
let vfoState: any;
let sharedIqPtr = 0;
let sharedSabViews: Int8Array[] | null = null;

const IF_RATES: Record<string, number> = {
    nfm: 50000,
    wfm: 250000,
    am: 15000,
    usb: 24000,
    lsb: 24000,
    dsb: 24000,
    cw: 3000,
    raw: 48000,
};
const AUDIO_RATE = 48000;
const ISM_SCAN_IF_RATE = 1024000;
const ISM_SCAN_BANDWIDTH_HZ = 1600000;

interface ProcessOutput {
    audio: Float32Array | null;
    ism: Float32Array | null;
    ismSampleRate: number;
}

async function startup(): Promise<void> {
    if (!wasmInitPromise) {
        wasmInitPromise = init().then((w: any) => {
            _wasm = w;
            set_panic_hook();

            // Allocate Wasm memory for this sub-module
            const MAX_USB_SAMPLES = 131072;
            sharedIqPtr = alloc_iq_buffer(MAX_USB_SAMPLES * 2);
            console.log("DSP Worker: Wasm Initialized. IQ Buffer Ptr:", sharedIqPtr);
        }).catch((err: any) => {
            console.error("DSP Worker: Wasm Init Failed:", err);
        });
    }
    await wasmInitPromise;
}

let systemSampleRate = 2000000;

self.onmessage = async (e: MessageEvent) => {
    const msg = e.data;
    await startup();

    if (msg.type === "init") {
        systemSampleRate = msg.sampleRate;
        // Initialize the DDC and VFO state
        if (ddc) {
            ddc.free();
        }
        if (ismDdc) {
            ismDdc.free();
            ismDdc = null;
        }
        ddc = new DspProcessor(msg.sampleRate, 0.0, msg.params.bandwidth || 150000);

        vfoState = {
            dcAvg: 0,
            carrierAgcGain: 1.0,
            deemphPrev: 0,
            agcGain: 1.0,
            ssbPhase: 0.0,
            audioResampler: null as RationalResampler | null,
            currentIfRate: 0,
            scratchBuf: new Float32Array(512),
            audioTarget: new Float32Array(2048),
            squelchOpen: false,
        };
        sharedSabViews = msg.sabs ? msg.sabs.map((s: SharedArrayBuffer) => new Int8Array(s)) : null;

        configureDDC(msg.params, msg.centerFreq);

        self.postMessage({ type: "init_done" });
    }
    else if (msg.type === "configure") {
        configureDDC(msg.params, msg.centerFreq);
        self.postMessage({ type: "config_done" });
    }
    else if (msg.type === "process") {
        if (!ddc || !vfoState) {
            console.log("DSP Worker: ddc/vfoState unavailable");
            return;
        }

        // Copy payload into WASM memory
        const wasmMemView = new Int8Array(_wasm.memory.buffer);

        if (msg.useSab && sharedSabViews && msg.sabIndex !== undefined) {
            // Zero-copy grab from SAB ring!
            wasmMemView.set(sharedSabViews[msg.sabIndex].subarray(0, msg.chunkLen), sharedIqPtr);
        } else if (msg.chunk) {
            // Direct copy from received buffer
            wasmMemView.set(new Int8Array(msg.chunk), sharedIqPtr);
        } else {
            return; // Invalid chunk
        }

        try {
            const processStart = performance.now();
            const output = processVfoAudio(msg.chunkLen, msg.params);
            const processEnd = performance.now();
            const dspTime = processEnd - processStart;
            const transfer: ArrayBuffer[] = [];
            const payload: any = {
                type: "audio",
                samples: null,
                ismSamples: null,
                ismSampleRate: output.ismSampleRate,
                chunkId: msg.chunkId,
                squelchOpen: vfoState.squelchOpen,
                squelchDb: vfoState.squelchDb ?? -120,
                dspTime: dspTime
            };

            if (output.audio) {
                const cloneOut = output.audio.slice();
                payload.samples = cloneOut.buffer;
                transfer.push(cloneOut.buffer);
            }
            if (output.ism) {
                const cloneIsm = output.ism.slice();
                payload.ismSamples = cloneIsm.buffer;
                transfer.push(cloneIsm.buffer);
            }

            if (transfer.length > 0) (self as any).postMessage(payload, transfer);
            else self.postMessage(payload);
        } catch (err: any) {
            self.postMessage({ type: "error", error: err.message });
        }
    }
};

function configureDDC(params: any, systemCenterFreq: number): void {
    const sniffWide = params.mode === 'nfm' && !!params.ism;
    const ifRate = IF_RATES[params.mode];
    if (ifRate === undefined) {
        console.error(`[DSP Worker] Unknown mode "${params.mode}" — no IF rate defined. Skipping DDC config.`);
        return;
    }
    if (vfoState.currentIfRate !== ifRate) {
        vfoState.audioResampler = new RationalResampler(ifRate, AUDIO_RATE);
        vfoState.currentIfRate = ifRate;
        ddc.set_if_sample_rate(ifRate);
    }

    const offsetFreq = (params.freq - systemCenterFreq) * 1e6;
    const effectiveBandwidth = params.bandwidth || 150000;
    ddc.set_shift(systemSampleRate, offsetFreq);
    ddc.set_bandwidth(effectiveBandwidth);
    ddc.set_squelch(params.squelchLevel, params.squelchEnabled);
    if (params.mode === 'wfm') {
        ddc.set_wfm_mode(true);
    } else {
        ddc.set_wfm_mode(false);
    }

    // Apply UI audio filters (High Pass 300Hz, Low Pass BW/2)
    ddc.set_audio_filters(params.lowPass || false, params.highPass || false);

    if (sniffWide) {
        if (!ismDdc) {
            ismDdc = new DspProcessor(systemSampleRate, 0.0, ISM_SCAN_BANDWIDTH_HZ);
        }
        const ismIfRate = Math.min(systemSampleRate, ISM_SCAN_IF_RATE);
        const ismBandwidth = Math.min(ISM_SCAN_BANDWIDTH_HZ, Math.max(300000, Math.floor(systemSampleRate * 0.88)));
        ismDdc.set_if_sample_rate(ismIfRate);
        ismDdc.set_shift(systemSampleRate, 0);
        ismDdc.set_bandwidth(ismBandwidth);
        ismDdc.set_squelch(-140, false);
        ismDdc.set_wfm_mode(false);
        ismDdc.set_audio_filters(false, false);
    } else if (ismDdc) {
        ismDdc.free();
        ismDdc = null;
    }
}

function processIsmWideEnvelope(chunkLenBytes: number): { ism: Float32Array | null; ismSampleRate: number } {
    if (!ismDdc) return { ism: null, ismSampleRate: AUDIO_RATE };

    const outPtr = ismDdc.process_iq_only_ptr(sharedIqPtr, chunkLenBytes);
    const numOutValues = ismDdc.get_iq_output_len();
    const numIqSamples = numOutValues / 2;
    if (numIqSamples === 0) return { ism: null, ismSampleRate: AUDIO_RATE };

    const iq = new Float32Array(_wasm.memory.buffer, outPtr, numOutValues);
    const ifRate = Math.min(systemSampleRate, ISM_SCAN_IF_RATE);
    const env = new Float32Array(numIqSamples);

    const dcAlpha = Math.exp(-1.0 / Math.max(1, ifRate * 0.020));
    const dcBeta = 1.0 - dcAlpha;
    const agcAttack = Math.min(0.12, 320.0 / ifRate);
    const agcDecay = Math.min(0.012, 18.0 / ifRate);

    let dc = vfoState.dcAvg || 0;
    let agc = Math.max(vfoState.agcGain || 0.02, 1e-6);

    for (let i = 0; i < numIqSamples; i++) {
        const dI = iq[i * 2];
        const dQ = iq[i * 2 + 1];
        const mag = Math.sqrt(dI * dI + dQ * dQ);
        dc = dcAlpha * dc + dcBeta * mag;
        let e = mag - dc;
        if (e < 0) e = 0;
        if (e > agc) agc += (e - agc) * agcAttack;
        else agc += (e - agc) * agcDecay;
        let n = e / (agc * 2.0 + 1e-9);
        if (n > 1.0) n = 1.0;
        env[i] = n;
    }

    vfoState.dcAvg = dc;
    vfoState.agcGain = agc;
    return { ism: env, ismSampleRate: ifRate };
}

function processVfoAudio(chunkLenBytes: number, params: any): ProcessOutput {
    const mode = params.mode;
    const bw = params.bandwidth;
    const empty: ProcessOutput = { audio: null, ism: null, ismSampleRate: AUDIO_RATE };

    if (mode === 'nfm' || mode === 'wfm') {
        let outPtr: number;
        try {
            outPtr = ddc.process_ptr(sharedIqPtr, chunkLenBytes);
        } catch (e) {
            console.error("DEBUG process_ptr crashed:", e);
            throw e;
        }

        const numAudioSamples = ddc.get_output_len();

        let isSquelched = false;
        if (params.squelchEnabled && numAudioSamples > 0) {
            isSquelched = (ddc.get_output_len() > 0 && new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples)[Math.floor(numAudioSamples / 2)] === 0.0);
        }
        vfoState.squelchOpen = !isSquelched;
        vfoState.squelchDb = ddc.get_squelch_db();

        if (numAudioSamples === 0) return empty;

        const result = new Float32Array(_wasm.memory.buffer, outPtr, numAudioSamples);

        // De-emphasis
        if (params.deEmphasis !== 'none') {
            let tau = 0;
            if (params.deEmphasis === '22us') tau = 22e-6;
            else if (params.deEmphasis === '50us') tau = 50e-6;
            else if (params.deEmphasis === '75us') tau = 75e-6;

            const alpha = 1.0 / (1.0 + tau * AUDIO_RATE);
            const oneMinusAlpha = 1.0 - alpha;

            let prev = vfoState.deemphPrev;
            for (let i = 0; i < numAudioSamples; i++) {
                prev = alpha * result[i] + oneMinusAlpha * prev;
                result[i] = prev < -1.0 ? -1.0 : prev > 1.0 ? 1.0 : prev;
            }
            vfoState.deemphPrev = prev;
        } else {
            for (let i = 0; i < numAudioSamples; i++) {
                if (result[i] > 1.0) result[i] = 1.0;
                else if (result[i] < -1.0) result[i] = -1.0;
            }
        }

        if (numAudioSamples > vfoState.audioTarget.length) {
            vfoState.audioTarget = new Float32Array(numAudioSamples + 1024);
        }
        const outView = vfoState.audioTarget.subarray(0, numAudioSamples);
        outView.set(result);
        const ism = mode === 'nfm' && !!params.ism ? processIsmWideEnvelope(chunkLenBytes) : { ism: null, ismSampleRate: AUDIO_RATE };
        return { audio: outView, ism: ism.ism, ismSampleRate: ism.ismSampleRate };
    } else {
        // Non-FM Path
        const outPtr = ddc.process_iq_only_ptr(sharedIqPtr, chunkLenBytes);
        const numOutValues = ddc.get_iq_output_len();
        const numDemodSamples = numOutValues / 2;
        if (numDemodSamples === 0) return empty;

        const _ddcOut = new Float32Array(_wasm.memory.buffer, outPtr, numOutValues);

        let squelchMag = 0;
        for (let i = 0; i < numDemodSamples; i++) {
            const dI = _ddcOut[i * 2];
            const dQ = _ddcOut[i * 2 + 1];
            squelchMag += Math.sqrt(dI * dI + dQ * dQ);
        }
        squelchMag /= numDemodSamples;
        const squelchDb = 10 * Math.log10(squelchMag + 1e-12);
        vfoState.squelchDb = squelchDb;

        if (numDemodSamples > vfoState.scratchBuf.length) {
            vfoState.scratchBuf = new Float32Array(numDemodSamples + 128);
        }
        const audioDemodRateSamples = vfoState.scratchBuf.subarray(0, numDemodSamples);

        if (params.squelchEnabled && squelchDb < params.squelchLevel) {
            vfoState.squelchOpen = false;
            audioDemodRateSamples.fill(0);
            const result = vfoState.audioResampler.process(audioDemodRateSamples);
            return { audio: result.length > 0 ? result : null, ism: null, ismSampleRate: AUDIO_RATE };
        }

        vfoState.squelchOpen = params.squelchEnabled && squelchDb >= params.squelchLevel;
        const ifRate = vfoState.currentIfRate;

        if (mode === 'am') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                const mag = Math.sqrt(dI * dI + dQ * dQ);
                const dcAlpha = 0.9999;
                vfoState.dcAvg = dcAlpha * vfoState.dcAvg + (1 - dcAlpha) * mag;
                const demodSample = mag - vfoState.dcAvg;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > vfoState.agcGain) {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'usb' || mode === 'lsb' || mode === 'dsb') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                let shiftFreq = 0;
                if (mode === 'usb') shiftFreq = bw / 2.0;
                else if (mode === 'lsb') shiftFreq = -bw / 2.0;
                const phaseInc = (shiftFreq / ifRate) * 2 * Math.PI;
                vfoState.ssbPhase += phaseInc;
                if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
                if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
                const cosP = Math.cos(vfoState.ssbPhase);
                const sinP = Math.sin(vfoState.ssbPhase);
                const rI = dI * cosP - dQ * sinP;
                const demodSample = rI;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > vfoState.agcGain) {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'cw') {
            for (let i = 0; i < numDemodSamples; i++) {
                const dI = _ddcOut[i * 2];
                const dQ = _ddcOut[i * 2 + 1];
                const cwTone = 700;
                const phaseInc = (cwTone / ifRate) * 2 * Math.PI;
                vfoState.ssbPhase += phaseInc;
                if (vfoState.ssbPhase > Math.PI) vfoState.ssbPhase -= 2 * Math.PI;
                if (vfoState.ssbPhase < -Math.PI) vfoState.ssbPhase += 2 * Math.PI;
                const cosP = Math.cos(vfoState.ssbPhase);
                const sinP = Math.sin(vfoState.ssbPhase);
                const rI = dI * cosP - dQ * sinP;
                const demodSample = rI;
                const agcAttack = 50.0 / ifRate;
                const agcDecay = 5.0 / ifRate;
                const absSample = Math.abs(demodSample);
                if (absSample > vfoState.agcGain) {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcAttack) + absSample * agcAttack;
                } else {
                    vfoState.agcGain = vfoState.agcGain * (1 - agcDecay) + absSample * agcDecay;
                }
                const agcScale = vfoState.agcGain > 1e-6 ? (0.5 / vfoState.agcGain) : 1.0;
                audioDemodRateSamples[i] = demodSample * agcScale;
            }
        }
        else if (mode === 'raw') {
            for (let i = 0; i < numDemodSamples; i++) {
                audioDemodRateSamples[i] = _ddcOut[i * 2];
            }
        }
        else {
            audioDemodRateSamples.fill(0);
        }

        const result = vfoState.audioResampler.process(audioDemodRateSamples);
        if (result.length === 0) return empty;

        for (let i = 0; i < result.length; i++) {
            if (result[i] > 1.0) result[i] = 1.0;
            else if (result[i] < -1.0) result[i] = -1.0;
        }

        return { audio: result.slice(), ism: null, ismSampleRate: AUDIO_RATE };
    }
}
