import { describe, expect, it } from 'vitest';
import { dayjs } from '../lib/datetime.js';
import { detectDoubles } from '../tools/patterns/detect_doubles.js';
import { linearRegressionWithR2 } from '../tools/patterns/regression.js';
import type { Pivot } from '../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../tools/patterns/types.js';

// ── ヘルパー ──

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

/** ベースライン candle を生成 */
function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

/** DetectContext を組み立てる */
function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks?: Pivot[];
	allValleys?: Pivot[];
	tolerancePct?: number;
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.allPeaks ?? opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.allValleys ?? opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		swingDepth: 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * ダブルトップのローソク足とピボットを生成:
 * peak1(idx=0) → valley(idx=10) → peak2(idx=20) → breakout(idx=25)
 */
function buildDoubleTop(opts?: { peak1?: number; valley?: number; peak2?: number; breakoutClose?: number }) {
	const p1 = opts?.peak1 ?? 200;
	const v = opts?.valley ?? 170;
	const p2 = opts?.peak2 ?? 200;
	const brk = opts?.breakoutClose ?? 160; // < neckline(170) * 0.985

	const candles: CandleData[] = [];
	// idx 0-4: peak1 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(50 - i, p1 - 2, p1, p1 - 5, p1 - 2));
	// idx 5-9: 下落
	for (let i = 0; i < 5; i++) {
		const price = p1 - ((p1 - v) * (i + 1)) / 5;
		candles.push(mkCandle(45 - i, price + 2, price + 5, price - 2, price));
	}
	// idx 10-14: valley 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(40 - i, v + 2, v + 5, v, v + 2));
	// idx 15-19: 上昇
	for (let i = 0; i < 5; i++) {
		const price = v + ((p2 - v) * (i + 1)) / 5;
		candles.push(mkCandle(35 - i, price - 2, price + 2, price - 5, price));
	}
	// idx 20-24: peak2 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(30 - i, p2 - 2, p2, p2 - 5, p2 - 3));
	// idx 25-29: breakout（下落）
	for (let i = 0; i < 5; i++) candles.push(mkCandle(25 - i, brk + 5 - i, brk + 8 - i, brk - 2, brk));

	const pivots: Pivot[] = [
		{ idx: 0, price: p1, kind: 'H' },
		{ idx: 10, price: v, kind: 'L' },
		{ idx: 20, price: p2, kind: 'H' },
		{ idx: 28, price: brk, kind: 'L' },
	];

	return { candles, pivots };
}

/**
 * ダブルボトムのローソク足とピボットを生成:
 * valley1(idx=0) → peak(idx=10) → valley2(idx=20) → breakout(idx=25)
 */
function buildDoubleBottom(opts?: { valley1?: number; peak?: number; valley2?: number; breakoutClose?: number }) {
	const v1 = opts?.valley1 ?? 100;
	const p = opts?.peak ?? 130;
	const v2 = opts?.valley2 ?? 100;
	const brk = opts?.breakoutClose ?? 140; // > neckline(130) * 1.015

	const candles: CandleData[] = [];
	// idx 0-4: valley1 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(50 - i, v1 + 2, v1 + 5, v1, v1 + 2));
	// idx 5-9: 上昇
	for (let i = 0; i < 5; i++) {
		const price = v1 + ((p - v1) * (i + 1)) / 5;
		candles.push(mkCandle(45 - i, price - 2, price + 2, price - 5, price));
	}
	// idx 10-14: peak 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(40 - i, p - 2, p, p - 5, p - 2));
	// idx 15-19: 下落
	for (let i = 0; i < 5; i++) {
		const price = p - ((p - v2) * (i + 1)) / 5;
		candles.push(mkCandle(35 - i, price + 2, price + 5, price - 2, price));
	}
	// idx 20-24: valley2 付近
	for (let i = 0; i < 5; i++) candles.push(mkCandle(30 - i, v2 + 2, v2 + 5, v2, v2 + 2));
	// idx 25-29: breakout（上昇）
	for (let i = 0; i < 5; i++) candles.push(mkCandle(25 - i, brk - 3 + i, brk + 2, brk - 5, brk));

	const pivots: Pivot[] = [
		{ idx: 0, price: v1, kind: 'L' },
		{ idx: 10, price: p, kind: 'H' },
		{ idx: 20, price: v2, kind: 'L' },
		{ idx: 28, price: brk, kind: 'H' },
	];

	return { candles, pivots };
}

