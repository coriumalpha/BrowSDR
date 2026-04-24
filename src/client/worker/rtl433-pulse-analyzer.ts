import type { PulsePair } from './rtl433-pulse-data';

export interface PulseHistogramBin {
	count: number;
	sum: number;
	mean: number;
	min: number;
	max: number;
}

export interface PulseHistogram {
	bins: PulseHistogramBin[];
}

export interface PulseProfile {
	pulseBins: PulseHistogram;
	gapBins: PulseHistogram;
	periodBins: PulseHistogram;
	periodGpBins: PulseHistogram;
	timingBins: PulseHistogram;
	shortPulseUs: number;
	longPulseUs: number;
	shortGapUs: number;
	longGapUs: number;
	shortPeriodUs: number;
	longPeriodUs: number;
	modulationGuess: 'NONE' | 'PPM' | 'PWM' | 'MANCHESTER' | 'PCM';
	gapLimitUs: number;
	resetLimitUs: number;
	syncWidthUs: number;
	toleranceUs: number;
	fixedGapLikely: boolean;
	ppmLikely: boolean;
	manchesterLikely: boolean;
	pathologicalLikely: boolean;
}

const MAX_HIST_BINS = 16;
const DEFAULT_TOLERANCE = 0.20;

function sortByMean(bins: PulseHistogramBin[]): PulseHistogramBin[] {
	return bins.slice().sort((a, b) => a.mean - b.mean);
}

function sortByCount(bins: PulseHistogramBin[]): PulseHistogramBin[] {
	return bins.slice().sort((a, b) => a.count - b.count);
}

function fuseBins(bins: PulseHistogramBin[], tolerance: number): PulseHistogramBin[] {
	const out = sortByMean(bins);
	for (let i = 0; i < out.length - 1; i++) {
		for (let j = i + 1; j < out.length; j++) {
			const a = out[i];
			const b = out[j];
			if (Math.abs(a.mean - b.mean) < tolerance * Math.max(a.mean, b.mean)) {
				a.count += b.count;
				a.sum += b.sum;
				a.mean = a.sum / a.count;
				a.min = Math.min(a.min, b.min);
				a.max = Math.max(a.max, b.max);
				out.splice(j, 1);
				j--;
			}
		}
	}
	return sortByMean(out);
}

function histogram(values: number[], tolerance = DEFAULT_TOLERANCE): PulseHistogram {
	const bins: PulseHistogramBin[] = [];
	for (const value of values) {
		if (!Number.isFinite(value) || value <= 0) continue;
		let matched = false;
		for (const bin of bins) {
			if (Math.abs(value - bin.mean) < tolerance * Math.max(value, bin.mean)) {
				bin.count++;
				bin.sum += value;
				bin.mean = bin.sum / bin.count;
				bin.min = Math.min(bin.min, value);
				bin.max = Math.max(bin.max, value);
				matched = true;
				break;
			}
		}
		if (!matched && bins.length < MAX_HIST_BINS) {
			bins.push({ count: 1, sum: value, mean: value, min: value, max: value });
		}
	}
	return { bins: fuseBins(bins, tolerance) };
}

function firstMean(hist: PulseHistogram): number {
	return hist.bins[0]?.mean || 0;
}

function secondMean(hist: PulseHistogram): number {
	return hist.bins[1]?.mean || firstMean(hist);
}

