import type { AppInstance } from './types';

export const ismMethods = {
	toggleIsmPanel(this: AppInstance) {
		this.ism.panelOpen = !this.ism.panelOpen;
	},
	toggleIsmSummary(this: AppInstance) {
		this.ism.summaryOpen = !this.ism.summaryOpen;
	},
	toggleIsmFilterMode(this: AppInstance) {
		this.ism.filterMode = this.ism.filterMode === 'strict' ? 'sniffer' : 'strict';
	},
	_onIsmMessage(this: AppInstance, vfoIndex: number, freqMhz: number, msg: any) {
		const type = msg.type || 'burst';
		const protocol = msg.protocol || 'UNCLASSIFIED';
		const confidence = typeof msg.confidence === 'number' ? msg.confidence : 0;
		const repeats = Number.isFinite(msg.repeats) ? Number(msg.repeats) : undefined;
		const pairs = Number.isFinite(msg.pairs) ? Number(msg.pairs) : undefined;
		const unknownRatio = Number.isFinite(msg.unknownRatio) ? Number(msg.unknownRatio) : undefined;
		// Keep almost everything visible while still dropping obvious noise.
		// Users expect to at least see burst activity lines when a remote transmits.
		if (protocol === 'UNCLASSIFIED' && confidence < 0.08) {
			return;
		}
		if (this.ism.filterMode === 'strict' && type === 'burst') {
			const generic = protocol === 'OOK-PULSE' || protocol === 'OOK-PWM' || protocol === 'OOK-RAW' || protocol === 'UNCLASSIFIED';
			if (generic) {
				const rep = repeats ?? 1;
				if (rep < 2) return;
			}
		}

		const time = new Date().toLocaleTimeString();
		const ts = Date.now();
		const freq = freqMhz ? this.formatFreq(freqMhz) + ' MHz' : '';
		const generic = protocol === 'OOK-PULSE' || protocol === 'OOK-PWM' || protocol === 'OOK-RAW' || protocol === 'UNCLASSIFIED';
		const key = generic
			? `${vfoIndex}|${protocol}|${msg.id || ''}|${Math.round((freqMhz || 0) * 1000)}`
			: `${vfoIndex}|${protocol}|${msg.id || ''}|${msg.model || ''}`;

		// Group repeated detections of the same frame train to keep the panel readable.
		const trainWindowMs = 1400;
		let merged = false;
		for (let i = this.ism.log.length - 1; i >= 0 && i >= this.ism.log.length - 8; i--) {
			const e = this.ism.log[i];
			if (!e || e.type !== 'burst') continue;
			if (e._key !== key) continue;
			if (!Number.isFinite(e._ts) || (ts - e._ts) > trainWindowMs) continue;
			e.time = time;
			e.freq = freq;
			e.confidence = Math.max(e.confidence || 0, confidence);
			e.repeats = Math.max(e.repeats || 1, repeats || 1);
			e.pairs = Math.max(e.pairs || 0, pairs || 0);
			e.unknownRatio = Math.min(
				typeof e.unknownRatio === 'number' ? e.unknownRatio : 1,
				typeof unknownRatio === 'number' ? unknownRatio : 1
			);
			e.hits = (e.hits || 1) + 1;
			e._ts = ts;
			merged = true;
			break;
		}
		if (!merged) this.ism.log.push({
			time,
			freq,
			vfoIndex,
			type,
			protocol,
			model: msg.model || '',
			id: msg.id || '',
			raw: msg.raw || '',
			text: msg.text || '',
			confidence,
			repeats,
			pairs,
			unknownRatio,
			hits: 1,
			_ts: ts,
			_key: key,
		});

		// Keep log bounded so long sessions don't grow without limit.
		const maxEntries = 2000;
		if (this.ism.log.length > maxEntries) {
			this.ism.log.splice(0, this.ism.log.length - maxEntries);
		}

		this.$nextTick(() => {
			const el = this.$refs.ismBody;
			if (el) el.scrollTop = el.scrollHeight;
		});
	},
	clearIsm(this: AppInstance) {
		this.ism.log = [];
	},
	exportIsm(this: AppInstance) {
		const lines = this.ism.log.map((e: any) => {
			const conf = Number.isFinite(e.confidence) ? ` conf:${(e.confidence * 100).toFixed(0)}%` : '';
			const rep = Number.isFinite(e.repeats) ? ` rep:${e.repeats}` : '';
			const pairs = Number.isFinite(e.pairs) ? ` pairs:${e.pairs}` : '';
			const unk = Number.isFinite(e.unknownRatio) ? ` unk:${Math.round(e.unknownRatio * 100)}%` : '';
			const hits = Number.isFinite(e.hits) ? ` hits:${e.hits}` : '';
			const model = e.model ? ` model:${e.model}` : '';
			const id = e.id ? ` id:${e.id}` : '';
			const raw = e.raw ? ` raw:${e.raw}` : '';
			const txt = e.text ? ` ${e.text}` : '';
			return `[${e.time}] ${e.freq} ${e.protocol} (${e.type})${model}${id}${conf}${rep}${pairs}${unk}${hits}${raw}${txt}`;
		});
		const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `ism-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	},
};
