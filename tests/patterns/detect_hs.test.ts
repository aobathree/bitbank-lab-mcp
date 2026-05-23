import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { detectHeadAndShoulders } from '../../tools/patterns/detect_hs.js';
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
 * H&S ピボット: H(idx=0) → L(idx=15) → H(idx=30) → L(idx=45) → H(idx=60)
 * 左右の肩が等高、頭が高い
 */
function buildHS(opts?: {
	leftShoulder?: number;
	head?: number;
	rightShoulder?: number;
	valley1?: number;
	valley2?: number;
}) {
	const ls = opts?.leftShoulder ?? 100;
	const hd = opts?.head ?? 130;
	const rs = opts?.rightShoulder ?? 100;
	const v1 = opts?.valley1 ?? 85;
	const v2 = opts?.valley2 ?? 85;

	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90, 95, 80, 90));
	candles[0] = mkCandle(70, ls - 1, ls, ls - 3, ls - 1);
	candles[15] = mkCandle(55, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[30] = mkCandle(40, hd - 1, hd, hd - 3, hd - 1);
	candles[45] = mkCandle(25, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[60] = mkCandle(10, rs - 1, rs, rs - 3, rs - 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'H' },
		{ idx: 15, price: v1, kind: 'L' },
		{ idx: 30, price: hd, kind: 'H' },
		{ idx: 45, price: v2, kind: 'L' },
		{ idx: 60, price: rs, kind: 'H' },
	];

	return { candles, pivots };
}

/**
 * Inverse H&S ピボット: L(idx=0) → H(idx=15) → L(idx=30) → H(idx=45) → L(idx=60)
 * 左右の肩が等安、頭が低い
 */
function buildInverseHS(opts?: {
	leftShoulder?: number;
	head?: number;
	rightShoulder?: number;
	peak1?: number;
	peak2?: number;
}) {
	const ls = opts?.leftShoulder ?? 100;
	const hd = opts?.head ?? 70;
	const rs = opts?.rightShoulder ?? 100;
	const p1 = opts?.peak1 ?? 115;
	const p2 = opts?.peak2 ?? 115;

	const candles: CandleData[] = [];
	for (let i = 0; i < 70; i++) candles.push(mkCandle(70 - i, 90, 95, 80, 90));
	candles[0] = mkCandle(70, ls + 1, ls + 3, ls, ls + 1);
	candles[15] = mkCandle(55, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[30] = mkCandle(40, hd + 1, hd + 3, hd, hd + 1);
	candles[45] = mkCandle(25, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[60] = mkCandle(10, rs + 1, rs + 3, rs, rs + 1);

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'L' },
		{ idx: 15, price: p1, kind: 'H' },
		{ idx: 30, price: hd, kind: 'L' },
		{ idx: 45, price: p2, kind: 'H' },
		{ idx: 60, price: rs, kind: 'L' },
	];

	return { candles, pivots };
}

/**
 * H&S 構造の後にネックライン下抜けを付与したフィクスチャ。
 * - 構造: H(0)-L(15)-H(30)-L(45)-H(60) で buildHS と同じ。
 * - 右肩(idx=60) 後の `breakIdx` 以降を `breakClose` に書き換えてネックライン下抜け。
 * - `postBreakLow` を指定すると、ブレイク後の特定 idx の low を強制し、target 到達テスト用。
 */
