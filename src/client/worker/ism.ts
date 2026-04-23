import type { ISMMessage } from './types';
import { BitBuffer } from './rtl433-bitbuffer';

interface RunUs {
	level: 0 | 1;
	us: number;
}

interface SymbolParse {
	symbols: string;
	unknown: number;
	totalPairs: number;
}

interface FixedGapDecode {
	row: string;
	repeats: number;
	gapUs: number;
	shortUs: number;
	longUs: number;
	rows: number;
}

interface PpmDecode {
	row: string;
	repeats: number;
	pulseUs: number;
	shortGapUs: number;
	longGapUs: number;
	rows: number;
}

interface ManchesterDecode {
	row: string;
	repeats: number;
	unitUs: number;
	rows: number;
	inverted: boolean;
}

interface DecodedProtocol {
	protocol: string;
	model?: string;
	id?: string;
	raw: string;
	text: string;
	confidence: number;
	repeats?: number;
	pairs?: number;
	unknownRatio?: number;
}

/**
 * ISM pulse sniffer for OOK/ASK-like bursts.
 * Input is FM-demod audio at 48 kHz from the VFO pipeline.
 *
 * This stage is protocol-agnostic on purpose:
 * - adaptive envelope thresholding (noise tracking + hysteresis)
 * - run-length extraction (H/L pulse durations)
 * - burst framing by trailing gap
 * - lightweight fingerprint + deduplication
 */
export class ISMDecoder {
	private readonly minRunSamples: number;
	private readonly endGapSamples: number;
	private readonly maxBurstSamples: number;
	private readonly sampleUs: number;
	private readonly endGapMs: number;
	private readonly maxBurstMs: number;
	private static readonly DUPLICATE_WINDOW_MS = 60;
	private static readonly REPEAT_WINDOW_MS = 1800;

	private _announced = false;
	private _env = 0;
	private _noise = 0.003;
	private _bitState = false;

	private _burstActive = false;
	private _burstSamples = 0;
	private _currentLevel: 0 | 1 = 0;
	private _currentRun = 0;
	private _runs: Array<{ level: 0 | 1; samples: number }> = [];

	private _lastSig = '';
	private _lastSigAtMs = 0;
	private _recent = new Map<string, { count: number; at: number }>();

	constructor(private onMessage: (msg: ISMMessage) => void, sampleRate = 48000) {
		const sr = Math.max(8000, sampleRate | 0);
		this.sampleUs = 1_000_000 / sr;
		this.minRunSamples = Math.max(2, Math.round(sr * 0.000016));
		this.endGapSamples = Math.max(14, Math.round(sr * 0.0024));
		this.maxBurstSamples = Math.max(this.endGapSamples * 2, Math.round(sr * 0.34));
		this.endGapMs = (this.endGapSamples * this.sampleUs) / 1000;
		this.maxBurstMs = (this.maxBurstSamples * this.sampleUs) / 1000;
	}

	process(samples: Float32Array): void {
		if (!samples.length) return;

		if (!this._announced) {
			this.onMessage({
				type: 'status',
				protocol: 'ISM-SNIFFER',
				text: 'ISM pulse sniffer active',
				confidence: 1,
			});
			this._announced = true;
		}

		for (let i = 0; i < samples.length; i++) {
			const s = Math.abs(samples[i]);

			// Fast envelope follower.
			this._env += (s - this._env) * 0.20;

			// Noise floor tracker. When active, track conservatively to avoid
			// riding up on the burst itself, but recover quickly after strong bursts.
			const noiseInput = this._burstActive ? Math.min(this._env, this._noise * 1.12) : this._env;
			const rising = noiseInput > this._noise;
			const noiseAlpha = this._burstActive
				? (rising ? 0.0007 : 0.0032)
				: (rising ? 0.006 : 0.020);
			this._noise += (noiseInput - this._noise) * noiseAlpha;
			if (this._noise < 1e-6) this._noise = 1e-6;

			const bit = this._sliceBit(this._env);
			this._consumeBit(bit);
		}
	}

	reset(): void {
		this._announced = false;
		this._env = 0;
		this._noise = 0.003;
		this._bitState = false;
		this._burstActive = false;
		this._burstSamples = 0;
		this._currentLevel = 0;
		this._currentRun = 0;
		this._runs = [];
		this._lastSig = '';
		this._lastSigAtMs = 0;
		this._recent.clear();
	}

	private _sliceBit(env: number): 0 | 1 {
		const hi = Math.min(Math.max(this._noise * 2.05, 0.0018), 0.16);
		const lo = Math.min(Math.max(this._noise * 1.30, 0.0010), 0.08);

		if (this._bitState) {
			if (env < lo) this._bitState = false;
		} else {
			if (env > hi) this._bitState = true;
		}
		return this._bitState ? 1 : 0;
	}

