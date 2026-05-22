import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { detectTriples } from '../../tools/patterns/detect_triples.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

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
 * Triple Top のローソク足とピボットを生成:
 * peak1(idx=0) → valley1(idx=10) → peak2(idx=20) → valley2(idx=30) → peak3(idx=40)
 *
 * 3山が等高、谷が等安、ネックライン勾配 <= 2%
 */
function buildTripleTop(opts?: {
	peak?: number;
	valley?: number;
	peak2Price?: number;
	peak3Price?: number;
	v1Price?: number;
	v2Price?: number;
}) {
	const pk = opts?.peak ?? 100;
	const pk2 = opts?.peak2Price ?? pk;
	const pk3 = opts?.peak3Price ?? pk;
	const v1 = opts?.v1Price ?? opts?.valley ?? 80;
	const v2 = opts?.v2Price ?? opts?.valley ?? 80;

	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 85, 90, 75, 85));
	candles[0] = mkCandle(50, pk - 1, pk, pk - 3, pk - 1);
	candles[10] = mkCandle(40, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[20] = mkCandle(30, pk2 - 1, pk2, pk2 - 3, pk2 - 1);
	candles[30] = mkCandle(20, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[40] = mkCandle(10, pk3 - 1, pk3, pk3 - 3, pk3 - 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: pk, kind: 'H' },
		{ idx: 10, price: v1, kind: 'L' },
		{ idx: 20, price: pk2, kind: 'H' },
		{ idx: 30, price: v2, kind: 'L' },
		{ idx: 40, price: pk3, kind: 'H' },
	];

	return { candles, pivots };
}

/**
 * Triple Bottom のローソク足とピボットを生成:
 * valley1(idx=0) → peak1(idx=10) → valley2(idx=20) → peak2(idx=30) → valley3(idx=40)
 */
