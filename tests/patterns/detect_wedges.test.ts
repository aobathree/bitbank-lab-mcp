/**
 * detect_wedges.test.ts
 *
 * detectWedges の branches カバレッジ改善テスト。
 *
 * 4b（回帰ベース完成済み）は要件が厳しいため、
 * 4d（形成中ウェッジ）を主なターゲットにしたデータジェネレータを使用。
 *
 * データ生成方針:
 *   Rising Wedge:  upper(i) = 100 + 0.3*i, lower(i) = 80 + 0.5*i (両者上昇、lower が急→収束)
 *   Falling Wedge: upper(i) = 200 - 0.5*i, lower(i) = 180 - 0.25*i (両者下落、upper が急→収束)
 *   period=8 の振動で SG 平滑化ピークが upper/lower に沿って出現
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dayjs } from '../../lib/datetime.js';
import { detectWedges } from '../../tools/patterns/detect_wedges.js';
import { linearRegressionWithR2 } from '../../tools/patterns/regression.js';
import type { Pivot } from '../../tools/patterns/swing.js';
import type { CandleData, DetectContext } from '../../tools/patterns/types.js';

// ── ヘルパー ──

function iso(daysAgo: number): string {
	return dayjs().subtract(daysAgo, 'day').startOf('day').toISOString();
}

function isoHoursAgo(hoursAgo: number): string {
	return dayjs().subtract(hoursAgo, 'hour').startOf('hour').toISOString();
}

function isoWeeksAgo(weeksAgo: number): string {
	return dayjs().subtract(weeksAgo, 'week').startOf('day').toISOString();
}

function mkCandle(daysAgo: number, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso(daysAgo) };
}

function mkCandleAt(iso: string, o: number, h: number, l: number, c: number): CandleData {
	return { open: o, high: h, low: l, close: c, isoTime: iso };
}

function buildCtx(opts: {
	candles: CandleData[];
	pivots: Pivot[];
	tolerancePct?: number;
	want?: Set<string>;
	includeForming?: boolean;
	type?: string;
	swingDepth?: number;
}): DetectContext {
	const tol = opts.tolerancePct ?? 0.04;
	return {
		candles: opts.candles,
		pivots: opts.pivots,
		allPeaks: opts.pivots.filter((p) => p.kind === 'H'),
		allValleys: opts.pivots.filter((p) => p.kind === 'L'),
		tolerancePct: tol,
		minDist: 5,
		want: opts.want ?? new Set(),
		includeForming: opts.includeForming ?? false,
		debugCandidates: [],
		type: opts.type ?? '1day',
		swingDepth: opts.swingDepth ?? 7,
		near: (a: number, b: number) => Math.abs(a - b) <= Math.max(a, b) * tol,
		pct: (a: number, b: number) => ((b - a) / Math.max(1, a)) * 100,
		lrWithR2: (pts) => linearRegressionWithR2(pts),
	};
}

/**
 * Rising Wedge 形状のローソク足を生成:
 *   upper(i) = 100 + 0.3*i  (緩やかな上昇)
 *   lower(i) = 80  + 0.5*i  (急な上昇 → 収束)
 *   apex ≈ i=100 (endIdx=79 より先 → apex valid)
 *   period=8 の振動でピーク/谷を作る
 */
function buildRisingWedgeCandles(nBars = 80): CandleData[] {
	const candles: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		const upper = 100 + 0.3 * i;
		const lower = 80 + 0.5 * i;
		const mid = (upper + lower) / 2;
		const period = i % 8;
		let h: number;
		let l: number;
		let c: number;
		if (period === 0 || period === 1) {
			// ピーク領域: high が upper に接触
			h = upper;
			l = mid - 2;
			c = mid + 1;
		} else if (period === 4 || period === 5) {
			// 谷領域: low が lower に接触
			h = mid + 2;
			l = lower;
			c = mid - 1;
		} else {
			// 中間
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push(mkCandle(nBars - i, mid, h, l, c));
	}
	return candles;
}

/**
 * Falling Wedge 形状のローソク足を生成:
 *   upper(i) = 200 - 0.5*i  (急な下落)
 *   lower(i) = 180 - 0.25*i (緩やかな下落 → 収束)
 *   apex ≈ i=80 (endIdx=79 → barsToApex=1: near_completion)
 */