export function analyzePulsePairs(pairs: PulsePair[]): PulseProfile | null {
	if (pairs.length < 4) return null;

	const pulses = pairs.map((p) => p.high).filter((v) => v >= 20 && v <= 60000);
	const gaps = pairs.map((p) => p.low).filter((v) => v >= 20 && v <= 60000);
	const periods = pairs.map((p) => p.high + p.low).filter((v) => v >= 40 && v <= 90000);
	const periodsGp = pairs.map((p, i) => (i === 0 ? p.high : p.high + pairs[i - 1].low)).filter((v) => v >= 40 && v <= 90000);
	const timings = pulses.concat(gaps);
	if (pulses.length < 4 || gaps.length < 4) return null;

	const pulseBins = histogram(pulses);
	const gapBins = histogram(gaps);
	const periodBins = histogram(periods);
	const periodGpBins = histogram(periodsGp);
	const timingBins = histogram(timings);

	const shortPulseUs = firstMean(pulseBins);
	const longPulseUs = secondMean(pulseBins);
	const shortGapUs = firstMean(gapBins);
	const longGapUs = secondMean(gapBins);
	const shortPeriodUs = firstMean(periodBins);
	const longPeriodUs = secondMean(periodBins);

	const pulseByCount = sortByCount(pulseBins.bins);
	const gapByCount = sortByCount(gapBins.bins);
	const dominantPulse = pulseByCount[pulseByCount.length - 1];
	const dominantGap = gapByCount[gapByCount.length - 1];

	const fixedGapLikely =
		!!dominantGap &&
		gapBins.bins.length <= 3 &&
		dominantGap.count >= Math.max(4, Math.floor(pairs.length * 0.45)) &&
		longPulseUs / Math.max(shortPulseUs, 1) >= 1.5;

	const ppmLikely =
		!!dominantPulse &&
		pulseBins.bins.length <= 3 &&
		dominantPulse.count >= Math.max(4, Math.floor(pairs.length * 0.45)) &&
		longGapUs / Math.max(shortGapUs, 1) >= 1.5;

	const manchesterLikely =
		pulseBins.bins.length <= 2 &&
		gapBins.bins.length <= 2 &&
		shortPulseUs > 0 &&
		shortGapUs > 0 &&
		Math.abs(shortPulseUs - shortGapUs) < 0.28 * Math.max(shortPulseUs, shortGapUs) &&
		shortPeriodUs > 0 &&
		longPeriodUs / Math.max(shortPeriodUs, 1) <= 2.8;

	const pathologicalLikely =
		pairs.length >= 256 &&
		shortPulseUs > 0 &&
		shortGapUs > 0 &&
		shortPulseUs <= 140 &&
		shortGapUs <= 220 &&
		pulseBins.bins.length <= 3 &&
		gapBins.bins.length <= 3;

	let modulationGuess: PulseProfile['modulationGuess'] = 'NONE';
	let gapLimitUs = 0;
	let resetLimitUs = 0;
	let syncWidthUs = 0;
	let toleranceUs = 0;

	if (pairs.length === 1) {
		modulationGuess = 'NONE';
	} else if (pulseBins.bins.length === 1 && gapBins.bins.length === 1) {
		modulationGuess = 'NONE';
	} else if (pulseBins.bins.length === 1 && gapBins.bins.length > 1) {
		modulationGuess = 'PPM';
		gapLimitUs = gapBins.bins[1]?.max || longGapUs;
		resetLimitUs = gapBins.bins[gapBins.bins.length - 1]?.max || longGapUs;
	} else if (pulseBins.bins.length === 2 && gapBins.bins.length === 1) {
		modulationGuess = 'PWM';
		toleranceUs = Math.abs(longPulseUs - shortPulseUs) * 0.4;
		resetLimitUs = gapBins.bins[gapBins.bins.length - 1]?.max || shortGapUs;
	} else if (pulseBins.bins.length === 2 && gapBins.bins.length === 2 && periodBins.bins.length === 1) {
		modulationGuess = 'PWM';
		toleranceUs = Math.abs(longPulseUs - shortPulseUs) * 0.4;
		resetLimitUs = gapBins.bins[gapBins.bins.length - 1]?.max || longGapUs;
	} else if (pulseBins.bins.length === 2 && gapBins.bins.length === 2 && periodBins.bins.length === 3) {
		modulationGuess = 'MANCHESTER';
		resetLimitUs = gapBins.bins[gapBins.bins.length - 1]?.max || longGapUs;
	} else if (pulseBins.bins.length === 2 && gapBins.bins.length >= 3) {
		modulationGuess = 'PWM';
		gapLimitUs = gapBins.bins[1]?.max || longGapUs;
		toleranceUs = Math.abs(longPulseUs - shortPulseUs) * 0.4;
		resetLimitUs = gapBins.bins[gapBins.bins.length - 1]?.max || longGapUs;
	} else if (
		pulseBins.bins.length >= 3 &&
		gapBins.bins.length >= 3 &&
		Math.abs((pulseBins.bins[1]?.mean || 0) - 2 * shortPulseUs) <= shortPulseUs / 8 &&
		Math.abs((pulseBins.bins[2]?.mean || 0) - 3 * shortPulseUs) <= shortPulseUs / 8 &&
		Math.abs(shortGapUs - shortPulseUs) <= shortPulseUs / 8 &&
		Math.abs((gapBins.bins[1]?.mean || 0) - 2 * shortPulseUs) <= shortPulseUs / 8 &&
		Math.abs((gapBins.bins[2]?.mean || 0) - 3 * shortPulseUs) <= shortPulseUs / 8
	) {
		modulationGuess = 'PCM';
		resetLimitUs = shortPulseUs * 1024;
	} else if (pulseBins.bins.length === 3) {
		modulationGuess = 'PWM';
		const countSorted = sortByCount(pulseBins.bins);
		syncWidthUs = countSorted[0]?.mean || 0;
		const p1 = countSorted[1]?.mean || shortPulseUs;
		const p2 = countSorted[2]?.mean || longPulseUs;
		toleranceUs = Math.abs(p2 - p1) * 0.4;
		resetLimitUs = gapBins.bins[gapBins.bins.length - 1]?.max || longGapUs;
	}

	if (fixedGapLikely && modulationGuess === 'NONE') modulationGuess = 'PWM';
	if (ppmLikely && modulationGuess === 'NONE') modulationGuess = 'PPM';
	if (manchesterLikely && modulationGuess === 'NONE') modulationGuess = 'MANCHESTER';

	return {
		pulseBins,
		gapBins,
		periodBins,
		periodGpBins,
		timingBins,
		shortPulseUs,
		longPulseUs,
		shortGapUs,
		longGapUs,
		shortPeriodUs,
		longPeriodUs,
		modulationGuess,
		gapLimitUs,
		resetLimitUs,
		syncWidthUs,
		toleranceUs,
		fixedGapLikely,
		ppmLikely,
		manchesterLikely,
		pathologicalLikely,
	};
}