	private _consumeBit(bit: 0 | 1): void {
		if (!this._burstActive) {
			if (bit === 1) {
				this._burstActive = true;
				this._burstSamples = 1;
				this._currentLevel = 1;
				this._currentRun = 1;
				this._runs.length = 0;
			}
			return;
		}

		this._burstSamples++;
		if (bit === this._currentLevel) {
			this._currentRun++;
		} else {
			if (this._currentRun >= this.minRunSamples) {
				this._runs.push({ level: this._currentLevel, samples: this._currentRun });
			}
			this._currentLevel = bit;
			this._currentRun = 1;
		}

		if (this._currentLevel === 0 && this._currentRun >= this.endGapSamples) {
			this._finalizeBurst();
			return;
		}

		if (this._burstSamples >= this.maxBurstSamples) {
			// No clear end-gap in noisy channels: force-close the burst
			// instead of dropping it silently.
			this._finalizeBurst();
		}
	}

	private _finalizeBurst(): void {
		// Keep only meaningful tail state (exclude long trailing end gap).
		if (this._currentLevel === 1 && this._currentRun >= this.minRunSamples) {
			this._runs.push({ level: 1, samples: this._currentRun });
		}

		if (this._runs.length < 8) {
			this._resetBurst();
			return;
		}

		const runsUs: RunUs[] = this._runs.map((r) => ({
			level: r.level,
			us: r.samples * this.sampleUs,
		}));

		const stats = this._pulseStats(runsUs.map((r) => r.us));
		const shortUs = stats ? stats.shortUs : this._fallbackShortUs(runsUs);
		const longUs = stats ? stats.longUs : shortUs * 3.0;

		const parsed = this._extractSymbols(runsUs, shortUs);
		const signature = this._signature(parsed.symbols);
		if (signature.length < 1) {
			this._resetBurst();
			return;
		}
		const nowMs = performance.now();
		if (signature === this._lastSig && (nowMs - this._lastSigAtMs) < ISMDecoder.DUPLICATE_WINDOW_MS) {
			this._resetBurst();
			return;
		}
		this._lastSig = signature;
		this._lastSigAtMs = nowMs;

		const known = this._decodeKnownProtocols(parsed, shortUs, longUs, runsUs);
		if (known) {
			this.onMessage({
				type: 'burst',
				protocol: known.protocol,
				model: known.model || '',
				id: known.id || '',
				raw: known.raw,
				text: known.text,
				confidence: known.confidence,
				repeats: known.repeats,
				pairs: known.pairs,
				unknownRatio: known.unknownRatio,
			});
		} else {
			const unknownRatio = parsed.unknown / Math.max(parsed.totalPairs, 1);
			const ratio = longUs / Math.max(shortUs, 1);
			const baseConf =
				Math.max(0.1, Math.min(0.90,
					0.40 * Math.min(1, this._runs.length / 42) +
					0.30 * Math.max(0, 1 - Math.abs(ratio - 3.0) / 2.2) +
					0.15 * Math.min(1, this._burstSamples / 5500) +
					0.15 * Math.max(0, 1 - parsed.unknown / Math.max(parsed.totalPairs, 1))
				));
			const raw = this._formatRuns(runsUs, 34);
			const id = this._hash8(signature);
			const burstMs = (this._burstSamples * this.sampleUs) / 1000;
			if (burstMs > this.maxBurstMs * 1.05) {
				this._resetBurst();
				return;
			}

			// Reject pathological "stuck" bursts that are typically broadband noise,
			// local digital hash, or forced-close garbage rather than real framed OOK.
			// The telltale signs are:
			// - burst duration pinned near the hard timeout,
			// - hundreds/thousands of runs,
			// - almost no valid symbol pairs extracted,
			// - ultra-short timings around the slicer floor.
			const timeoutPinned = burstMs >= this.maxBurstMs * 0.95;
			const pathologicalRaw =
				timeoutPinned &&
				this._runs.length >= 400 &&
				parsed.totalPairs <= 4 &&
				shortUs <= 120 &&
				longUs <= 220;
			if (pathologicalRaw) {
				this._resetBurst();
				return;
			}

			// Hard reject pathological junk; for the remaining generic bursts,
			// require either repeat evidence or a convincingly clean frame.
			if (parsed.totalPairs < 1 || unknownRatio > 0.995) {
				this._resetBurst();
				return;
			}
			if (ratio < 1.05 || ratio > 12.0) {
				this._resetBurst();
				return;
			}
			const prev = this._recent.get(id);
			let repeats = 1;
			if (!prev || (nowMs - prev.at) > ISMDecoder.REPEAT_WINDOW_MS) {
				this._recent.set(id, { count: 1, at: nowMs });
			} else {
				prev.count++;
				prev.at = nowMs;
				this._recent.set(id, prev);
				repeats = prev.count;
			}

			const strongGeneric =
				burstMs >= 10 &&
				burstMs <= Math.min(this.maxBurstMs, 220) &&
				shortUs >= 120 &&
				this._runs.length >= 16 &&
				(
					(parsed.totalPairs >= 6 && unknownRatio <= 0.35 && baseConf >= 0.54) ||
					(parsed.totalPairs >= 3 && unknownRatio <= 0.55 && baseConf >= 0.48 && ratio >= 1.4 && ratio <= 7.5)
				);

			// Keep one-shot generic bursts only when they are unusually clean.
			// Strict mode in the UI will still hide most of these.
			if (repeats < 2 && !strongGeneric) {
				this._resetBurst();
				return;
			}
			const pairHint = parsed.totalPairs > 0 ? `pairs=${parsed.totalPairs} unk=${Math.round(unknownRatio * 100)}% ` : '';

			this.onMessage({
				type: 'burst',
				protocol: ratio > 2.0 && ratio < 4.6 ? 'OOK-PWM' : (parsed.totalPairs >= 4 ? 'OOK-PULSE' : 'OOK-RAW'),
				model: '',
				id,
				raw,
				text: `${pairHint}rep=${repeats} runs=${this._runs.length} short=${shortUs.toFixed(0)}us long=${longUs.toFixed(0)}us burst=${burstMs.toFixed(1)}ms`,
				confidence: Math.max(0.10, Math.min(0.95, baseConf + 0.05 * Math.min(4, repeats - 1))),
				repeats,
				pairs: parsed.totalPairs,
				unknownRatio,
			});
		}

		this._resetBurst();
	}