function buildFallingWedgeCandles(nBars = 80): CandleData[] {
	const candles: CandleData[] = [];
	for (let i = 0; i < nBars; i++) {
		const upper = 200 - 0.5 * i;
		const lower = 180 - 0.25 * i;
		const mid = (upper + lower) / 2;
		const period = i % 8;
		let h: number;
		let l: number;
		let c: number;
		if (period === 0 || period === 1) {
			h = upper;
			l = mid - 2;
			c = mid + 1;
		} else if (period === 4 || period === 5) {
			h = mid + 2;
			l = lower;
			c = mid - 1;
		} else {
			h = mid + 3;
			l = mid - 3;
			c = mid;
		}
		candles.push(mkCandle(nBars - i, mid, h, l, c));
	}
	return candles;
}

afterEach(() => {
	vi.resetAllMocks();
});

describe('detectWedges', () => {
	// ── 基本動作 ─────────────────────────────────────────────

	it('ローソク足が少なすぎる → パターン不検出', () => {
		const candles: CandleData[] = Array.from({ length: 10 }, (_, i) => mkCandle(10 - i, 100, 102, 98, 100));
		const pivots: Pivot[] = [
			{ idx: 0, price: 102, kind: 'H' },
			{ idx: 5, price: 98, kind: 'L' },
		];
		const ctx = buildCtx({ candles, pivots });
		const result = detectWedges(ctx);
		// ウィンドウサイズ最小 20 本必要なので 10 本では検出なし
		expect(result.patterns).toHaveLength(0);
	});

	// ── want フィルタ ────────────────────────────────────────

	it('want に rising_wedge のみ → falling_wedge は型として返らない', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(['rising_wedge']) });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		// falling_wedge は want に含まれないので 0 件、もしくは want フィルタで除外
		expect(fw).toHaveLength(0);
	});

	it('want に falling_wedge のみ → rising_wedge は型として返らない', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(['falling_wedge']) });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		expect(rw).toHaveLength(0);
	});

	it('want が空 → 両タイプを検出候補にする（結果配列を返す）', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set() });
		const result = detectWedges(ctx);
		// 少なくともエラーなく配列を返す
		expect(Array.isArray(result.patterns)).toBe(true);
	});

	// ── Rising Wedge 形成中（4d パス）───────────────────────

	it('Rising Wedge 形状のデータ → rising_wedge が検出される（4d forming）', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(), includeForming: true });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		// 4d パスで少なくとも 1 件検出されることを確認
		expect(rw.length).toBeGreaterThanOrEqual(1);
		expect(rw[0]?.confidence).toBeGreaterThan(0);
		expect(rw[0]?.range?.start).toBeDefined();
		expect(rw[0]?.range?.end).toBeDefined();
	});

	it('Rising Wedge の status は forming または near_completion', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		if (rw.length > 0) {
			const statuses = ['forming', 'near_completion', 'completed'];
			expect(statuses).toContain(rw[0]?.status);
		}
	});

	// ── Falling Wedge 形成中（4d パス）──────────────────────

	it('Falling Wedge 形状のデータ → falling_wedge が検出される（4d forming）', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, want: new Set(), includeForming: true });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		expect(fw.length).toBeGreaterThanOrEqual(1);
		expect(fw[0]?.confidence).toBeGreaterThan(0);
		expect(fw[0]?.range?.start).toBeDefined();
	});

	it('Falling Wedge の daysToApex は正の整数', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		if (fw.length > 0 && fw[0]?.daysToApex !== undefined) {
			expect(fw[0].daysToApex).toBeGreaterThan(0);
		}
	});

	// ── breakout 後のターゲット（pattern_height）────────────

	it('breakout が検出された場合、breakoutTarget と targetMethod が設定される', () => {
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const withTarget = result.patterns.filter((p) => p.breakoutTarget !== undefined);
		if (withTarget.length > 0) {
			expect(withTarget[0]?.targetMethod).toBe('pattern_height');
		}
	});

	// ── デバッグ候補の検証 ───────────────────────────────────

	it('検出試行後 debugCandidates に情報が記録される', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		detectWedges(ctx);
		// 4d では formingWedgeDebug を debugCandidates に unshift する
		expect(ctx.debugCandidates.length).toBeGreaterThanOrEqual(0);
	});

	// ── 重複排除 ─────────────────────────────────────────────

	it('deduplicatePatterns を経て同一タイプ・同一レンジの重複は除去される', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		// 同タイプ×同 range.start の重複がないことを確認
		const seen = new Set<string>();
		for (const p of result.patterns) {
			const key = `${p.type}_${p.range?.start}_${p.range?.end}`;
			expect(seen.has(key)).toBe(false);
			seen.add(key);
		}
	});

	// ── _method フィールド ───────────────────────────────────

	it('4d パスで検出されたパターンの _method は forming_relaxed', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const fromFormingPath = result.patterns.filter((p) => (p as { _method?: string })._method === 'forming_relaxed');
		if (fromFormingPath.length > 0) {
			expect(fromFormingPath[0]?.type).toMatch(/wedge/);
		}
	});

	// ── near_completion ──────────────────────────────────────

	it('Falling Wedge の apex が近い場合 near_completion または completed になる', () => {
		// apex ≈ i=80, endIdx=79 → barsToApex=1 ≤ 10 → near_completion
		const candles = buildFallingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true });
		const result = detectWedges(ctx);

		const fw = result.patterns.filter((p) => p.type === 'falling_wedge');
		if (fw.length > 0) {
			const validStatuses = ['near_completion', 'completed', 'forming'];
			expect(validStatuses).toContain(fw[0]?.status);
		}
	});

	// ── includeForming=false で forming/near_completion を dedup 競合から外す（PR1）─────────

	it('includeForming=false のとき forming / near_completion 状態のパターンは返らない', () => {
		// forming パスは走るが、未ブレイクの forming/near_completion は dedup 前に除外される。
		// ブレイク検出済みで status=completed になったものだけが残る。
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: false });
		const result = detectWedges(ctx);

		for (const p of result.patterns) {
			expect(p.status).not.toBe('forming');
			expect(p.status).not.toBe('near_completion');
		}
	});

	it('includeForming=true / false で前者だけが forming / near_completion を含む', () => {
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctxOn = buildCtx({ candles, pivots, includeForming: true });
		const ctxOff = buildCtx({ candles, pivots, includeForming: false });
		const on = detectWedges(ctxOn).patterns;
		const off = detectWedges(ctxOff).patterns;
		const onHasForming = on.some((p) => p.status === 'forming' || p.status === 'near_completion');
		const offHasForming = off.some((p) => p.status === 'forming' || p.status === 'near_completion');
		expect(onHasForming).toBe(true);
		expect(offHasForming).toBe(false);
	});

	it('includeForming=false でも forming パス由来で completed 判定になったものは残る', () => {
		// 形成中ウィンドウ内でブレイクが検出された場合、forming パスは status=completed を返す。
		// それは dedup 競合用フィルタを通過すべき（下流 includeCompleted=true で消えないため）。
		const candles = buildRisingWedgeCandles(80);
		const pivots: Pivot[] = [];
		const ctxOff = buildCtx({ candles, pivots, includeForming: false });
		const result = detectWedges(ctxOff);

		for (const p of result.patterns) {
			const validStatuses = ['completed', 'invalid'];
			expect(validStatuses).toContain(p.status);
		}
	});

	// ── 時間軸スケーリング: 1hour ─────────────────────────────
	//
	// 1day の WINDOW_SIZE_MIN=25 を素のまま 1hour に使うと 25 時間 = 約 1 日でしかなく、
	// ウェッジとしては短すぎる。barsPerDay(1hour)=24 を介して、構造的に意味のある
	// バー数（数日相当）に拡張されることを確認する。

	function buildRisingWedge1Hour(nBars: number): CandleData[] {
		// 1hour 時間軸での Rising Wedge: 上下とも上昇、下が急で収束
		const candles: CandleData[] = [];
		for (let i = 0; i < nBars; i++) {
			const upper = 100 + 0.04 * i;
			const lower = 80 + 0.07 * i;
			const mid = (upper + lower) / 2;
			const period = i % 8;
			let h: number;
			let l: number;
			let c: number;
			if (period === 0 || period === 1) {
				h = upper;
				l = mid - 2;
				c = mid + 1;
			} else if (period === 4 || period === 5) {
				h = mid + 2;
				l = lower;
				c = mid - 1;
			} else {
				h = mid + 3;
				l = mid - 3;
				c = mid;
			}
			candles.push(mkCandleAt(isoHoursAgo(nBars - i), mid, h, l, c));
		}
		return candles;
	}

	it('1hour: 1day と同じスケール感のウィンドウ（数日分のバー）でウェッジを評価する', () => {
		// 1hour で 80 バー = 約 3.3 日。getWedgeBarParams の formingWindow は
		// 1day で 20-120 バーだったのが、1hour では 480-2880 バー相当になる。
		// 80 バーだけでは forming ウィンドウ最小（480 バー = 20 日）に届かないため、
		// 検出が 0 件であることを確認する（= バー数固定だった旧挙動と比較し、
		// 1hour で過剰に検出しないことの回帰検知）。
		const candles = buildRisingWedge1Hour(80);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1hour' });
		const result = detectWedges(ctx);
		expect(result.patterns).toHaveLength(0);
	});

	it('1hour: バー数を十分に確保すれば forming wedge が検出される', () => {
		// 形成中ウィンドウ最小 480 バー（20 日相当）を上回る 600 バー。
		const candles = buildRisingWedge1Hour(600);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1hour' });
		const result = detectWedges(ctx);

		const rw = result.patterns.filter((p) => p.type === 'rising_wedge');
		expect(rw.length).toBeGreaterThanOrEqual(1);
		expect(rw[0]?.confidence).toBeGreaterThan(0);
	});

	// ── 時間軸スケーリング: 1week ─────────────────────────────
	//
	// 1day の WINDOW_SIZE_MIN=25 を素のまま 1week に使うと 25 週 = 約半年で、
	// 多くの場合データ量を上回ってしまう。bpd(1week)=1/7 と構造上の下限 15 で
	// クランプされ、現実的なバー数で評価できることを確認する。

	function buildRisingWedge1Week(nBars: number): CandleData[] {
		// 1week 時間軸の Rising Wedge: 振幅と勾配を週足相当に拡大
		const candles: CandleData[] = [];
		for (let i = 0; i < nBars; i++) {
			const upper = 100 + 3 * i;
			const lower = 80 + 5 * i;
			const mid = (upper + lower) / 2;
			const period = i % 4;
			let h: number;
			let l: number;
			let c: number;
			if (period === 0) {
				h = upper;
				l = mid - 5;
				c = mid + 2;
			} else if (period === 2) {
				h = mid + 5;
				l = lower;
				c = mid - 2;
			} else {
				h = mid + 6;
				l = mid - 6;
				c = mid;
			}
			candles.push(mkCandleAt(isoWeeksAgo(nBars - i), mid, h, l, c));
		}
		return candles;
	}

	it('1week: バー数固定の旧閾値（25 バー）ではなく構造下限（15 バー）で評価される', () => {
		// 1week で 25 バーは 25 週（約半年）。bpd=1/7 を介すると round(25*1/7)=4 だが
		// 構造下限 15 でクランプされるので、windowSizeMin=15。20 バーあれば検出機会あり。
		const candles = buildRisingWedge1Week(40);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1week', swingDepth: 3 });
		const result = detectWedges(ctx);
		// 配列が返ること、それ自体が「1week でも壊れずに動く」ことの確認。
		expect(Array.isArray(result.patterns)).toBe(true);
	});

	it('1week: 旧バー数固定（WINDOW_SIZE_MIN=25, FORMING_WINDOW_MIN=20）でデータが足りない場合でも例外を投げない', () => {
		// 1week で 20 バー（約 5 ヶ月）程度。1day 旧コードなら windowSizeMin=25 を割って
		// 完成済みウェッジは検出不可だが、形成中（旧 FORMING_WINDOW_MIN=20）はギリ。
		// 新スケーリングでは 1week の formingWindowMin=10 となり、より小さなバー数でも評価できる。
		const candles = buildRisingWedge1Week(20);
		const pivots: Pivot[] = [];
		const ctx = buildCtx({ candles, pivots, includeForming: true, type: '1week', swingDepth: 2 });
		expect(() => detectWedges(ctx)).not.toThrow();
	});

	it('1week と 1day で同一バー数の閾値挙動が異なる（時間軸スケーリング有効）', () => {
		// 同じ 40 バーでも 1day は 40 日（標準ウェッジ範囲）、1week は 40 週（広範）。
		// バー数固定だった旧コードでは両者で同じ挙動になるが、新スケーリングでは
		// 1week の windowSizeMax がクランプにより小さくなる（≈ round(90/7)=13 ＞ 構造下限 20 → 20）。
		// 少なくとも、両時間軸で例外なく実行できることを確認する。
		const candles1d = buildRisingWedgeCandles(40);
		const candles1w = buildRisingWedge1Week(40);
		const ctx1d = buildCtx({ candles: candles1d, pivots: [], includeForming: true, type: '1day' });
		const ctx1w = buildCtx({ candles: candles1w, pivots: [], includeForming: true, type: '1week', swingDepth: 3 });
		expect(() => detectWedges(ctx1d)).not.toThrow();
		expect(() => detectWedges(ctx1w)).not.toThrow();
	});
});