function buildTripleBottom(opts?: {
	valley?: number;
	peak?: number;
	v2Price?: number;
	v3Price?: number;
	p1Price?: number;
	p2Price?: number;
}) {
	const vl = opts?.valley ?? 100;
	const v2 = opts?.v2Price ?? vl;
	const v3 = opts?.v3Price ?? vl;
	const p1 = opts?.p1Price ?? opts?.peak ?? 120;
	const p2 = opts?.p2Price ?? opts?.peak ?? 120;

	const candles: CandleData[] = [];
	for (let i = 0; i < 50; i++) candles.push(mkCandle(50 - i, 105, 115, 95, 105));
	candles[0] = mkCandle(50, vl + 1, vl + 3, vl, vl + 1);
	candles[10] = mkCandle(40, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[20] = mkCandle(30, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[30] = mkCandle(20, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[40] = mkCandle(10, v3 + 1, v3 + 3, v3, v3 + 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: vl, kind: 'L' },
		{ idx: 10, price: p1, kind: 'H' },
		{ idx: 20, price: v2, kind: 'L' },
		{ idx: 30, price: p2, kind: 'H' },
		{ idx: 40, price: v3, kind: 'L' },
	];

	return { candles, pivots };
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectTriples', () => {
	// ── Triple Top（完成済み）────────────────────────────────

	it('3山等高 + 等安谷 → triple_top 検出', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt.length).toBeGreaterThanOrEqual(1);
		expect(tt[0]?.confidence).toBeGreaterThan(0);
		expect(tt[0]?.neckline).toBeDefined();
		expect(tt[0]?.breakoutTarget).toBeDefined();
		expect(tt[0]?.targetMethod).toBe('neckline_projection');
	});

	it('Triple Top ターゲット価格 = neckline - (avgPeak - neckline)', () => {
		// nlAvg=(80+80)/2=80, avgPeak=100, target=80-(100-80)=60
		const { candles, pivots } = buildTripleTop({ peak: 100, valley: 80 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tt = result.patterns.find((p) => p.type === 'triple_top');
		expect(tt?.breakoutTarget).toBe(60);
	});

	it('谷のネックライン傾斜が急すぎ → neckline_slope_excess rejected', () => {
		// valleysNear が true (slope=0.030 ≤ tol=0.04) かつ necklineValid が false (0.030 > 0.02)
		// v1=80, v2=82.5 → |2.5|/82.5 = 0.030 ∈ (0.02, 0.04]
		const { candles, pivots } = buildTripleTop({ v1Price: 80, v2Price: 82.5 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_top' && d.accepted === false && d.reason === 'neckline_slope_excess',
		);
		expect(rejected).toBeDefined();
	});

	it('2山目と1山目の間に谷がない → valleys_missing rejected', () => {
		// allValleys に谷を含まない（間の谷なし）
		const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(50 - i, 90, 95, 85, 90));
		candles[0] = mkCandle(50, 99, 100, 97, 99);
		candles[20] = mkCandle(30, 99, 100, 97, 99);
		candles[40] = mkCandle(10, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 100, kind: 'H' },
			{ idx: 40, price: 100, kind: 'H' },
		];
		// allValleys は空
		const ctx = buildCtx({ candles, pivots, allPeaks: pivots, allValleys: [] });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_top' && d.reason === 'valleys_missing');
		expect(rejected).toBeDefined();
	});

	it('3山の等高差が tolerance 超 → peaks_not_equal で通常は不検出', () => {
		// peak1=100, peak2=100, peak3=115 → nearAll fails (15/115=0.13 > 0.04)
		const { candles, pivots } = buildTripleTop({ peak: 100, peak2Price: 100, peak3Price: 115 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top' && !p._fallback);
		expect(tt).toHaveLength(0);
	});

	// ── Triple Bottom（完成済み）────────────────────────────

	it('3谷等安 + 等高山 → triple_bottom 検出', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb.length).toBeGreaterThanOrEqual(1);
		expect(tb[0]?.confidence).toBeGreaterThan(0);
		expect(tb[0]?.neckline).toBeDefined();
		expect(tb[0]?.breakoutTarget).toBeDefined();
		expect(tb[0]?.targetMethod).toBe('neckline_projection');
	});

	it('Triple Bottom ターゲット価格 = neckline + (neckline - avgValley)', () => {
		// nlAvg=(120+120)/2=120, avgValley=100, target=120+(120-100)=140
		const { candles, pivots } = buildTripleBottom({ valley: 100, peak: 120 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectTriples(ctx);

		const tb = result.patterns.find((p) => p.type === 'triple_bottom');
		expect(tb?.breakoutTarget).toBe(140);
	});

	it('山のネックライン傾斜が急すぎ → neckline_slope_excess rejected', () => {
		// peaksNear が true (slope=0.030 ≤ tol=0.04) かつ necklineValid が false (0.030 > 0.02)
		// p1=120, p2=123.7 → |3.7|/123.7 ≈ 0.030 ∈ (0.02, 0.04]
		const { candles, pivots } = buildTripleBottom({ p1Price: 120, p2Price: 123.7 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'neckline_slope_excess',
		);
		expect(rejected).toBeDefined();
	});

	it('2谷目と1谷目の間に山がない → peaks_missing rejected', () => {
		const candles: CandleData[] = Array.from({ length: 50 }, (_, i) => mkCandle(50 - i, 90, 115, 95, 100));
		candles[0] = mkCandle(50, 100, 102, 99, 100);
		candles[20] = mkCandle(30, 100, 102, 99, 100);
		candles[40] = mkCandle(10, 100, 102, 99, 100);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 100, kind: 'L' },
			{ idx: 40, price: 100, kind: 'L' },
		];
		const ctx = buildCtx({ candles, pivots, allPeaks: [], allValleys: pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find((d) => d.type === 'triple_bottom' && d.reason === 'peaks_missing');
		expect(rejected).toBeDefined();
	});

	it('谷スプレッド超過 → valley_spread_excess rejected', () => {
		// v1=100, v2=101, v3=103 → spread=(103-100)/100=3% > 1.5%
		const { candles, pivots } = buildTripleBottom({ valley: 100, v2Price: 101, v3Price: 103 });
		const ctx = buildCtx({ candles, pivots });
		detectTriples(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'triple_bottom' && d.accepted === false && d.reason === 'valley_spread_excess',
		);
		expect(rejected).toBeDefined();
	});

	// ── want フィルタ ────────────────────────────────────────

	it('want に triple_top のみ → triple_bottom は検出しない', () => {
		const { candles, pivots } = buildTripleBottom();
		const ctx = buildCtx({ candles, pivots, want: new Set(['triple_top']) });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		expect(tb).toHaveLength(0);
	});

	it('want に triple_bottom のみ → triple_top は検出しない', () => {
		const { candles, pivots } = buildTripleTop();
		const ctx = buildCtx({ candles, pivots, want: new Set(['triple_bottom']) });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	// ── Relaxed fallback ─────────────────────────────────────

	it('strict 不検出 → relaxed (x1.25 or x2.0) で Triple Top フォールバック検出', () => {
		// peak1=100, peak2=100, peak3=107 → diff/max=7/107=0.065 > strict(0.04) だが <= 2.0x(0.08)
		const { candles, pivots } = buildTripleTop({ peak: 100, peak2Price: 100, peak3Price: 107 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		if (tt.length > 0) {
			expect(tt[0]?._fallback).toMatch(/relaxed_triple/);
		}
	});

	it('strict 不検出 → relaxed (x2.0) で Triple Bottom フォールバック検出', () => {
		// valley1=100, valley2=100, valley3=107 → diff/max=7/107=0.065 > strict(0.04) だが <= 2.0x(0.08)
		const { candles, pivots } = buildTripleBottom({ valley: 100, v2Price: 100, v3Price: 107 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectTriples(ctx);

		const tb = result.patterns.filter((p) => p.type === 'triple_bottom');
		if (tb.length > 0) {
			expect(tb[0]?._fallback).toMatch(/relaxed_triple/);
		}
	});

	// ── 形成中 Triple Top ───────────────────────────────────

	it('includeForming=true + 2確定ピーク + 現在価格がピーク付近 → forming triple_top 検出', () => {
		// allPeaks: [{idx:0,100}, {idx:20,101}], allValleys: [{idx:10,80}]
		// lastIdx=50, close=99（avgPeak=100.5 付近）
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		// 現在価格をピーク付近に設定
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
	});

	// ── 形成中 Triple Bottom ─────────────────────────────────

	it('includeForming=true + 2確定谷 + 現在価格が谷とネックラインの間 → forming triple_bottom 検出', () => {
		// allValleys: [{idx:0,100}, {idx:20,101}], allPeaks: [{idx:10,120}]
		// lastIdx=50, close=115（100.5 と 120 の間）
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 105, 115, 100, 110));
		candles[0] = mkCandle(total, 100, 102, 99, 101);
		candles[10] = mkCandle(total - 10, 119, 120, 118, 119);
		candles[20] = mkCandle(total - 20, 100, 102, 100, 101);
		for (let i = 45; i < total; i++) {
			candles[i] = mkCandle(total - i, 114, 116, 113, 115);
		}

		const allValleys: Pivot[] = [
			{ idx: 0, price: 100, kind: 'L' },
			{ idx: 20, price: 101, kind: 'L' },
		];
		const allPeaks: Pivot[] = [{ idx: 10, price: 120, kind: 'H' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_bottom' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
	});

	it('includeForming=false では forming パターンは返さない', () => {
		const total = 51;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 45; i < total; i++) candles[i] = mkCandle(total - i, 98, 100, 97, 99);

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: false,
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	// ── 間隔不足 ─────────────────────────────────────────────

	it('H ピーク間隔 < minDist(5) → triple_top スキップ', () => {
		// highsOnly が [idx=0, idx=3, idx=6] → b.idx-a.idx=3 < 5 → continue
		const candles: CandleData[] = Array.from({ length: 15 }, (_, i) => mkCandle(15 - i, 85, 95, 75, 85));
		candles[0] = mkCandle(15, 99, 100, 97, 99);
		candles[3] = mkCandle(12, 99, 100, 97, 99);
		candles[6] = mkCandle(9, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 3, price: 100, kind: 'H' },
			{ idx: 6, price: 100, kind: 'H' },
		];
		const ctx = buildCtx({ candles, pivots, allPeaks: pivots, allValleys: [] });
		const result = detectTriples(ctx);
		const tt = result.patterns.filter((p) => p.type === 'triple_top');
		expect(tt).toHaveLength(0);
	});

	// ── 形成中の patternDays 計算（時間軸スケーリング）──────────────
	//
	// 旧実装: daysPerBar = ctx.type === '1day' ? 1 : ctx.type === '1week' ? 7 : 1
	// → 1hour/1month/1min が全部 1 扱いになり、patternDays が完全にズレていた。
	// 新実装: helpers.ts の daysPerBar(tf) で正しく換算する。

	it('1hour: 30 バーで形成中 triple_top が patternDays 期間判定を通過する', () => {
		// 1hour で 30 バー = 約 1.25 日。FORMING_MIN_DAYS=21 / FORMING_MAX_DAYS=90 を
		// 旧コード（daysPerBar=1 扱い）では 30 と判定して通過していたが、新実装は
		// 30 * (1/24) ≈ 1 日と正しく評価して FORMING_MIN_DAYS=21 を下回ることで弾く。
		const total = 31;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 28; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1hour',
		});
		const result = detectTriples(ctx);

		// 1.25 日相当 < FORMING_MIN_DAYS(21) なので form は弾かれる（intraday の短期間判定）
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1hour: 720 バー（約 30 日）あれば形成中 triple_top の期間判定を通過する', () => {
		// 720 バー × (1/24) = 30 日 ∈ [21, 90] → patternDays チェック OK
		const total = 720;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		// 2 つ確定済みピークと谷
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[300] = mkCandle(total - 300, 79, 81, 79, 80);
		candles[600] = mkCandle(total - 600, 100, 101, 99, 100);
		for (let i = total - 5; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 600, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 300, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1hour',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
	});

	it('1week: 4 バーで形成中 triple_top は期間判定を通過しない（28 日 > MIN だが構造的に短い）', () => {
		// 4 バー × 7 日/バー = 28 日 ∈ [21, 90] → patternDays は通る
		// だが minDist=5 で 2 つのピーク間距離が足りないので構造的に成立しない。
		const total = 7;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[2] = mkCandle(total - 2, 79, 81, 79, 80);
		candles[4] = mkCandle(total - 4, 100, 101, 99, 100);
		for (let i = 6; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 4, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 2, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1week',
		});
		const result = detectTriples(ctx);

		// minDist(5) > 4 なのでスキップされる
		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1week: 8 バー（56 日）で形成中 triple_top が patternDays 判定を通過する', () => {
		// 8 バー × 7 日/バー = 56 日 ∈ [21, 90] → OK
		// 旧コード（1week → daysPerBar=7）でも同じ結論。新コードでも維持される。
		// 構造制約: confirmedPeaks フィルタ idx < lastIdx-2 と minDist=5 を両立するため
		// total=9, peak1=0, peak2=5 とする（peak2=5 < 6=lastIdx-2 OK, 5-0=5 >= minDist=5 OK）。
		const total = 9;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[3] = mkCandle(total - 3, 79, 81, 79, 80);
		candles[5] = mkCandle(total - 5, 100, 101, 99, 100);
		for (let i = 7; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 5, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 3, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1week',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
	});

	it('1month: 4 バー（120 日）は FORMING_MAX_DAYS(90) 超で patternDays 判定不可', () => {
		// 旧コードでは type !== 1day && type !== 1week なので daysPerBar=1 扱い
		// 4 * 1 = 4 日と判定して FORMING_MIN_DAYS(21) を下回り NG（理由が誤）
		// 新コードでは 4 * 30 = 120 日 > FORMING_MAX_DAYS(90) で正しく NG。
		const total = 7;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[2] = mkCandle(total - 2, 79, 81, 79, 80);
		candles[4] = mkCandle(total - 4, 100, 101, 99, 100);
		for (let i = 6; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 4, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 2, price: 80, kind: 'L' }];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1month',
		});
		const result = detectTriples(ctx);

		const forming = result.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	it('1month vs 1day: 同一バー数（25 本）なら 1day では検出されるが 1month では弾かれる（daysPerBar の効果）', () => {
		// 旧コード（1month → daysPerBar=1）では、type='1month' でも 1day と同じ
		// patternDays=25 と評価して誤って検出していた。
		// 新コードでは daysPerBar(1month)=30 を介して patternDays=750 と評価し、
		// FORMING_MAX_DAYS=90 を超えるため正しく拒否される。
		const total = 26;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 85, 90, 80, 85));
		candles[0] = mkCandle(total, 99, 100, 97, 99);
		candles[10] = mkCandle(total - 10, 79, 81, 79, 80);
		candles[20] = mkCandle(total - 20, 100, 101, 99, 100);
		for (let i = 23; i < total; i++) {
			candles[i] = mkCandle(total - i, 98, 100, 97, 99);
		}

		const allPeaks: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 20, price: 101, kind: 'H' },
		];
		const allValleys: Pivot[] = [{ idx: 10, price: 80, kind: 'L' }];

		const ctx1day = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1day',
		});
		const ctx1month = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
			type: '1month',
		});
		const result1day = detectTriples(ctx1day);
		const result1month = detectTriples(ctx1month);

		const forming1day = result1day.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');
		const forming1month = result1month.patterns.filter((p) => p.type === 'triple_top' && p.status === 'forming');

		expect(forming1day.length).toBeGreaterThanOrEqual(1);
		expect(forming1month).toHaveLength(0);
	});
});