	private _resetBurst(): void {
		this._burstActive = false;
		this._burstSamples = 0;
		this._currentLevel = 0;
		this._currentRun = 0;
		this._runs.length = 0;
	}

	private _pulseStats(valuesUs: number[]): { shortUs: number; longUs: number } | null {
		const filtered = valuesUs.filter((v) => v >= 70 && v <= 30000);
		if (filtered.length < 8) return null;

		const sorted = filtered.slice().sort((a, b) => a - b);
		const p20 = sorted[Math.floor((sorted.length - 1) * 0.20)];
		const p80 = sorted[Math.floor((sorted.length - 1) * 0.80)];
		const shortUs = Math.max(80, p20);
		const longUs = Math.max(shortUs * 1.2, p80);
		return { shortUs, longUs };
	}

	private _fallbackShortUs(runsUs: RunUs[]): number {
		const highs = runsUs
			.filter((r) => r.level === 1)
			.map((r) => r.us)
			.filter((v) => v >= 60 && v <= 20000);
		if (!highs.length) return 220;
		highs.sort((a, b) => a - b);
		const idx = Math.max(0, Math.floor((highs.length - 1) * 0.25));
		return Math.max(80, highs[idx]);
	}

	private _extractSymbols(runsUs: RunUs[], shortUs: number): SymbolParse {
		if (!runsUs.length) return { symbols: '', unknown: 0, totalPairs: 0 };

		// Ensure we start from a high pulse when possible.
		let start = 0;
		if (runsUs[0].level === 0 && runsUs.length > 1) start = 1;

		let out = '';
		let unknown = 0;
		let pairs = 0;

		for (let i = start; i + 1 < runsUs.length; i += 2) {
			const h = runsUs[i];
			const l = runsUs[i + 1];
			if (h.level !== 1 || l.level !== 0) break;

			const qh = h.us / Math.max(shortUs, 1);
			const ql = l.us / Math.max(shortUs, 1);
			pairs++;

			// Sync / frame separator: short high + very long low.
			if (qh < 2.2 && ql >= 8.0) {
				out += '|';
				continue;
			}
			// PT2262 tri-state F symbol.
			if (qh < 2.2 && ql < 2.2) {
				out += 'F';
				continue;
			}
			// PWM binary symbols used by EV1527/PT families.
			if (qh < 2.2 && ql >= 2.2 && ql < 7.0) {
				out += '0';
				continue;
			}
			if (qh >= 2.2 && qh < 7.0 && ql < 2.2) {
				out += '1';
				continue;
			}

			out += 'X';
			unknown++;
		}

		return { symbols: out, unknown, totalPairs: pairs };
	}

