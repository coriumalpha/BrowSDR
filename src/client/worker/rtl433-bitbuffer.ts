type BitRow = number[];

/**
 * Small browser-friendly bitbuffer inspired by rtl_433's bitbuffer_t.
 * It keeps rows of bits packed MSB-first into byte arrays and exposes the
 * primitives we need for repeated-row detection and Manchester-style decoders.
 */
export class BitBuffer {
	private rows: BitRow[] = [[]];
	private widths: number[] = [0];
	private syncs: number[] = [0];

	clear(): void {
		this.rows = [[]];
		this.widths = [0];
		this.syncs = [0];
	}

	get numRows(): number {
		return this.rows.length;
	}

	get bitsPerRow(): readonly number[] {
		return this.widths;
	}

	get syncsBeforeRow(): readonly number[] {
		return this.syncs;
	}

	addBit(bit: number): void {
		const row = this.rows.length - 1;
		const width = this.widths[row];
		const byteIndex = width >> 3;
		const bitIndex = width & 7;

		while (this.rows[row].length <= byteIndex) this.rows[row].push(0);
		if (bit) {
			this.rows[row][byteIndex] |= 1 << (7 - bitIndex);
		}
		this.widths[row] = width + 1;
	}

	addBits(bits: string): void {
		for (let i = 0; i < bits.length; i++) {
			const ch = bits[i];
			if (ch === '0' || ch === '1') this.addBit(ch === '1' ? 1 : 0);
		}
	}

	addRow(): void {
		this.rows.push([]);
		this.widths.push(0);
		this.syncs.push(0);
	}

	addSync(): void {
		const row = this.rows.length - 1;
		if (this.widths[row] > 0) this.addRow();
		this.syncs[this.rows.length - 1] = (this.syncs[this.rows.length - 1] || 0) + 1;
	}

	static fromBitRows(rows: string[]): BitBuffer {
		const buf = new BitBuffer();
		buf.clear();
		buf.rows = [[]];
		buf.widths = [0];
		buf.syncs = [0];
		let first = true;
		for (const row of rows) {
			if (!row.length) continue;
			if (!first) buf.addRow();
			first = false;
			buf.addBits(row);
		}
		return buf;
	}

	clone(): BitBuffer {
		const copy = new BitBuffer();
		copy.rows = this.rows.map((row) => row.slice());
		copy.widths = this.widths.slice();
		copy.syncs = this.syncs.slice();
		return copy;
	}

