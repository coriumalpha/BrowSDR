interface RunUs {
	level: 0 | 1;
	us: number;
}

export interface PulsePair {
	high: number;
	low: number;
}

export interface PulseRows {
	rows: string[];
	shortUs: number;
	longUs: number;
	separatorUs: number;
}

export class PulseData {
	constructor(readonly pairs: PulsePair[]) {}

	static fromRuns(runsUs: RunUs[]): PulseData | null {
		if (runsUs.length < 4) return null;
		let start = 0;
		if (runsUs[0].level === 0 && runsUs.length > 1) start = 1;

		const pairs: PulsePair[] = [];
		for (let i = start; i + 1 < runsUs.length; i += 2) {
			const h = runsUs[i];
			const l = runsUs[i + 1];
			if (h.level !== 1 || l.level !== 0) break;
			pairs.push({ high: h.us, low: l.us });
		}
		return pairs.length >= 4 ? new PulseData(pairs) : null;
	}

	get count(): number {
		return this.pairs.length;
	}

	highs(min = 0, max = Number.POSITIVE_INFINITY): number[] {
		return this.pairs.map((p) => p.high).filter((v) => v >= min && v <= max);
	}

	lows(min = 0, max = Number.POSITIVE_INFINITY): number[] {
		return this.pairs.map((p) => p.low).filter((v) => v >= min && v <= max);
	}

	percentile(values: number[], q: number): number {
		if (!values.length) return 0;
		const sorted = values.slice().sort((a, b) => a - b);
		const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
		return sorted[idx];
	}

	buildFixedGapRows(fallbackLongUs: number): PulseRows | null {
		const lows = this.lows(80, 12000);
		if (lows.length < 6) return null;

		const gapUs = this.percentile(lows, 0.5);
		const lowP20 = this.percentile(lows, 0.2);
		const lowP80 = this.percentile(lows, 0.8);
		if (lowP20 <= 0 || (lowP80 / lowP20) > 1.9) return null;

		const highs = this.highs(120, Math.max(fallbackLongUs * 1.8, gapUs * 4.0));
		if (highs.length < 6) return null;
		const shortPulseUs = this.percentile(highs, 0.25);
		const longPulseUs = this.percentile(highs, 0.75);
		if (longPulseUs / Math.max(shortPulseUs, 1) < 1.6) return null;

		const rows: string[] = [];
		let current = '';
		for (const pair of this.pairs) {
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

		return {
			rows,
			shortUs: shortPulseUs,
			longUs: longPulseUs,
			separatorUs: gapUs,
		};
	}

	buildPpmRows(): PulseRows | null {
		const highs = this.highs(80, 4000);
		if (highs.length < 6) return null;
		const pulseUs = this.percentile(highs, 0.5);
		const highP20 = this.percentile(highs, 0.2);
		const highP80 = this.percentile(highs, 0.8);
		if (highP20 <= 0 || (highP80 / highP20) > 1.7) return null;

		const lows = this.lows(120, 16000);
		if (lows.length < 6) return null;
		const shortGapUs = this.percentile(lows, 0.25);
		const longGapUs = this.percentile(lows, 0.75);
		if (longGapUs / Math.max(shortGapUs, 1) < 1.6) return null;

		const rows: string[] = [];
		let current = '';
		for (const pair of this.pairs) {
			const pulseOk = pair.high >= pulseUs * 0.45 && pair.high <= pulseUs * 1.75;
			if (!pulseOk || pair.low > longGapUs * 2.1) {
				if (current.length >= 8) rows.push(current);
				current = '';
				continue;
			}
			const mid = (shortGapUs + longGapUs) * 0.5;
			current += pair.low < mid ? '0' : '1';
		}
		if (current.length >= 8) rows.push(current);
		if (!rows.length) return null;

		return {
			rows,
			shortUs: shortGapUs,
			longUs: longGapUs,
			separatorUs: pulseUs,
		};
	}
}