	private _decodeKnownProtocols(parsed: SymbolParse, shortUs: number, longUs: number, runsUs: RunUs[]): DecodedProtocol | null {
		const frames = parsed.symbols
			.split('|')
			.map((f) => f.replace(/X+/g, ''))
			.filter((f) => f.length > 0);

		if (!frames.length) return null;

		const frameCount = new Map<string, number>();
		for (const f of frames) {
			frameCount.set(f, (frameCount.get(f) || 0) + 1);
		}
		const unknownRatio = parsed.unknown / Math.max(parsed.totalPairs, 1);

		const pickBest = (re: RegExp, targetLen: number): { frame: string; repeats: number } | null => {
			let bestFrame = '';
			let bestRepeats = 0;
			let bestScore = -1;
			for (const [frame, repeats] of frameCount.entries()) {
				if (!re.test(frame)) continue;
				const lenScore = 1 - Math.min(1, Math.abs(frame.length - targetLen) / targetLen);
				const repScore = Math.min(1, repeats / 4);
				const score = (0.65 * lenScore) + (0.35 * repScore);
				if (score > bestScore) {
					bestScore = score;
					bestFrame = frame;
					bestRepeats = repeats;
				}
			}
			return bestFrame ? { frame: bestFrame, repeats: bestRepeats } : null;
		};

		// EV1527-like: 24 binary bits repeated.
		const ev = pickBest(/^[01]{20,28}$/, 24);
		if (
			ev &&
			ev.frame.length === 24 &&
			ev.repeats >= 2 &&
			unknownRatio <= 0.24 &&
			shortUs >= 120 &&
			shortUs <= 950
		) {
			const payload = parseInt(ev.frame, 2).toString(16).toUpperCase().padStart(6, '0');
			const addr = parseInt(ev.frame.slice(0, 20), 2).toString(16).toUpperCase().padStart(5, '0');
			const keyBits = ev.frame.slice(20);
			const keyHex = parseInt(keyBits, 2).toString(16).toUpperCase();
			const keyDec = parseInt(keyBits, 2);
			const confidence = this._protocolConfidence(parsed, ev.repeats, shortUs, longUs, 24, 0.94);
			return {
				protocol: 'EV1527',
				model: 'EV1527-like',
				id: `${addr}:${keyHex}`,
				raw: payload,
				text: `bits=24 address=0x${addr} button=0x${keyHex}(${keyDec}) repeats=${ev.repeats}`,
				confidence,
				repeats: ev.repeats,
				pairs: parsed.totalPairs,
				unknownRatio,
			};
		}

		// PT2262-like: tri-state symbols (0/1/F), typically 12 symbols.
		const pt = pickBest(/^[01F]{10,14}$/, 12);
		if (
			pt &&
			pt.frame.length >= 10 &&
			pt.repeats >= 2 &&
			unknownRatio <= 0.30 &&
			shortUs >= 120 &&
			shortUs <= 1100
		) {
			const trits = pt.frame;
			const mapped = trits.replace(/F/g, 'x');
			const hasFloat = trits.includes('F');
			if (!hasFloat) return null;
			const addrTrits = trits.slice(0, Math.min(8, trits.length));
			const dataTrits = trits.slice(Math.min(8, trits.length));
			const id = this._hash8(addrTrits).slice(0, 6);
			const confidence = this._protocolConfidence(parsed, pt.repeats, shortUs, longUs, 12, 0.88);
			return {
				protocol: 'PT2262',
				model: 'PT2262-like',
				id,
				raw: trits,
				text: `trits=${trits.length} addr=${addrTrits} data=${dataTrits} code=${mapped} repeats=${pt.repeats}`,
				confidence,
				repeats: pt.repeats,
				pairs: parsed.totalPairs,
				unknownRatio,
			};
		}

		const fixedGap = this._decodeFixedGapPwm(runsUs, shortUs, longUs);
		if (fixedGap) {
			const waveman = this._decodeWaveman(fixedGap.row, fixedGap.repeats, parsed);
			if (waveman) return waveman;
			const visonic = this._decodeVisonicPowercode(fixedGap.row, fixedGap.repeats, parsed);
			if (visonic) return visonic;

			const row = fixedGap.row;
			const rowHex = parseInt(row, 2).toString(16).toUpperCase().padStart(Math.ceil(row.length / 4), '0');
			const model =
				row.length === 24 ? 'EV1527-like (flex)' :
				row.length === 12 ? 'SC226x-like (flex)' :
				'Fixed-gap PWM (flex)';
			const confidence = this._protocolConfidence(parsed, fixedGap.repeats, fixedGap.shortUs, fixedGap.longUs, row.length, 0.86);
			return {
				protocol: 'FLEX-PWM',
				model,
				id: this._hash8(row).slice(0, 8),
				raw: row,
				text: `bits=${row.length} rows=${fixedGap.rows} repeats=${fixedGap.repeats} code=0x${rowHex} gap=${fixedGap.gapUs.toFixed(0)}us short=${fixedGap.shortUs.toFixed(0)}us long=${fixedGap.longUs.toFixed(0)}us`,
				confidence,
				repeats: fixedGap.repeats,
				pairs: parsed.totalPairs,
				unknownRatio,
			};
		}

		const ppm = this._decodePpm(runsUs, shortUs, longUs);
		if (ppm) {
			const x10 = this._decodeX10Rf(ppm.row, ppm.repeats, parsed);
			if (x10) return x10;

			const rowHex = parseInt(ppm.row, 2).toString(16).toUpperCase().padStart(Math.ceil(ppm.row.length / 4), '0');
			const confidence = this._protocolConfidence(parsed, ppm.repeats, ppm.shortGapUs, ppm.longGapUs, ppm.row.length, 0.84);
			return {
				protocol: 'FLEX-PPM',
				model: 'Pulse-position (flex)',
				id: this._hash8(ppm.row).slice(0, 8),
				raw: ppm.row,
				text: `bits=${ppm.row.length} rows=${ppm.rows} repeats=${ppm.repeats} code=0x${rowHex} pulse=${ppm.pulseUs.toFixed(0)}us shortGap=${ppm.shortGapUs.toFixed(0)}us longGap=${ppm.longGapUs.toFixed(0)}us`,
				confidence,
				repeats: ppm.repeats,
				pairs: parsed.totalPairs,
				unknownRatio,
			};
		}

		const manchester = this._decodeManchester(runsUs);
		if (manchester) {
			const rowHex = parseInt(manchester.row, 2).toString(16).toUpperCase().padStart(Math.ceil(manchester.row.length / 4), '0');
			const confidence = Math.max(
				0.45,
				Math.min(
					0.88,
					0.42 * Math.min(1, manchester.repeats / 4) +
					0.24 * Math.min(1, manchester.row.length / 32) +
					0.18 * Math.max(0, 1 - unknownRatio) +
					0.16
				)
			);
			return {
				protocol: 'FLEX-MANCHESTER',
				model: manchester.inverted ? 'Manchester / bi-phase (inv)' : 'Manchester / bi-phase',
				id: this._hash8(manchester.row).slice(0, 8),
				raw: manchester.row,
				text: `bits=${manchester.row.length} rows=${manchester.rows} repeats=${manchester.repeats} code=0x${rowHex} unit=${manchester.unitUs.toFixed(0)}us`,
				confidence,
				repeats: manchester.repeats,
				pairs: parsed.totalPairs,
				unknownRatio,
			};
		}

		// Fallback for streams where sync separators are noisy/missing:
		// scan the full symbol stream for repeated fixed-length frames.
		if (shortUs >= 140 && shortUs <= 1200 && unknownRatio <= 0.34) {
			const bitsOnly = parsed.symbols.replace(/[^01]/g, '');
			const rep24 = bitsOnly.length >= 72 ? this._findRepeatedBinaryWindow(bitsOnly, 24, 3) : null;
			if (rep24) {
				const payload = parseInt(rep24.frame, 2).toString(16).toUpperCase().padStart(6, '0');
				const addr = parseInt(rep24.frame.slice(0, 20), 2).toString(16).toUpperCase().padStart(5, '0');
				const keyBits = rep24.frame.slice(20);
				const keyHex = parseInt(keyBits, 2).toString(16).toUpperCase();
				const keyDec = parseInt(keyBits, 2);
				const confidence = this._protocolConfidence(parsed, rep24.repeats, shortUs, longUs, 24, 0.90);
				return {
					protocol: 'EV1527',
					model: 'EV1527-like (fallback)',
					id: `${addr}:${keyHex}`,
					raw: payload,
					text: `bits=24 address=0x${addr} button=0x${keyHex}(${keyDec}) repeats=${rep24.repeats}`,
					confidence,
					repeats: rep24.repeats,
					pairs: parsed.totalPairs,
					unknownRatio,
				};
			}

			const triOnly = parsed.symbols.replace(/[^01F]/g, '');
			const rep12 = triOnly.length >= 48 ? this._findRepeatedTritWindow(triOnly, 12, 4) : null;
			if (rep12 && rep12.frame.includes('F')) {
				const trits = rep12.frame;
				const mapped = trits.replace(/F/g, 'x');
				const addrTrits = trits.slice(0, Math.min(8, trits.length));
				const dataTrits = trits.slice(Math.min(8, trits.length));
				const id = this._hash8(addrTrits).slice(0, 6);
				const confidence = this._protocolConfidence(parsed, rep12.repeats, shortUs, longUs, 12, 0.84);
				return {
					protocol: 'PT2262',
					model: 'PT2262-like (fallback)',
					id,
					raw: trits,
					text: `trits=${trits.length} addr=${addrTrits} data=${dataTrits} code=${mapped} repeats=${rep12.repeats}`,
					confidence,
					repeats: rep12.repeats,
					pairs: parsed.totalPairs,
					unknownRatio,
				};
			}
		}

		return null;
	}