	getBit(row: number, bitIndex: number): number {
		const bytes = this.rows[row];
		return (bytes[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
	}

	getByte(row: number, bitIndex: number): number {
		const bytes = this.rows[row];
		const left = bytes[bitIndex >> 3] || 0;
		const right = bytes[(bitIndex >> 3) + 1] || 0;
		return ((left << (bitIndex & 7)) | (right >> (8 - (bitIndex & 7)))) & 0xff;
	}

	extractBytes(row: number, pos: number, lenBits: number): Uint8Array {
		const out = new Uint8Array((lenBits + 7) >> 3);
		if (lenBits === 0) return out;
		if ((pos & 7) === 0) {
			const src = this.rows[row];
			for (let i = 0; i < out.length; i++) out[i] = src[(pos >> 3) + i] || 0;
		} else {
			let word = this.rows[row][pos >> 3] || 0;
			let p = pos >> 3;
			const shift = 8 - (pos & 7);
			for (let i = 0; i < out.length; i++) {
				word = ((word << 8) | (this.rows[row][++p] || 0)) & 0xffff;
				out[i] = (word >> shift) & 0xff;
			}
		}
		if (lenBits & 7) out[out.length - 1] &= (0xff00 >> (lenBits & 7)) & 0xff;
		return out;
	}

	invert(): void {
		for (let row = 0; row < this.rows.length; row++) {
			if (!this.widths[row]) continue;
			const lastCol = (this.widths[row] - 1) >> 3;
			const lastBits = ((this.widths[row] - 1) & 7) + 1;
			for (let col = 0; col <= lastCol; col++) {
				this.rows[row][col] = (~this.rows[row][col]) & 0xff;
			}
			this.rows[row][lastCol] ^= 0xff >> lastBits;
		}
	}

	nrzsDecode(): void {
		for (let row = 0; row < this.rows.length; row++) {
			if (!this.widths[row]) continue;
			let prev = 0;
			for (let col = 0; col < this.rows[row].length; col++) {
				const current = this.rows[row][col] || 0;
				const mask = ((prev << 7) | (current >> 1)) & 0xff;
				prev = current;
				this.rows[row][col] = (current ^ (~mask & 0xff)) & 0xff;
			}
			const lastBits = ((this.widths[row] - 1) & 7) + 1;
			const lastCol = (this.widths[row] - 1) >> 3;
			this.rows[row][lastCol] &= (0xff << (8 - lastBits)) & 0xff;
		}
	}

	nrzmDecode(): void {
		for (let row = 0; row < this.rows.length; row++) {
			if (!this.widths[row]) continue;
			let prev = 0;
			for (let col = 0; col < this.rows[row].length; col++) {
				const current = this.rows[row][col] || 0;
				const mask = ((prev << 7) | (current >> 1)) & 0xff;
				prev = current;
				this.rows[row][col] = (current ^ mask) & 0xff;
			}
			const lastBits = ((this.widths[row] - 1) & 7) + 1;
			const lastCol = (this.widths[row] - 1) >> 3;
			this.rows[row][lastCol] &= (0xff << (8 - lastBits)) & 0xff;
		}
	}

	search(row: number, start: number, pattern: string): number {
		const patternBits = pattern.replace(/[^01]/g, '');
		const len = this.widths[row];
		let ipos = start;
		let ppos = 0;
		while (ipos < len && ppos < patternBits.length) {
			const a = this.getBit(row, ipos);
			const b = patternBits.charCodeAt(ppos) === 49 ? 1 : 0;
			if (a === b) {
				ppos++;
				ipos++;
				if (ppos === patternBits.length) return ipos - patternBits.length;
			} else {
				ipos -= ppos;
				ipos++;
				ppos = 0;
			}
		}
		return len;
	}

	manchesterDecode(row: number, start = 0, maxBits = 0): BitBuffer {
		const out = new BitBuffer();
		out.clear();
		out.rows = [[]];
		out.widths = [0];
		out.syncs = [0];
		let len = this.widths[row];
		if (maxBits && len > start + maxBits * 2) len = start + maxBits * 2;
		let ipos = start;
		while (ipos + 1 < len) {
			const bit1 = this.getBit(row, ipos++);
			const bit2 = this.getBit(row, ipos++);
			if (bit1 === bit2) break;
			out.addBit(bit2);
		}
		return out;
	}

	differentialManchesterDecode(row: number, start = 0, maxBits = 0): BitBuffer {
		const out = new BitBuffer();
		out.clear();
		out.rows = [[]];
		out.widths = [0];
		out.syncs = [0];

		let len = this.widths[row];
		if (maxBits && len > start + maxBits * 2) len = start + maxBits * 2;
		let ipos = start;
		let bit2 = 0;

		while (ipos + 2 < len) {
			const bit1 = this.getBit(row, ipos++);
			bit2 = this.getBit(row, ipos++);
			const bit3 = this.getBit(row, ipos);
			if (bit1 !== bit2) {
				if (bit2 !== bit3) {
					out.addBit(0);
				} else {
					bit2 = bit1;
					ipos -= 1;
					break;
				}
			} else {
				bit2 = 1 - bit1;
				ipos -= 2;
				break;
			}
		}

		while (ipos + 1 < len) {
			const bit1 = this.getBit(row, ipos++);
			if (bit1 === bit2) break;
			bit2 = this.getBit(row, ipos++);
			out.addBit(bit1 === bit2 ? 1 : 0);
		}

		return out;
	}

	compareRows(rowA: number, rowB: number, maxBits = 0): boolean {
		const lenA = this.widths[rowA];
		const lenB = this.widths[rowB];
		const limit = maxBits > 0 ? Math.min(maxBits, lenA, lenB) : Math.min(lenA, lenB);
		if (maxBits === 0 && lenA !== lenB) return false;
		if (limit <= 0) return false;
		for (let i = 0; i < limit; i++) {
			if (this.getBit(rowA, i) !== this.getBit(rowB, i)) return false;
		}
		return true;
	}

	countRepeats(row: number, maxBits = 0): number {
		let count = 1;
		for (let i = row + 1; i < this.rows.length; i++) {
			if (this.compareRows(row, i, maxBits)) count++;
		}
		return count;
	}

	findRepeatedRow(minRepeats: number, minBits: number): number {
		for (let i = 0; i < this.rows.length; i++) {
			if (this.widths[i] >= minBits && this.countRepeats(i, 0) >= minRepeats) return i;
		}
		return -1;
	}

	findRepeatedPrefix(minRepeats: number, minBits: number): number {
		for (let i = 0; i < this.rows.length; i++) {
			if (this.widths[i] >= minBits && this.countRepeats(i, minBits) >= minRepeats) return i;
		}
		return -1;
	}

	rowToBitString(row: number): string {
		let out = '';
		for (let i = 0; i < this.widths[row]; i++) out += this.getBit(row, i) ? '1' : '0';
		return out;
	}

	rowToHex(row: number): string {
		const bytes = this.extractBytes(row, 0, this.widths[row]);
		return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
	}
}
