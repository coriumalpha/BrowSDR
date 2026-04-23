import type { AppInstance } from './types';
import { BOOKMARK_CATEGORIES } from './constants';

export const computedProperties = {
	isLocal(this: AppInstance) {
		const host = window.location.hostname;
		return host === 'localhost' || host === '127.0.0.1';
	},
	ismSummaries(this: AppInstance) {
		const genericProtocols = new Set(['OOK-PULSE', 'OOK-PWM', 'OOK-RAW', 'UNCLASSIFIED']);
		const buckets = new Map<string, any>();
		for (const entry of this.ism.log) {
			if (!entry || entry.type !== 'burst') continue;
			const key = entry._key || `${entry.protocol}|${entry.model || ''}|${entry.id || ''}`;
			let bucket = buckets.get(key);
			if (!bucket) {
				const isGeneric = genericProtocols.has(entry.protocol || '');
				bucket = {
					key,
					protocol: entry.protocol || 'UNCLASSIFIED',
					model: entry.model || '',
					id: entry.id || '',
					count: 0,
					hits: 0,
					confidence: 0,
					repeats: 0,
					pairs: 0,
					unknownRatio: 1,
					lastTime: '',
					lastFreq: '',
					lastText: '',
					lastTs: 0,
					isGeneric,
					label: isGeneric ? 'Generic burst' : (entry.model || entry.protocol || 'Detection'),
				};
				buckets.set(key, bucket);
			}
			bucket.count++;
			bucket.hits = Math.max(bucket.hits, entry.hits || 1);
			bucket.confidence = Math.max(bucket.confidence, entry.confidence || 0);
			bucket.repeats = Math.max(bucket.repeats, entry.repeats || 0);
			bucket.pairs = Math.max(bucket.pairs, entry.pairs || 0);
			bucket.unknownRatio = Math.min(bucket.unknownRatio, typeof entry.unknownRatio === 'number' ? entry.unknownRatio : 1);
			const ts = Number.isFinite(entry._ts) ? Number(entry._ts) : 0;
			if (ts >= bucket.lastTs) {
				bucket.lastTs = ts;
				bucket.lastTime = entry.time || '';
				bucket.lastFreq = entry.freq || '';
				bucket.lastText = entry.text || '';
			}
		}

		return Array.from(buckets.values())
			.filter((item: any) => {
				if (!item.isGeneric) return true;
				return item.repeats >= 2 || item.hits >= 2 || item.count >= 2;
			})
			.sort((a, b) =>
				(b.count - a.count) ||
				(b.confidence - a.confidence) ||
				(b.lastTs - a.lastTs) ||
				a.protocol.localeCompare(b.protocol)
			)
			.slice(0, 12);
	},
	activeAudioVfos(this: AppInstance) {
		const active: Array<{ index: number; vfo: any }> = [];
		for (let i = 0; i < this.vfos.length; i++) {
			const vfo = this.vfos[i];
			if (vfo.enabled) {
				if (!vfo.squelchEnabled || this.vfoSquelchOpen[i]) {
					active.push({ index: i, vfo });
				}
			}
		}
		return active;
	},
	// VFOs with squelch enabled, sorted by total squelch-open time (most active first)
	sortedVfoActivity(this: AppInstance) {
		const now = this.activityNow || Date.now();
		const items = this.vfos.map((vfo: any, i: number) => {
			if (!vfo.squelchEnabled) return null;
			const stat = this.vfoActivityStats[i] || { count: 0, totalMs: 0, squelchOpenSince: null };
			const liveMs = stat.squelchOpenSince ? (now - stat.squelchOpenSince) : 0;
			const totalMs = stat.totalMs + liveMs;
			return { index: i, vfo, count: stat.count, totalMs, isLive: !!stat.squelchOpenSince };
		}).filter(Boolean);
		items.sort((a: any, b: any) => b.totalMs - a.totalMs);
		// Compute pct relative to top entry
		const maxMs = items[0]?.totalMs || 1;
		for (const item of items) item.pct = (item.totalMs / maxMs) * 100;
		return items;
	},
	// Individual bookmarks grouped by category; group bookmarks as a flat sorted list
	bookmarkGroupsByCategory(this: AppInstance) {
		const search = (this.bookmarkSearch || '').toLowerCase().trim();
		const all = this.bookmarks.map((bm: any, i: number) => ({ bm, i }));
		const filtered = search
			? all.filter(({ bm }: any) =>
				(bm.name || '').toLowerCase().includes(search) ||
				String(bm.freq || bm.centerFreq || '').includes(search)
			)
			: all;
		// Flat group list (sorted by centerFreq)
		const flatGroups = filtered
			.filter(({ bm }: any) => (bm.type || 'group') === 'group')
			.sort((a: any, b: any) => (a.bm.centerFreq || 0) - (b.bm.centerFreq || 0));
		// Individual bookmarks bucketed by category
		const cats: Record<string, any[]> = {};
		for (const entry of filtered) {
			if ((entry.bm.type || 'group') !== 'individual') continue;
			const cat = entry.bm.category || '';
			if (!cats[cat]) cats[cat] = [];
			cats[cat].push(entry);
		}
		for (const arr of Object.values(cats)) {
			arr.sort((a: any, b: any) => (a.bm.freq || 0) - (b.bm.freq || 0));
		}
		const categories = Object.keys(cats)
			.map(key => ({
				key,
				collKey: 'bm:' + (key || '__uncategorised__'),
				label: BOOKMARK_CATEGORIES.find(c => c.value === key)?.label || 'Uncategorised',
				items: cats[key],
			}))
			.sort((a, b) => {
				if (a.key === '' && b.key !== '') return 1;
				if (a.key !== '' && b.key === '') return -1;
				return a.label.localeCompare(b.label);
			});
		return { categories, flatGroups };
	},
	// Calculate the min/max display bandwidth based on sampleRate AND zoom state
	minFreq(this: AppInstance) {
		const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
		const baseSpan = this.radio.sampleRate / 1e6;
		return baseMin + (baseSpan * this.view.zoomOffset);
	},
	maxFreq(this: AppInstance) {
		const baseMin = this.radio.centerFreq - (this.radio.sampleRate / 2) / 1e6;
		const baseSpan = this.radio.sampleRate / 1e6;
		return baseMin + (baseSpan * (this.view.zoomOffset + (1.0 / this.view.zoomScale)));
	}
};