	private _decodeWaveman(row: string, repeats: number, parsed: SymbolParse): DecodedProtocol | null {
		if (row.length !== 25) return null;
		if (/^0+$/.test(row) || /^1+$/.test(row)) return null;

		for (let i = 0; i < 24; i += 2) {
			if (row[i] !== '1') return null;
		}

		const nibs: number[] = [];
		for (let i = 0; i < 24; i += 8) {
			let nib = 0;
			for (let j = 0; j < 8; j += 2) {
				const pair = row.slice(i + j, i + j + 2);
				nib <<= 1;
				if (pair === '11') {
					nib |= 0;
				} else if (pair === '10') {
					nib |= 1;
				} else {
					return null;
				}
			}
			nibs.push(nib);
		}

		const id = String.fromCharCode(65 + nibs[0]);
		const channel = (nibs[1] >> 2) + 1;
		const button = (nibs[1] & 0x03) + 1;
		const state = nibs[2] === 0x0e ? 'ON' : 'OFF';
		return {
			protocol: 'WAVEMAN',
			model: 'Waveman-Switch',
			id: `${id}${channel}${button}`,
			raw: row,
			text: `id=${id} channel=${channel} button=${button} state=${state} repeats=${repeats}`,
			confidence: 0.92,
			repeats,
			pairs: parsed.totalPairs,
			unknownRatio: parsed.unknown / Math.max(parsed.totalPairs, 1),
		};
	}