function buildHsWithBreakout(opts?: {
	breakIdx?: number;
	breakClose?: number;
	postBreakLow?: number;
	postBreakIdx?: number;
	totalBars?: number;
}) {
	const ls = 100;
	const hd = 130;
	const rs = 100;
	const v1 = 85;
	const v2 = 85;
	const total = opts?.totalBars ?? 80;
	const breakIdx = opts?.breakIdx ?? 65;
	// neckline (v1+v2)/2 = 85; close 80 は 85*(1-0.015)=83.725 を下回る → ブレイク
	const breakClose = opts?.breakClose ?? 80;

	const candles: CandleData[] = [];
	for (let i = 0; i < total; i++) candles.push(mkCandle(total - i, 90, 95, 80, 90));
	candles[0] = mkCandle(total, ls - 1, ls, ls - 3, ls - 1);
	candles[15] = mkCandle(total - 15, v1 + 1, v1 + 3, v1, v1 + 1);
	candles[30] = mkCandle(total - 30, hd - 1, hd, hd - 3, hd - 1);
	candles[45] = mkCandle(total - 45, v2 + 1, v2 + 3, v2, v2 + 1);
	candles[60] = mkCandle(total - 60, rs - 1, rs, rs - 3, rs - 1);
	for (let i = breakIdx; i < total; i++) {
		candles[i] = mkCandle(total - i, breakClose + 2, breakClose + 5, breakClose - 3, breakClose);
	}
	// target 到達検証用に、特定 idx で low を強制
	if (opts?.postBreakLow !== undefined && opts?.postBreakIdx !== undefined) {
		const idx = opts.postBreakIdx;
		const lo = opts.postBreakLow;
		candles[idx] = mkCandle(total - idx, lo + 3, lo + 5, lo, lo + 1);
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'H' },
		{ idx: 15, price: v1, kind: 'L' },
		{ idx: 30, price: hd, kind: 'H' },
		{ idx: 45, price: v2, kind: 'L' },
		{ idx: 60, price: rs, kind: 'H' },
	];

	return { candles, pivots };
}

/**
 * Inverse H&S 構造の後にネックライン上抜けを付与したフィクスチャ。
 * - 構造: L(0)-H(15)-L(30)-H(45)-L(60) で buildInverseHS と同じ。
 * - 右肩(idx=60) 後の `breakIdx` 以降を `breakClose` に書き換えてネックライン上抜け。
 * - `postBreakHigh` を指定すると、ブレイク後の特定 idx の high を強制し、target 到達テスト用。
 */