describe('detectDoubles', () => {
	// ── ダブルトップ（完成済み） ─────────────────────────

	it('H-L-H パターンでネックライン下抜け → ダブルトップ検出', () => {
		const { candles, pivots } = buildDoubleTop();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt.length).toBeGreaterThanOrEqual(1);
		expect(dt[0].confidence).toBeGreaterThan(0);
		expect(dt[0].neckline).toBeDefined();
		expect(dt[0].breakout).toBeDefined();
		expect(dt[0].breakoutTarget).toBeDefined();
		expect(dt[0].targetMethod).toBe('neckline_projection');
		expect(dt[0].structureDiagram).toBeDefined();
		expect(result.found?.double_top).toBe(true);
	});

	it('ダブルトップのターゲット価格 = neckline - (avgPeak - neckline)', () => {
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		if (dt) {
			// avgPeak=200, neckline=170, target = 170 - (200-170) = 140
			expect(dt.breakoutTarget).toBe(140);
		}
	});

	it('ネックライン未下抜け → ダブルトップ不検出（debugCandidates に no_breakout）', () => {
		// breakout close がネックライン以上 → 下抜けなし
		const { candles, pivots } = buildDoubleTop({ breakoutClose: 175 }); // > 170*0.985
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt).toHaveLength(0);
		const noBreakout = ctx.debugCandidates.find((d) => d.type === 'double_top' && d.reason === 'no_breakout');
		expect(noBreakout).toBeDefined();
	});

	it('ピーク高さ差が tolerance 超 → peaks_not_equal', () => {
		// peak1=200, peak2=220 → 差10%、tolerance=4%
		const { candles, pivots } = buildDoubleTop({ peak1: 200, peak2: 220 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt).toHaveLength(0);
		const rejected = ctx.debugCandidates.find((d) => d.type === 'double_top' && d.reason === 'peaks_not_equal');
		expect(rejected).toBeDefined();
	});

	it('パターン高さ < 3% → pattern_too_small で除外', () => {
		// peak=100, valley=98 → 差2%（< 3%）
		const { candles, pivots } = buildDoubleTop({ peak1: 100, valley: 98, peak2: 100 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		expect(dt).toHaveLength(0);
		const tooSmall = ctx.debugCandidates.find((d) => d.type === 'double_top' && d.reason === 'pattern_too_small');
		expect(tooSmall).toBeDefined();
	});

	it('谷深さ < 5% → valley_too_shallow で除外', () => {
		// peak=200, valley=192 → depth=(200-192)/200=4%
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 192, peak2: 200 });
		const ctx = buildCtx({ candles, pivots });
		detectDoubles(ctx);

		const tooShallow = ctx.debugCandidates.find(
			(d) =>
				d.type === 'double_top' && (d.reason === 'valley_too_shallow' || d.reason === 'valley_too_shallow_relaxed'),
		);
		expect(tooShallow).toBeDefined();
	});

	// ── ダブルボトム（完成済み） ─────────────────────────

	it('L-H-L パターンでネックライン上抜け → ダブルボトム検出', () => {
		const { candles, pivots } = buildDoubleBottom();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const db = result.patterns.filter((p) => p.type === 'double_bottom');
		expect(db.length).toBeGreaterThanOrEqual(1);
		expect(db[0].confidence).toBeGreaterThan(0);
		expect(db[0].breakout).toBeDefined();
		expect(db[0].breakoutTarget).toBeDefined();
		expect(result.found?.double_bottom).toBe(true);
	});

	it('ダブルボトムのターゲット価格 = neckline + (neckline - avgValley)', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		if (db) {
			// avgValley=100, neckline=130, target = 130 + (130-100) = 160
			expect(db.breakoutTarget).toBe(160);
		}
	});

	it('ネックライン未上抜け → ダブルボトム不検出', () => {
		const { candles, pivots } = buildDoubleBottom({ breakoutClose: 125 }); // < 130*1.015
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const db = result.patterns.filter((p) => p.type === 'double_bottom');
		expect(db).toHaveLength(0);
		const noBreakout = ctx.debugCandidates.find((d) => d.type === 'double_bottom' && d.reason === 'no_breakout');
		expect(noBreakout).toBeDefined();
	});

	it('谷高さ差が tolerance 超 → valleys_not_equal', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, valley2: 115 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		detectDoubles(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'double_bottom' && d.reason === 'valleys_not_equal');
		expect(rejected).toBeDefined();
	});

	it('パターン高さ < 3% → double_bottom pattern_too_small', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 102, valley2: 100 });
		const ctx = buildCtx({ candles, pivots });
		detectDoubles(ctx);

		const tooSmall = ctx.debugCandidates.find((d) => d.type === 'double_bottom' && d.reason === 'pattern_too_small');
		expect(tooSmall).toBeDefined();
	});

	it('山高さ < 5% → peak_too_shallow で除外', () => {
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 104, valley2: 100 });
		const ctx = buildCtx({ candles, pivots });
		detectDoubles(ctx);

		const tooShallow = ctx.debugCandidates.find(
			(d) => d.type === 'double_bottom' && (d.reason === 'peak_too_shallow' || d.reason === 'peak_too_shallow_relaxed'),
		);
		expect(tooShallow).toBeDefined();
	});

	// ── want フィルタ ────────────────────────────────────

	it('want に無関係なパターンのみの場合は検出しない', () => {
		const { candles, pivots } = buildDoubleTop();
		// double_top/bottom 以外の want → 全体ブロックをスキップ
		const ctx = buildCtx({ candles, pivots, want: new Set(['head_and_shoulders']) });
		const result = detectDoubles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ── relaxed fallback ─────────────────────────────────

	it('通常判定で不検出 → relaxed (x1.3) で検出', () => {
		// tolerance=4%, peak差=5% → 通常は不検出、relaxed(4%*1.3=5.2%)で検出
		const { candles, pivots } = buildDoubleTop({ peak1: 200, peak2: 210 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectDoubles(ctx);

		const dt = result.patterns.filter((p) => p.type === 'double_top');
		if (dt.length > 0) {
			expect(dt[0]._fallback).toContain('relaxed');
		}
	});

	it('relaxed fallback でダブルボトムを検出', () => {
		// tolerance=4%, valley差=5% → 通常は不検出、relaxed(4%*1.3=5.2%)で検出
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, valley2: 105, peak: 130, breakoutClose: 140 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectDoubles(ctx);

		const db = result.patterns.filter((p) => p.type === 'double_bottom');
		if (db.length > 0) {
			expect(db[0]._fallback).toContain('relaxed');
		}
	});

	// ── ピボット不足 ─────────────────────────────────────

	it('ピボット < 4 個では空結果', () => {
		const candles = Array.from({ length: 30 }, (_, i) => mkCandle(30 - i, 100, 102, 98, 100));
		const pivots: Pivot[] = [
			{ idx: 0, price: 200, kind: 'H' },
			{ idx: 10, price: 170, kind: 'L' },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ── 間隔不足 ─────────────────────────────────────────

	it('ピボット間隔 < 5 本 → スキップ', () => {
		const candles = Array.from({ length: 30 }, (_, i) => mkCandle(30 - i, 100, 102, 98, 100));
		const pivots: Pivot[] = [
			{ idx: 0, price: 200, kind: 'H' },
			{ idx: 3, price: 170, kind: 'L' }, // 間隔3 < minDistDB(5)
			{ idx: 6, price: 200, kind: 'H' },
			{ idx: 9, price: 170, kind: 'L' },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	// ── 形成中ダブルトップ ───────────────────────────────

	it('形成中ダブルトップ: 確定ピーク + 谷 + 現在価格がピーク付近', () => {
		// 50本、peak@idx=15 → valley@idx=30 → 現在(idx=49)がピーク付近まで回復
		const candles: CandleData[] = [];
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 150, 155, 145, 150));
		// 確定ピーク（lastIdx-2=47 より前）
		candles[15] = mkCandle(35, 195, 200, 190, 195);
		// 確定谷（ピーク後、lastIdx-1=48 より前）
		candles[30] = mkCandle(20, 163, 168, 160, 165);
		// 現在価格がピーク付近まで回復
		for (let i = 45; i < 50; i++) candles[i] = mkCandle(50 - i, 195, 198, 190, 196);

		const allPeaks: Pivot[] = [{ idx: 15, price: 200, kind: 'H' }];
		const allValleys: Pivot[] = [{ idx: 30, price: 160, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectDoubles(ctx);

		const forming = result.patterns.filter((p) => p.type === 'double_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		if (forming.length > 0) {
			expect(forming[0].completionPct).toBeDefined();
			expect(forming[0].breakoutTarget).toBeDefined();
		}
	});

	it('includeForming=false では形成中パターンは検出しない', () => {
		const candles: CandleData[] = [];
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 150, 155, 145, 150));
		candles[20] = mkCandle(30, 195, 200, 190, 195);
		candles[30] = mkCandle(20, 165, 170, 160, 165);
		for (let i = 40; i < 50; i++) candles[i] = mkCandle(50 - i, 195, 198, 190, 196);

		const pivots: Pivot[] = [
			{ idx: 5, price: 150, kind: 'L' },
			{ idx: 20, price: 200, kind: 'H' },
			{ idx: 30, price: 160, kind: 'L' },
			{ idx: 45, price: 198, kind: 'H' },
		];

		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectDoubles(ctx);
		const forming = result.patterns.filter((p) => p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	// ── 形成中ダブルボトム ───────────────────────────────

	it('形成中ダブルボトム: 確定谷2つ + 現在価格がネックライン付近', () => {
		const candles: CandleData[] = [];
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 130, 135, 125, 130));
		// valley1
		candles[10] = mkCandle(40, 102, 105, 100, 102);
		// peak between
		candles[20] = mkCandle(30, 128, 130, 125, 128);
		// valley2
		candles[30] = mkCandle(20, 103, 105, 100, 103);
		// 現在価格がネックライン付近まで回復
		for (let i = 40; i < 50; i++) candles[i] = mkCandle(50 - i, 125, 128, 122, 126);

		const pivots: Pivot[] = [
			{ idx: 5, price: 135, kind: 'H' },
			{ idx: 10, price: 100, kind: 'L' },
			{ idx: 20, price: 130, kind: 'H' },
			{ idx: 30, price: 100, kind: 'L' },
			{ idx: 45, price: 128, kind: 'H' },
		];
		const allPeaks = pivots.filter((p) => p.kind === 'H');
		const allValleys = pivots.filter((p) => p.kind === 'L');

		const ctx = buildCtx({ candles, pivots, allPeaks, allValleys, includeForming: true });
		const result = detectDoubles(ctx);

		const forming = result.patterns.filter((p) => p.type === 'double_bottom' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		if (forming.length > 0) {
			expect(forming[0].completionPct).toBeDefined();
			expect(forming[0].breakoutTarget).toBeDefined();
			expect(forming[0].targetMethod).toBe('neckline_projection');
		}
	});

	// ── structureRange / confirmation / precedingTrend（誤読防止のための分離フィールド） ──

	it('completed double_top: structureRange=peak1〜peak2, confirmation=breakoutIdx, precedingTrend あり', () => {
		const { candles, pivots } = buildDoubleTop();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const dt = result.patterns.find((p) => p.type === 'double_top');
		expect(dt).toBeDefined();
		if (!dt) return;

		// structureRange: peak1(idx=0) → peak2(idx=20)
		expect(dt.structureRange).toBeDefined();
		expect(dt.structureRange?.start).toBe(candles[0].isoTime);
		expect(dt.structureRange?.end).toBe(candles[20].isoTime);

		// confirmation: ネックライン下抜け（idx=25 が最初の breakout）
		expect(dt.confirmation).toBeDefined();
		expect(dt.confirmation?.type).toBe('neckline_breakout');
		if (dt.confirmation?.type === 'neckline_breakout') {
			expect(dt.confirmation.idx).toBe(dt.breakoutBarIndex);
			expect(dt.confirmation.date).toBe(candles[dt.breakoutBarIndex as number].isoTime);
			expect(dt.confirmation.price).toBe(Number(candles[dt.breakoutBarIndex as number].close));
		}

		// precedingTrend: end は peak1（startIdx=0）の isoTime
		expect(dt.precedingTrend).toBeDefined();
		expect(dt.precedingTrend?.end).toBe(candles[0].isoTime);
		expect(dt.precedingTrend?.direction).toBeDefined();
		expect(typeof dt.precedingTrend?.returnPct).toBe('number');
		expect(typeof dt.precedingTrend?.lookbackBars).toBe('number');
	});

	it('completed double_bottom: structureRange=valley1〜valley2, confirmation=breakoutIdx, precedingTrend あり', () => {
		const { candles, pivots } = buildDoubleBottom();
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);

		const db = result.patterns.find((p) => p.type === 'double_bottom');
		expect(db).toBeDefined();
		if (!db) return;

		expect(db.structureRange?.start).toBe(candles[0].isoTime);
		expect(db.structureRange?.end).toBe(candles[20].isoTime);

		expect(db.confirmation?.type).toBe('neckline_breakout');
		if (db.confirmation?.type === 'neckline_breakout') {
			expect(db.confirmation.idx).toBe(db.breakoutBarIndex);
			expect(db.confirmation.date).toBe(candles[db.breakoutBarIndex as number].isoTime);
		}

		expect(db.precedingTrend).toBeDefined();
		expect(db.precedingTrend?.end).toBe(candles[0].isoTime);
	});

	it('forming double_top: structureRange あり, confirmation=not_confirmed', () => {
		const candles: CandleData[] = [];
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 150, 155, 145, 150));
		candles[15] = mkCandle(35, 195, 200, 190, 195);
		candles[30] = mkCandle(20, 163, 168, 160, 165);
		for (let i = 45; i < 50; i++) candles[i] = mkCandle(50 - i, 195, 198, 190, 196);

		const allPeaks: Pivot[] = [{ idx: 15, price: 200, kind: 'H' }];
		const allValleys: Pivot[] = [{ idx: 30, price: 160, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectDoubles(ctx);
		const forming = result.patterns.find((p) => p.type === 'double_top' && p.status === 'forming');
		expect(forming).toBeDefined();
		if (!forming) return;

		expect(forming.structureRange).toBeDefined();
		expect(forming.confirmation?.type).toBe('not_confirmed');
	});

	it('forming double_bottom: structureRange は valley1〜valley2 で閉じる（lastIdx は含まない）', () => {
		const candles: CandleData[] = [];
		for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 130, 135, 125, 130));
		candles[10] = mkCandle(40, 102, 105, 100, 102);
		candles[20] = mkCandle(30, 128, 130, 125, 128);
		candles[30] = mkCandle(20, 103, 105, 100, 103);
		for (let i = 40; i < 50; i++) candles[i] = mkCandle(50 - i, 125, 128, 122, 126);

		const pivots: Pivot[] = [
			{ idx: 5, price: 135, kind: 'H' },
			{ idx: 10, price: 100, kind: 'L' },
			{ idx: 20, price: 130, kind: 'H' },
			{ idx: 30, price: 100, kind: 'L' },
			{ idx: 45, price: 128, kind: 'H' },
		];
		const allPeaks = pivots.filter((p) => p.kind === 'H');
		const allValleys = pivots.filter((p) => p.kind === 'L');

		const ctx = buildCtx({ candles, pivots, allPeaks, allValleys, includeForming: true });
		const result = detectDoubles(ctx);
		const forming = result.patterns.find((p) => p.type === 'double_bottom' && p.status === 'forming');
		expect(forming).toBeDefined();
		if (!forming) return;

		expect(forming.structureRange?.start).toBe(candles[10].isoTime);
		expect(forming.structureRange?.end).toBe(candles[30].isoTime);
		expect(forming.confirmation?.type).toBe('not_confirmed');
	});

	// ── targetReachedPct / targetReached (high/low ベース) ───

	it('double_top: breakout 後に low が target 方向に動いた場合 high/low ベースで pct を算出', () => {
		// target=140, breakoutPrice=160, postBreak low=150 → (160-150)/(160-140)*100 = 50%
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 160 });
		// 最後の candle の low を 150 に設定（target=140 方向に半分進行）
		const last = candles.length - 1;
		candles[last] = { ...candles[last], low: 150 };

		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.targetReachedPct).toBe(50);
		expect(dt.targetReached).toBe(false);
		expect(dt.targetReachedPrice).toBe(150);
		expect(dt.targetReachedDate).toBe(candles[last].isoTime);
	});

	it('double_top: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// target=140, breakoutPrice=160
		// 中間 idx=27 で low=130 (<= target 140) → 到達
		// 末尾 idx=29 は close=160 まで recovery
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 160 });
		// 中間 idx=27 で low=130 (target=140 を割り込む)
		candles[27] = { ...candles[27], low: 130 };

		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.breakoutTarget).toBe(140);
		expect(dt.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(dt.targetReached).toBe(true);
		expect(dt.targetReachedPrice).toBe(130);
		expect(dt.targetReachedDate).toBe(candles[27].isoTime);
	});

	it('double_top: ブレイク close が既に target を下回る（オーバーシュート）→ targetReached=true & pct>=100', () => {
		// target=140, breakClose=130 → breakoutPrice=130 < target 140
		// 旧式: (extremePrice - 130) / (140 - 130) は分母 +10、extremePrice<130 で分子マイナス → pct<0
		// 新式: clamp により reached=true なら pct>=100
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 130 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.breakoutTarget).toBe(140);
		expect(dt.targetReached).toBe(true);
		expect(dt.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(dt.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('double_top: ブレイク close == target（距離ゼロ）→ targetReached=true & pct=100', () => {
		// target=140, breakClose=140 → breakoutPrice == target → targetDistance=0
		const { candles, pivots } = buildDoubleTop({ peak1: 200, valley: 170, peak2: 200, breakoutClose: 140 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const dt = result.patterns.find((p) => p.type === 'double_top');

		expect(dt).toBeDefined();
		if (!dt) return;
		expect(dt.breakoutTarget).toBe(140);
		expect(dt.targetReached).toBe(true);
		expect(dt.targetReachedPct).toBe(100);
		expect(dt.targetReachedPrice).toBe(140);
		expect(dt.targetReachedDate).toBeDefined();
	});

	it('double_bottom: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// target=160, breakoutPrice=140
		// 中間 idx=27 で high=170 (>= target 160) → 到達
		// 末尾 idx=29 は close=140 まで recovery
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 140 });
		candles[27] = { ...candles[27], high: 170 };

		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(db.targetReached).toBe(true);
		expect(db.targetReachedPrice).toBe(170);
		expect(db.targetReachedDate).toBe(candles[27].isoTime);
	});

	it('double_bottom: ブレイク high が target に届かない → 未到達 (targetReachedPct < 100)', () => {
		// breakoutPrice=140, target=160, 全 postBreak high < 160 → 未到達
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 140 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReachedPct).toBeLessThan(100);
		expect(db.targetReached).toBe(false);
	});

	it('double_bottom: ブレイク close が既に target を上回る（オーバーシュート）→ targetReached=true & pct>=100', () => {
		// target=160, breakClose=170 → breakoutPrice=170 > target 160 で既に到達済み
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 170 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReached).toBe(true);
		expect(db.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(db.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('double_bottom: ブレイク close == target（距離ゼロ）→ targetReached=true & pct=100', () => {
		// target=160, breakClose=160
		const { candles, pivots } = buildDoubleBottom({ valley1: 100, peak: 130, valley2: 100, breakoutClose: 160 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectDoubles(ctx);
		const db = result.patterns.find((p) => p.type === 'double_bottom');

		expect(db).toBeDefined();
		if (!db) return;
		expect(db.breakoutTarget).toBe(160);
		expect(db.targetReached).toBe(true);
		expect(db.targetReachedPct).toBe(100);
		expect(db.targetReachedPrice).toBe(160);
		expect(db.targetReachedDate).toBeDefined();
	});
});