	private _decodeVisonicPowercode(row: string, repeats: number, parsed: SymbolParse): DecodedProtocol | null {
		if (row.length !== 37) return null;
		const bits = BitBuffer.fromBitRows([row]);
		const msg = bits.extractBytes(0, 1, 36);
		if (!msg[0] && !msg[1] && !msg[2] && !msg[3] && !msg[4]) return null;
		const lrc = msg[0] ^ msg[1] ^ msg[2] ^ msg[3] ^ msg[4];
		if ((((lrc >> 4) ^ (lrc & 0x0f)) & 0x0f) !== 0) return null;

		const id = [msg[0], msg[1], msg[2]].map((v) => v.toString(16).toUpperCase().padStart(2, '0')).join('');
		const flags = msg[3];
		return {
			protocol: 'VISONIC-POWERCODE',
			model: 'Visonic-Powercode',
			id,
			raw: row,
			text: `id=${id} tamper=${(flags & 0x80) ? 1 : 0} alarm=${(flags & 0x40) ? 1 : 0} battery_ok=${(flags & 0x20) ? 0 : 1} restore=${(flags & 0x08) ? 1 : 0} repeats=${repeats}`,
			confidence: 0.94,
			repeats,
			pairs: parsed.totalPairs,
			unknownRatio: parsed.unknown / Math.max(parsed.totalPairs, 1),
		};
	}

	private _decodeX10Rf(row: string, repeats: number, parsed: SymbolParse): DecodedProtocol | null {
		if (row.length !== 32) return null;
		const bits = BitBuffer.fromBitRows([row]);
		const b = bits.extractBytes(0, 0, 32);
		const knownMask = [0x0b, 0x0b, 0x07, 0x07];
		const knownValue = [0x00, 0x0b, 0x00, 0x07];
		if (((b[0] ^ b[1]) & 0xff) !== 0xff || ((b[2] ^ b[3]) & 0xff) !== 0xff) return null;
		for (let i = 0; i < 4; i++) {
			if ((b[i] & knownMask[i]) !== knownValue[i]) return null;
		}

		const houseBits = [
			(b[0] & 0x80) >> 7,
			(b[0] & 0x40) >> 6,
			(b[0] & 0x20) >> 5,
			(b[0] & 0x10) >> 4,
		];
		let houseCode = ((~(houseBits[0] ^ houseBits[1])) & 0x01) << 3;
		houseCode |= ((~houseBits[1]) & 0x01) << 2;
		houseCode |= ((houseBits[1] ^ houseBits[2]) & 0x01) << 1;
		houseCode |= houseBits[3] & 0x01;

		let deviceCode = (b[0] & 0x04) << 1;
		deviceCode |= (b[2] & 0x40) >> 4;
		deviceCode |= (b[2] & 0x08) >> 2;
		deviceCode |= (b[2] & 0x10) >> 4;
		deviceCode += 1;

		const channel = String.fromCharCode(65 + houseCode);
		let state = (b[2] & 0x20) === 0x00 ? 'ON' : 'OFF';
		if ((b[2] & 0x80) === 0x80) {
			deviceCode = 0;
			switch (b[2]) {
				case 0x98:
					state = 'DIM';
					break;
				case 0x88:
					state = 'BRI';
					break;
				case 0x90:
					state = 'ALL LTS ON';
					break;
				case 0x80:
					state = 'ALL OFF';
					break;
				default:
					state = 'UNKNOWN';
					break;
			}
		}

		return {
			protocol: 'X10-RF',
			model: 'X10-RF',
			id: `${channel}${deviceCode}`,
			raw: row,
			text: `channel=${channel} id=${deviceCode} state=${state} repeats=${repeats}`,
			confidence: 0.93,
			repeats,
			pairs: parsed.totalPairs,
			unknownRatio: parsed.unknown / Math.max(parsed.totalPairs, 1),
		};
	}

	private _findRepeatedBinaryWindow(bits: string, width: number, minRepeats: number): { frame: string; repeats: number } | null {
		if (bits.length < width * minRepeats) return null;
		const counts = new Map<string, number>();
		for (let i = 0; i + width <= bits.length; i++) {
			const frame = bits.slice(i, i + width);
			// Reject pathological all-zeros/all-ones windows.
			if (/^0+$/.test(frame) || /^1+$/.test(frame)) continue;
			counts.set(frame, (counts.get(frame) || 0) + 1);
		}
		let bestFrame = '';
		let bestCount = 0;
		for (const [frame, count] of counts.entries()) {
			if (count > bestCount) {
				bestCount = count;
				bestFrame = frame;
			}
		}
		return bestCount >= minRepeats && bestFrame ? { frame: bestFrame, repeats: bestCount } : null;
	}

	private _findRepeatedTritWindow(trits: string, width: number, minRepeats: number): { frame: string; repeats: number } | null {
		if (trits.length < width * minRepeats) return null;
		const counts = new Map<string, number>();
		for (let i = 0; i + width <= trits.length; i++) {
			const frame = trits.slice(i, i + width);
			if (!frame.includes('F')) continue;
			counts.set(frame, (counts.get(frame) || 0) + 1);
		}
		let bestFrame = '';
		let bestCount = 0;
		for (const [frame, count] of counts.entries()) {
			if (count > bestCount) {
				bestCount = count;
				bestFrame = frame;
			}
		}
		return bestCount >= minRepeats && bestFrame ? { frame: bestFrame, repeats: bestCount } : null;
	}