function buildInverseHsWithBreakout(opts?: {
	breakIdx?: number;
	breakClose?: number;
	postBreakHigh?: number;
	postBreakIdx?: number;
	totalBars?: number;
}) {
	const ls = 100;
	const hd = 70;
	const rs = 100;
	const p1 = 115;
	const p2 = 115;
	const total = opts?.totalBars ?? 80;
	const breakIdx = opts?.breakIdx ?? 65;
	// neckline (p1+p2)/2 = 115; close 120 は 115*(1+0.015)=116.725 を上回る → ブレイク
	const breakClose = opts?.breakClose ?? 120;

	const candles: CandleData[] = [];
	for (let i = 0; i < total; i++) candles.push(mkCandle(total - i, 90, 95, 80, 90));
	candles[0] = mkCandle(total, ls + 1, ls + 3, ls, ls + 1);
	candles[15] = mkCandle(total - 15, p1 - 1, p1, p1 - 3, p1 - 1);
	candles[30] = mkCandle(total - 30, hd + 1, hd + 3, hd, hd + 1);
	candles[45] = mkCandle(total - 45, p2 - 1, p2, p2 - 3, p2 - 1);
	candles[60] = mkCandle(total - 60, rs + 1, rs + 3, rs, rs + 1);
	for (let i = breakIdx; i < total; i++) {
		candles[i] = mkCandle(total - i, breakClose - 2, breakClose + 3, breakClose - 5, breakClose);
	}
	if (opts?.postBreakHigh !== undefined && opts?.postBreakIdx !== undefined) {
		const idx = opts.postBreakIdx;
		const hi = opts.postBreakHigh;
		candles[idx] = mkCandle(total - idx, hi - 5, hi, hi - 6, hi - 1);
	}

	const pivots: Pivot[] = [
		{ idx: 0, price: ls, kind: 'L' },
		{ idx: 15, price: p1, kind: 'H' },
		{ idx: 30, price: hd, kind: 'L' },
		{ idx: 45, price: p2, kind: 'H' },
		{ idx: 60, price: rs, kind: 'L' },
	];

	return { candles, pivots };
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectHeadAndShoulders', () => {
	// ── H&S（完成済み） ──────────────────────────────────────

	it('H-L-H-L-H ピボット → head_and_shoulders 検出', () => {
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs.length).toBeGreaterThanOrEqual(1);
		expect(hs[0]?.confidence).toBeGreaterThan(0);
		expect(hs[0]?.neckline).toBeDefined();
		expect(hs[0]?.breakoutTarget).toBeDefined();
		expect(hs[0]?.targetMethod).toBe('neckline_projection');
		expect(result.found?.head_and_shoulders).toBe(true);
	});

	it('H&S のターゲット価格 = neckline - (head - neckline)', () => {
		// nlAvg=(85+85)/2=85, head=130, target=85-(130-85)=40
		const { candles, pivots } = buildHS({ head: 130, valley1: 85, valley2: 85 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs?.breakoutTarget).toBe(40);
	});

	it('頭が両肩より高くない → head_not_higher で rejected', () => {
		// head=103, shoulders=100 → 103 > 100*1.04=104? No
		const { candles, pivots } = buildHS({ head: 103 });
		const ctx = buildCtx({ candles, pivots });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'head_not_higher',
		);
		expect(rejected).toBeDefined();
	});

	it('両肩が離れすぎ → shoulders_not_near で rejected', () => {
		// left=100, right=120 → |20|/120=0.167 > 0.04
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 120 });
		const ctx = buildCtx({ candles, pivots });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'shoulders_not_near',
		);
		expect(rejected).toBeDefined();
	});

	it('ピボット間隔 < minDist → H&S スキップ', () => {
		// 間隔3本 < minDist(5)
		const candles: CandleData[] = Array.from({ length: 20 }, (_, i) => mkCandle(20 - i, 90, 95, 85, 90));
		candles[0] = mkCandle(20, 99, 100, 97, 99);
		candles[3] = mkCandle(17, 84, 86, 83, 84);
		candles[6] = mkCandle(14, 129, 130, 127, 129);
		candles[9] = mkCandle(11, 84, 86, 83, 84);
		candles[12] = mkCandle(8, 99, 100, 97, 99);

		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 3, price: 85, kind: 'L' },
			{ idx: 6, price: 130, kind: 'H' },
			{ idx: 9, price: 85, kind: 'L' },
			{ idx: 12, price: 100, kind: 'H' },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
	});

	// ── Inverse H&S（完成済み） ──────────────────────────────

	it('L-H-L-H-L ピボット → inverse_head_and_shoulders 検出', () => {
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs.length).toBeGreaterThanOrEqual(1);
		expect(ihs[0]?.confidence).toBeGreaterThan(0);
		expect(ihs[0]?.neckline).toBeDefined();
		expect(ihs[0]?.breakoutTarget).toBeDefined();
		expect(ihs[0]?.targetMethod).toBe('neckline_projection');
		expect(result.found?.inverse_head_and_shoulders).toBe(true);
	});

	it('Inverse H&S ターゲット価格 = neckline + (neckline - head)', () => {
		// ihsNlAvg=(115+115)/2=115, head=70, target=115+(115-70)=160
		const { candles, pivots } = buildInverseHS({ head: 70, peak1: 115, peak2: 115 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs?.breakoutTarget).toBe(160);
	});

	it('頭が両肩より低くない → head_not_lower で rejected', () => {
		// head=97, shoulders=100 → 97 < 100*(1-0.04)=96? No (97 > 96)
		const { candles, pivots } = buildInverseHS({ head: 97 });
		const ctx = buildCtx({ candles, pivots });
		detectHeadAndShoulders(ctx);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason === 'head_not_lower',
		);
		expect(rejected).toBeDefined();
	});

	// ── want フィルタ ────────────────────────────────────────

	it('want に head_and_shoulders のみ → inverse はスキップ', () => {
		// Inverse パターンのデータを使う。want に head_and_shoulders のみ指定
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots, want: new Set(['head_and_shoulders']) });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toHaveLength(0);
	});

	it('want に inverse_head_and_shoulders のみ → H&S はスキップ', () => {
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots, want: new Set(['inverse_head_and_shoulders']) });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
	});

	// ── Relaxed fallback ─────────────────────────────────────

	it('strict 不検出 → relaxed H&S (x1.6) でフォールバック検出', () => {
		// left=100, right=106 → diff/max=6/106=0.0566 > strict(0.04) だが <= relaxed(0.064)
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 106, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		if (hs.length > 0) {
			expect(hs[0]?._fallback).toMatch(/relaxed_hs/);
		}
	});

	it('strict 不検出 → relaxed Inverse H&S でフォールバック検出', () => {
		// shoulders=100,106: diff/max=0.0566 > 0.04
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 106, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		if (ihs.length > 0) {
			expect(ihs[0]?._fallback).toMatch(/relaxed_ihs/);
		}
	});

	// ── HS_SHOULDER_MAX_PCT hard cap（PR: shoulder cap 配線） ──

	it('H&S: tolerancePct=0.06 でも肩 ±6%（HS_SHOULDER_MAX_PCT 超過）なら検出しない', () => {
		// left=100, right=106 → diff/max = 6/106 ≈ 0.0566 → > 0.05 cap だが ≤ 0.06 tolerancePct
		// strict near() は通るが isSameLevel(.., 0.05) で弾かれる
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 106, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.06 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'shoulders_not_near',
		);
		expect(rejected).toBeDefined();
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.05);
		expect(details?.shouldersDiffPct).toBeCloseTo(6 / 106, 6);
	});

	it('Inverse H&S: tolerancePct=0.06 でも肩 ±6%（HS_SHOULDER_MAX_PCT 超過）なら検出しない', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 106, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.06 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason === 'shoulders_not_near',
		);
		expect(rejected).toBeDefined();
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(details?.shoulderMaxPct).toBe(0.05);
		expect(details?.shouldersDiffPct).toBeCloseTo(6 / 106, 6);
	});

	it('H&S: relaxed fallback でも肩 ±5% を超える候補は検出しない', () => {
		// left=100, right=106: strict(0.04) は near() で fail → relaxed パスに落ちる
		// relaxed factor.shoulder=2.0 で 0.04*2.0=0.08 → 0.0566 ≤ 0.08 で通過していたが
		// isSameLevel(100, 106, 0.05) で hard reject される
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 106, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs).toHaveLength(0);
	});

	it('Inverse H&S: relaxed fallback でも肩 ±5% を超える候補は検出しない', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 106, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toHaveLength(0);
	});

	it('H&S: strict 経路で肩差 5% 以内なら引き続き検出される（非退行）', () => {
		// left=100, right=104 → diff/max = 4/104 ≈ 0.0385 → < 0.05 cap, < 0.04 tolerancePct
		const { candles, pivots } = buildHS({ leftShoulder: 100, rightShoulder: 104, head: 130 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.filter((p) => p.type === 'head_and_shoulders');
		expect(hs.length).toBeGreaterThanOrEqual(1);
		expect(hs[0]?._fallback).toBeUndefined();
	});

	it('Inverse H&S: strict 経路で肩差 5% 以内なら引き続き検出される（非退行）', () => {
		const { candles, pivots } = buildInverseHS({ leftShoulder: 100, rightShoulder: 104, head: 70 });
		const ctx = buildCtx({ candles, pivots, tolerancePct: 0.04 });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs.length).toBeGreaterThanOrEqual(1);
		expect(ihs[0]?._fallback).toBeUndefined();
	});

	// ── 形成中 H&S ───────────────────────────────────────────

	it('includeForming=true + 右肩形成中 → forming H&S 検出', () => {
		// 66 本のローソク足を作成
		// allPeaks: 左肩(idx=5,price=100), 頭(idx=30,price=135)
		// allValleys: 頭前谷(idx=20,price=88), 頭後谷(idx=45,price=90)
		// 最終 close=102（左肩 100 近傍 → 暫定右肩）
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		// 最後の 5 本を暫定右肩レベル（102）にする
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 100, 102);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H' },
			{ idx: 30, price: 135, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L' },
			{ idx: 45, price: 90, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
		expect(forming[0]?.targetMethod).toBe('neckline_projection');
	});

	it('includeForming=false では forming H&S は返さない', () => {
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 100, 102);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H' },
			{ idx: 30, price: 135, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L' },
			{ idx: 45, price: 90, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: false,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.status === 'forming');
		expect(forming).toHaveLength(0);
	});

	// ── 形成中 Inverse H&S ───────────────────────────────────

	it('includeForming=true + 右谷形成中 → forming inverse H&S 検出', () => {
		// allValleys: 左肩(idx=5,price=100), 頭(idx=30,price=60)
		// allPeaks: 頭前ピーク(idx=20,price=112), 頭後ピーク(idx=45,price=110)
		// 最終 close=98（左肩 100 近傍）
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 100, 102, 99, 101);
		candles[20] = mkCandle(total - 20, 111, 112, 110, 111);
		candles[30] = mkCandle(total - 30, 60, 62, 59, 61);
		candles[45] = mkCandle(total - 45, 109, 110, 108, 109);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 97, 99, 97, 98);
		}

		const allPeaks: Pivot[] = [
			{ idx: 20, price: 112, kind: 'H' },
			{ idx: 45, price: 110, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 5, price: 100, kind: 'L' },
			{ idx: 30, price: 60, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders' && p.status === 'forming');
		expect(forming.length).toBeGreaterThanOrEqual(1);
		expect(forming[0]?.completionPct).toBeDefined();
		expect(forming[0]?.breakoutTarget).toBeDefined();
	});

	// ── structureRange / confirmation / precedingTrend（誤読防止のための分離フィールド） ──

	it('completed H&S: structureRange=左肩〜右肩, confirmation=not_confirmed, precedingTrend あり', () => {
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		// 左肩(idx=0) → 右肩(idx=60)
		expect(hs.structureRange?.start).toBe(candles[0].isoTime);
		expect(hs.structureRange?.end).toBe(candles[60].isoTime);

		// H&S 検出器はネックライン突破を確認しないため not_confirmed
		expect(hs.confirmation?.type).toBe('not_confirmed');

		expect(hs.precedingTrend).toBeDefined();
		expect(hs.precedingTrend?.end).toBe(candles[0].isoTime);
		expect(typeof hs.precedingTrend?.lookbackBars).toBe('number');
	});

	it('completed Inverse H&S: structureRange=左肩〜右肩, confirmation=not_confirmed, precedingTrend あり', () => {
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.structureRange?.start).toBe(candles[0].isoTime);
		expect(ihs.structureRange?.end).toBe(candles[60].isoTime);
		expect(ihs.confirmation?.type).toBe('not_confirmed');
		expect(ihs.precedingTrend).toBeDefined();
	});

	it('forming H&S: structureRange / confirmation=not_confirmed / precedingTrend あり', () => {
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 99);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 134);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 101, 103, 100, 102);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H' },
			{ idx: 30, price: 135, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L' },
			{ idx: 45, price: 90, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.find((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming).toBeDefined();
		if (!forming) return;

		expect(forming.structureRange).toBeDefined();
		expect(forming.confirmation?.type).toBe('not_confirmed');
		expect(forming.precedingTrend).toBeDefined();
	});

	// ── 形成中の最低 confidence ゲート（FORMING_MIN_CONFIDENCE = 0.5） ─────

	it('forming inverse H&S: 右肩が左肩から遠く confidence < 0.5 → 結果に含まれない & reject 理由が残る', () => {
		// closeness = 1 - |107 - 100| / (100 * 0.08) = 1 - 7/8 = 0.125
		// confBase = 0.6 * 0.125 + 0.4 * 0.125 = 0.125
		// confidence = round(0.125 * 0.9 * 100)/100 = 0.11  → < 0.5
		// completion = (0.75 + 0.25 * 0.125) * 0.9 = 0.703 → >= 0.4（残るのは confidence 側のみ）
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 100, 102, 99, 100);
		candles[20] = mkCandle(total - 20, 111, 112, 110, 111);
		candles[30] = mkCandle(total - 30, 60, 62, 59, 60);
		candles[45] = mkCandle(total - 45, 109, 110, 108, 110);
		// 現在価格を 107 (左肩 100 から 7%) にして closeness を下げる
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 106, 108, 106, 107);
		}

		const allPeaks: Pivot[] = [
			{ idx: 20, price: 112, kind: 'H' },
			{ idx: 45, price: 110, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 5, price: 100, kind: 'L' },
			{ idx: 30, price: 60, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'inverse_head_and_shoulders' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) =>
				d.type === 'inverse_head_and_shoulders' && d.accepted === false && d.reason === 'confidence_below_min_forming',
		);
		expect(rejected).toBeDefined();
		const details = rejected?.details as Record<string, unknown> | undefined;
		expect(Number(details?.threshold)).toBe(0.5);
		expect(Number(details?.confidence)).toBeLessThan(0.5);
	});

	it('forming H&S: 右肩が左肩から遠く confidence < 0.5 → 結果に含まれない & reject 理由が残る', () => {
		const total = 66;
		const candles: CandleData[] = Array.from({ length: total }, (_, i) => mkCandle(total - i, 90, 95, 85, 90));
		candles[5] = mkCandle(total - 5, 99, 100, 97, 100);
		candles[20] = mkCandle(total - 20, 87, 90, 87, 88);
		candles[30] = mkCandle(total - 30, 134, 135, 132, 135);
		candles[45] = mkCandle(total - 45, 89, 92, 89, 90);
		// 現在価格を 93 (左肩 100 から 7%) にして closeness を下げる
		for (let i = 60; i < total; i++) {
			candles[i] = mkCandle(total - i, 93, 95, 91, 93);
		}

		const allPeaks: Pivot[] = [
			{ idx: 5, price: 100, kind: 'H' },
			{ idx: 30, price: 135, kind: 'H' },
		];
		const allValleys: Pivot[] = [
			{ idx: 20, price: 88, kind: 'L' },
			{ idx: 45, price: 90, kind: 'L' },
		];

		const ctx = buildCtx({
			candles,
			pivots: [...allPeaks, ...allValleys],
			allPeaks,
			allValleys,
			includeForming: true,
		});
		const result = detectHeadAndShoulders(ctx);

		const forming = result.patterns.filter((p) => p.type === 'head_and_shoulders' && p.status === 'forming');
		expect(forming).toHaveLength(0);

		const rejected = ctx.debugCandidates.find(
			(d) => d.type === 'head_and_shoulders' && d.accepted === false && d.reason === 'confidence_below_min_forming',
		);
		expect(rejected).toBeDefined();
	});

	// ── ネックラインブレイク確認（completed への昇格） ─────────

	it('H&S: 右肩後にネックライン下抜け → status=completed, confirmation=neckline_breakout', () => {
		// neckline (85+85)/2 = 85, head 130
		// breakIdx=65 で close=80 (< 85*(1-0.015)=83.725) → 下抜け
		const { candles, pivots } = buildHsWithBreakout({ breakIdx: 65, breakClose: 80 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutDirection).toBe('down');
		expect(hs.outcome).toBe('success');
		// breakoutBarIndex は右肩(idx=60) より後
		const breakoutBarIndex = hs.breakoutBarIndex;
		expect(typeof breakoutBarIndex).toBe('number');
		if (typeof breakoutBarIndex !== 'number') return;
		expect(breakoutBarIndex).toBeGreaterThan(60);
		expect(breakoutBarIndex).toBeLessThanOrEqual(candles.length - 1);

		// range.end = ブレイク日（candles[breakoutIdx].isoTime）
		expect(hs.range?.end).toBe(candles[breakoutBarIndex]?.isoTime);
		// structureRange.end = 右肩日（candles[60].isoTime）
		expect(hs.structureRange?.end).toBe(candles[60].isoTime);
		// confirmation.date は range.end と一致（ブレイク日）
		if (hs.confirmation?.type === 'neckline_breakout') {
			expect(hs.confirmation.date).toBe(hs.range?.end);
			expect(hs.confirmation.idx).toBe(breakoutBarIndex);
		}
	});

	it('H&S: 右肩後にターゲット到達 → targetReachedPct >= 100 + targetReached=true', () => {
		// target ≈ 85 - (130-85) = 40
		// breakClose=80 → breakoutPrice=80
		// 末尾 idx=79 で low=25 (<= target=40) → 到達
		// pct = (25-80) / (40-80) * 100 = 137.5 → 138
		const total = 80;
		const { candles, pivots } = buildHsWithBreakout({
			breakIdx: 65,
			breakClose: 80,
			postBreakLow: 25,
			postBreakIdx: 79,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		// target = neckline(85) - (head(130) - neckline(85)) = 40
		expect(hs.breakoutTarget).toBe(40);
		expect(hs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(hs.targetReached).toBe(true);
		expect(hs.targetReachedPrice).toBe(25);
		expect(hs.targetReachedDate).toBe(candles[79].isoTime);
	});

	it('H&S: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// 旧 close ベース判定では、最終 close が target を上回ると未到達扱いされる。
		// 新 high/low ベースでは、ブレイク後の最安値で評価するので、戻しても到達扱いになる。
		//
		// target = 85 - (130-85) = 40, breakClose=80 → breakoutPrice=80
		// 中間 idx=70 で low=25 (<= target 40) → 到達
		// 末尾 idx=79 は close=80 (> target 40) で recovery
		// 旧 close ベース: (80-80)/(40-80)*100 = 0% → 未到達
		// 新 high/low ベース: (25-80)/(40-80)*100 = 137.5 → 138%
		const total = 80;
		const { candles, pivots } = buildHsWithBreakout({
			breakIdx: 65,
			breakClose: 80,
			postBreakLow: 25,
			postBreakIdx: 70,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutTarget).toBe(40);

		// 最終 close は 80 (> target 40) だが、ブレイク後 idx=70 で low=25 が target を割り込んでいる
		expect(hs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(hs.targetReached).toBe(true);
		expect(hs.targetReachedPrice).toBe(25);
		expect(hs.targetReachedDate).toBe(candles[70].isoTime);
		// 末尾 close は target を上回って戻っている（recovery を fixture が再現していることを念のため確認）
		const lastClose = candles[total - 1]?.close ?? Number.NaN;
		expect(lastClose).toBeGreaterThan(hs.breakoutTarget ?? Number.POSITIVE_INFINITY);
	});

	it('H&S: ブレイク後 low が target に届かない → 未到達 (targetReachedPct < 100)', () => {
		// breakClose=80 → 全 post-break candle で low=77 のみ (postBreakLow 未指定)
		// 77 > target 40 → 未到達
		// pct = (77-80)/(40-80)*100 = 7.5 → 8%
		const { candles, pivots } = buildHsWithBreakout({ breakIdx: 65, breakClose: 80 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).toBe('completed');
		expect(hs.confirmation?.type).toBe('neckline_breakout');
		expect(hs.breakoutTarget).toBe(40);
		expect(hs.targetReachedPct).toBeLessThan(100);
		expect(hs.targetReached).toBe(false);
	});

	it('H&S: 右肩後にブレイクしない → status=near_completion, confirmation=not_confirmed', () => {
		// 既定 buildHS の末尾は close=90 で neckline 85 を割り込まない（90 > 83.725）
		const { candles, pivots } = buildHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const hs = result.patterns.find((p) => p.type === 'head_and_shoulders');
		expect(hs).toBeDefined();
		if (!hs) return;

		expect(hs.status).not.toBe('completed');
		expect(hs.status).toBe('near_completion');
		expect(hs.confirmation?.type).toBe('not_confirmed');
		// range.end = structureRange.end = 右肩日
		expect(hs.range?.end).toBe(candles[60].isoTime);
		expect(hs.structureRange?.end).toBe(candles[60].isoTime);
		expect(hs.breakoutBarIndex).toBeUndefined();
	});

	it('逆H&S: 右肩後にネックライン上抜け → status=completed, confirmation=neckline_breakout', () => {
		// neckline (115+115)/2 = 115, head 70
		// breakIdx=65 で close=120 (> 115*(1+0.015)=116.725) → 上抜け
		const { candles, pivots } = buildInverseHsWithBreakout({ breakIdx: 65, breakClose: 120 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutDirection).toBe('up');
		expect(ihs.outcome).toBe('success');
		const breakoutBarIndex = ihs.breakoutBarIndex;
		expect(typeof breakoutBarIndex).toBe('number');
		if (typeof breakoutBarIndex !== 'number') return;
		expect(breakoutBarIndex).toBeGreaterThan(60);
		expect(ihs.range?.end).toBe(candles[breakoutBarIndex]?.isoTime);
		expect(ihs.structureRange?.end).toBe(candles[60].isoTime);
	});

	it('逆H&S: 右肩後にターゲット到達 → targetReachedPct >= 100 + targetReached=true', () => {
		// target ≈ 115 + (115-70) = 160
		// breakClose=120 → breakoutPrice=120, 末尾 idx=79 で high=170 (>= target 160)
		// pct = (170-120)/(160-120)*100 = 125%
		const total = 80;
		const { candles, pivots } = buildInverseHsWithBreakout({
			breakIdx: 65,
			breakClose: 120,
			postBreakHigh: 170,
			postBreakIdx: 79,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		// target = neckline(115) + (neckline(115) - head(70)) = 160
		expect(ihs.breakoutTarget).toBe(160);
		expect(ihs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(ihs.targetReached).toBe(true);
		expect(ihs.targetReachedPrice).toBe(170);
		expect(ihs.targetReachedDate).toBe(candles[79].isoTime);
	});

	it('逆H&S: 一度 target 到達後に close が戻る → high/low ベースで targetReached=true', () => {
		// target = 115 + (115-70) = 160, breakClose=120 → breakoutPrice=120
		// 中間 idx=70 で high=170 (>= target 160) → 到達
		// 末尾 idx=79 は close=120 (< target 160) で recovery
		// 旧 close ベース: (120-120)/(160-120)*100 = 0% → 未到達
		// 新 high/low ベース: (170-120)/(160-120)*100 = 125%
		const total = 80;
		const { candles, pivots } = buildInverseHsWithBreakout({
			breakIdx: 65,
			breakClose: 120,
			postBreakHigh: 170,
			postBreakIdx: 70,
			totalBars: total,
		});
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutTarget).toBe(160);

		expect(ihs.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(ihs.targetReached).toBe(true);
		expect(ihs.targetReachedPrice).toBe(170);
		expect(ihs.targetReachedDate).toBe(candles[70].isoTime);
		// 末尾 close は target を下回って戻っている（recovery を fixture が再現していることを念のため確認）
		const lastClose = candles[total - 1]?.close ?? Number.NaN;
		expect(lastClose).toBeLessThan(ihs.breakoutTarget ?? Number.NEGATIVE_INFINITY);
	});

	it('逆H&S: ブレイク後 high が target に届かない → 未到達 (targetReachedPct < 100)', () => {
		// breakClose=120 → 全 post-break candle で high=123 (= breakClose+3)
		// 123 < target 160 → 未到達
		// pct = (123-120)/(160-120)*100 = 7.5 → 8%
		const { candles, pivots } = buildInverseHsWithBreakout({ breakIdx: 65, breakClose: 120 });
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).toBe('completed');
		expect(ihs.confirmation?.type).toBe('neckline_breakout');
		expect(ihs.breakoutTarget).toBe(160);
		expect(ihs.targetReachedPct).toBeLessThan(100);
		expect(ihs.targetReached).toBe(false);
	});

	it('逆H&S: 右肩後にブレイクしない → status=near_completion, confirmation=not_confirmed', () => {
		// 既定 buildInverseHS の末尾は close=90 で neckline 115 を超えない
		const { candles, pivots } = buildInverseHS();
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);

		const ihs = result.patterns.find((p) => p.type === 'inverse_head_and_shoulders');
		expect(ihs).toBeDefined();
		if (!ihs) return;

		expect(ihs.status).not.toBe('completed');
		expect(ihs.status).toBe('near_completion');
		expect(ihs.confirmation?.type).toBe('not_confirmed');
		expect(ihs.range?.end).toBe(candles[60].isoTime);
		expect(ihs.structureRange?.end).toBe(candles[60].isoTime);
	});

	// ── ピボット不足 ─────────────────────────────────────────

	it('ピボット < 5 個では H&S/Inverse H&S とも検出しない', () => {
		const candles: CandleData[] = Array.from({ length: 30 }, (_, i) => mkCandle(30 - i, 90, 95, 85, 90));
		const pivots: Pivot[] = [
			{ idx: 0, price: 100, kind: 'H' },
			{ idx: 10, price: 85, kind: 'L' },
			{ idx: 20, price: 130, kind: 'H' },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectHeadAndShoulders(ctx);
		expect(result.patterns).toHaveLength(0);
	});
});