	private _pickRepeatedRow(rows: string[], minRepeats: number, minBits: number, allowPrefix = false): { row: string; repeats: number; rows: number } | null {
		const filtered = rows.filter((row) => row.length >= minBits);
		if (!filtered.length) return null;
		const bits = BitBuffer.fromBitRows(filtered);
		const index = allowPrefix
			? bits.findRepeatedPrefix(minRepeats, minBits)
			: bits.findRepeatedRow(minRepeats, minBits);
		if (index < 0) return null;
		return {
			row: bits.rowToBitString(index),
			repeats: bits.countRepeats(index, allowPrefix ? minBits : 0),
			rows: bits.numRows,
		};
	}

	private _decodeFixedGapPwm(runsUs: RunUs[], fallbackShortUs: number, fallbackLongUs: number): FixedGapDecode | null {
		if (runsUs.length < 12) return null;

		let start = 0;
		if (runsUs[0].level === 0 && runsUs.length > 1) start = 1;

		const pairs: Array<{ high: number; low: number }> = [];
		for (let i = start; i + 1 < runsUs.length; i += 2) {
			const h = runsUs[i];
			const l = runsUs[i + 1];
			if (h.level !== 1 || l.level !== 0) break;
			pairs.push({ high: h.us, low: l.us });
		}
		if (pairs.length < 8) return null;

		const lows = pairs.map((p) => p.low).filter((v) => v >= 80 && v <= 12000);
		if (lows.length < 6) return null;

		const gapUs = this._percentile(lows, 0.5);
		const lowP20 = this._percentile(lows, 0.2);
		const lowP80 = this._percentile(lows, 0.8);
		if (lowP20 <= 0 || (lowP80 / lowP20) > 1.9) return null;

		const highs = pairs
			.map((p) => p.high)
			.filter((v) => v >= 120 && v <= Math.max(fallbackLongUs * 1.8, gapUs * 4.0));
		if (highs.length < 6) return null;

		const shortPulseUs = this._percentile(highs, 0.25);
		const longPulseUs = this._percentile(highs, 0.75);
		if (longPulseUs / Math.max(shortPulseUs, 1) < 1.6) return null;

		const rows: string[] = [];
		let current = '';
		for (const pair of pairs) {
			const isSeparator = pair.low > gapUs * 2.2 || pair.high > Math.max(longPulseUs * 1.8, fallbackLongUs * 2.2);
			if (isSeparator) {
				if (current.length >= 8) rows.push(current);
				current = '';
				continue;
			}

			const mid = (shortPulseUs + longPulseUs) * 0.5;
			current += pair.high < mid ? '0' : '1';
		}
		if (current.length >= 8) rows.push(current);
		if (!rows.length) return null;

		const best = this._pickRepeatedRow(
			rows.filter((row) => row.length >= 8 && row.length <= 32),
			2,
			8
		);
		if (!best) return null;
		return {
			row: best.row,
			repeats: best.repeats,
			gapUs,
			shortUs: shortPulseUs,
			longUs: longPulseUs,
			rows: best.rows,
		};
	}

	private _decodePpm(runsUs: RunUs[], fallbackShortUs: number, fallbackLongUs: number): PpmDecode | null {
		if (runsUs.length < 12) return null;

		let start = 0;
		if (runsUs[0].level === 0 && runsUs.length > 1) start = 1;

		const pairs: Array<{ high: number; low: number }> = [];
		for (let i = start; i + 1 < runsUs.length; i += 2) {
			const h = runsUs[i];
			const l = runsUs[i + 1];
			if (h.level !== 1 || l.level !== 0) break;
			pairs.push({ high: h.us, low: l.us });
		}
		if (pairs.length < 8) return null;

		const highs = pairs.map((p) => p.high).filter((v) => v >= 80 && v <= 4000);
		if (highs.length < 6) return null;
		const pulseUs = this._percentile(highs, 0.5);
		const highP20 = this._percentile(highs, 0.2);
		const highP80 = this._percentile(highs, 0.8);
		if (highP20 <= 0 || (highP80 / highP20) > 1.7) return null;

		const lows = pairs.map((p) => p.low).filter((v) => v >= 120 && v <= 16000);
		if (lows.length < 6) return null;
		const shortGapUs = this._percentile(lows, 0.25);
		const longGapUs = this._percentile(lows, 0.75);
		if (longGapUs / Math.max(shortGapUs, 1) < 1.6) return null;

		const rows: string[] = [];
		let current = '';
		for (const pair of pairs) {
			const pulseOk = pair.high >= pulseUs * 0.45 && pair.high <= pulseUs * 1.75;
			if (!pulseOk) {
				if (current.length >= 8) rows.push(current);
				current = '';
				continue;
			}

			if (pair.low > longGapUs * 2.1) {
				if (current.length >= 8) rows.push(current);
				current = '';
				continue;
			}

			const mid = (shortGapUs + longGapUs) * 0.5;
			current += pair.low < mid ? '0' : '1';
		}
		if (current.length >= 8) rows.push(current);
		if (!rows.length) return null;

		const best = this._pickRepeatedRow(
			rows.filter((row) => row.length >= 8 && row.length <= 48),
			2,
			8
		);
		if (!best) return null;

		return {
			row: best.row,
			repeats: best.repeats,
			pulseUs,
			shortGapUs,
			longGapUs,
			rows: best.rows,
		};
	}

	private _decodeManchester(runsUs: RunUs[]): ManchesterDecode | null {
		if (runsUs.length < 16) return null;

		const candidateRuns = runsUs
			.map((r) => r.us)
			.filter((v) => v >= 80 && v <= 4000);
		if (candidateRuns.length < 12) return null;

		const unitUs = this._percentile(candidateRuns, 0.35);
		if (unitUs < 80 || unitUs > 1800) return null;

		let regular = 0;
		for (const us of candidateRuns) {
			const q = us / Math.max(unitUs, 1);
			if ((q >= 0.55 && q <= 1.45) || (q >= 1.55 && q <= 2.45)) regular++;
		}
		if ((regular / candidateRuns.length) < 0.72) return null;

		const chips: number[] = [];
		for (const run of runsUs) {
			const q = run.us / Math.max(unitUs, 1);
			let count = Math.round(q);
			if (count < 1) count = 1;
			if (count > 3) {
				// Long outliers usually indicate frame gaps / noise, not valid chips.
				count = 0;
			}
			for (let i = 0; i < count; i++) chips.push(run.level);
			if (count === 0 && chips.length && chips[chips.length - 1] !== 2) chips.push(2);
		}
		if (chips.length < 24) return null;

		const chipRows: string[] = [];
		let currentChips = '';
		for (const chip of chips) {
			if (chip === 2) {
				if (currentChips.length >= 16) chipRows.push(currentChips);
				currentChips = '';
				continue;
			}
			currentChips += chip ? '1' : '0';
		}
		if (currentChips.length >= 16) chipRows.push(currentChips);
		if (!chipRows.length) return null;

		const decodeRows = (invert: boolean): { row: string; repeats: number; rows: number } | null => {
			const input = BitBuffer.fromBitRows(chipRows);
			if (invert) input.invert();
			const decodedRows: string[] = [];
			for (let row = 0; row < input.numRows; row++) {
				const decoded = input.manchesterDecode(row, 0, 0);
				if (!decoded.numRows || decoded.bitsPerRow[0] < 8) continue;
				const outRow = decoded.rowToBitString(0);
				if (/^0+$/.test(outRow) || /^1+$/.test(outRow) || outRow.length > 96) continue;
				decodedRows.push(outRow);
			}
			return this._pickRepeatedRow(decodedRows, 2, 8);
		};

		const normal = decodeRows(false);
		const inverted = decodeRows(true);
		if (!normal && !inverted) return null;

		const best = !inverted || (normal && normal.repeats >= inverted.repeats) ? normal! : inverted!;
		if (best.row.length < 12 || best.repeats < 3 || best.rows < 3) return null;
		return {
			row: best.row,
			repeats: best.repeats,
			unitUs,
			rows: best.rows,
			inverted: !!inverted && best === inverted,
		};
	}

	private _percentile(values: number[], q: number): number {
		if (!values.length) return 0;
		const sorted = values.slice().sort((a, b) => a - b);
		const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
		return sorted[idx];
	}

	private _protocolConfidence(parsed: SymbolParse, repeats: number, shortUs: number, longUs: number, targetLen: number, cap: number): number {
		const ratio = longUs / Math.max(shortUs, 1);
		const unknownPenalty = 1 - Math.min(1, parsed.unknown / Math.max(parsed.totalPairs, 1));
		const repeatScore = Math.min(1, repeats / 4);
		const lenScore = Math.min(1, parsed.symbols.replace(/\|/g, '').length / (targetLen * 1.8));
		const pwmScore = Math.max(0, 1 - Math.abs(ratio - 3.0) / 2.5);
		return Math.max(0.2, Math.min(cap, (0.40 * repeatScore) + (0.25 * unknownPenalty) + (0.20 * pwmScore) + (0.15 * lenScore)));
	}

	private _signature(symbols: string): string {
		const clean = symbols.replace(/\|+/g, '|').replace(/X+/g, 'X');
		const n = Math.min(72, clean.length);
		const tokens = new Array<string>(n);
		for (let i = 0; i < n; i++) {
			tokens[i] = clean[i];
		}
		return tokens.join('');
	}

	private _formatRuns(runsUs: Array<{ level: 0 | 1; us: number }>, maxRuns: number): string {
		const n = Math.min(maxRuns, runsUs.length);
		const out = new Array<string>(n);
		for (let i = 0; i < n; i++) {
			const r = runsUs[i];
			out[i] = `${r.level ? 'H' : 'L'}${r.us.toFixed(0)}`;
		}
		return out.join(' ');
	}

	private _hash8(text: string): string {
		let h = 0x811c9dc5;
		for (let i = 0; i < text.length; i++) {
			h ^= text.charCodeAt(i);
			h = Math.imul(h, 0x01000193);
		}
		return (h >>> 0).toString(16).toUpperCase().padStart(8, '0');
	}
}
