import { describe, expect, it } from 'vitest';
import {
	barsPerDay,
	calcAlternationScoreEx,
	calcApex,
	calcDurationScoreEx,
	calcInsideRatioEx,
	calculatePatternScoreEx,
	checkContainment,
	checkConvergenceEx,
	computeTargetReach,
	daysPerBar,
	deduplicatePatterns,
	detectWedgeBreak,
	determineWedgeType,
	evaluateTouchesEx,
	finalizeConf,
	generateWindows,
	globalDedup,
	periodScoreDays,
} from '../../tools/patterns/helpers.js';
import type { CandleData, TrendLine } from '../../tools/patterns/types.js';

// ---------------------------------------------------------------------------
// ヘルパー
// ---------------------------------------------------------------------------
function makeTrendLine(slope: number, intercept: number): TrendLine {
	return { slope, intercept, valueAt: (x: number) => slope * x + intercept };
}

function makeCandles(count: number, basePrice: number = 100): CandleData[] {
	return Array.from({ length: count }, (_, i) => ({
		open: basePrice + i,
		close: basePrice + i,
		high: basePrice + i + 2,
		low: basePrice + i - 2,
		isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
	}));
}

// ---------------------------------------------------------------------------
// generateWindows
// ---------------------------------------------------------------------------
describe('generateWindows', () => {
	it('正しいウィンドウを生成する', () => {
		const windows = generateWindows(20, 5, 10, 5);
		expect(windows.length).toBeGreaterThan(0);
		for (const w of windows) {
			expect(w.endIdx - w.startIdx).toBeGreaterThanOrEqual(5);
			expect(w.endIdx - w.startIdx).toBeLessThanOrEqual(10);
			expect(w.endIdx).toBeLessThan(20);
		}
	});

	it('totalBars が minSize 未満なら空を返す', () => {
		const windows = generateWindows(3, 5, 10, 5);
		expect(windows).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// determineWedgeType
// ---------------------------------------------------------------------------
describe('determineWedgeType', () => {
	it('両ライン上向き・下側が急 → rising_wedge', () => {
		const result = determineWedgeType(0.001, 0.002, { slopeRatioMinRising: 1.2 });
		expect(result).toBe('rising_wedge');
	});

	it('両ライン下向き・上側が急 → falling_wedge', () => {
		const result = determineWedgeType(-0.003, -0.001, { slopeRatioMinFalling: 1.15 });
		expect(result).toBe('falling_wedge');
	});

	it('傾きが小さすぎる場合は null', () => {
		const result = determineWedgeType(0.00001, 0.00002, {});
		expect(result).toBeNull();
	});

	it('比率が 0.9-1.1 の範囲内（ほぼ平行）は null', () => {
		const result = determineWedgeType(0.001, -0.001, {});
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// calcApex
// ---------------------------------------------------------------------------
describe('calcApex', () => {
	it('収束するトレンドラインの Apex を計算', () => {
		const upper = makeTrendLine(-0.5, 200); // 下降ライン
		const lower = makeTrendLine(0.5, 100); // 上昇ライン
		const result = calcApex(upper, lower, 50);
		expect(result.apexIdx).toBe(100); // (100-200) / (-0.5-0.5) = 100
		expect(result.isValid).toBe(true);
		expect(result.barsToApex).toBe(50);
	});

	it('平行ラインの場合は Infinity', () => {
		const upper = makeTrendLine(1, 200);
		const lower = makeTrendLine(1, 100);
		const result = calcApex(upper, lower, 50);
		expect(result.apexIdx).toBe(Infinity);
		expect(result.isValid).toBe(false);
	});

	it('Apex が過去にある場合は isValid=false', () => {
		const upper = makeTrendLine(-0.5, 200);
		const lower = makeTrendLine(0.5, 100);
		const result = calcApex(upper, lower, 150);
		expect(result.isValid).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// checkContainment
// ---------------------------------------------------------------------------
describe('checkContainment', () => {
	it('全て境界内なら ratio=1', () => {
		const candles = makeCandles(10, 100);
		const upper = { valueAt: () => 200 };
		const lower = { valueAt: () => 0 };
		const result = checkContainment(candles, upper, lower, 0, 9);
		expect(result.closeInsideRatio).toBe(1);
		expect(result.violations).toBe(0);
	});

	it('全て境界外なら ratio=0', () => {
		const candles = makeCandles(10, 100);
		const upper = { valueAt: () => 50 };
		const lower = { valueAt: () => 40 };
		const result = checkContainment(candles, upper, lower, 0, 9);
		expect(result.closeInsideRatio).toBe(0);
		expect(result.violations).toBe(10);
	});
});

// ---------------------------------------------------------------------------
// checkConvergenceEx
// ---------------------------------------------------------------------------
describe('checkConvergenceEx', () => {
	it('収束するラインで isConverging=true', () => {
		const upper = makeTrendLine(-1, 200);
		const lower = makeTrendLine(0.5, 50);
		const result = checkConvergenceEx(upper, lower, 0, 80);
		expect(result.isConverging).toBe(true);
		expect(result.score).toBeGreaterThan(0);
	});

	it('発散するラインで isConverging=false', () => {
		const upper = makeTrendLine(2, 200);
		const lower = makeTrendLine(-1, 50);
		const result = checkConvergenceEx(upper, lower, 0, 50);
		expect(result.isConverging).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// evaluateTouchesEx
// ---------------------------------------------------------------------------
describe('evaluateTouchesEx', () => {
	it('タッチポイントを検出する', () => {
		const candles: readonly CandleData[] = Array.from({ length: 20 }, (_, i) => ({
			open: 100,
			close: 100,
			high: 110 - i * 0.4,
			low: 90 + i * 0.4,
		}));
		const upper = { valueAt: (x: number) => 110 - x * 0.4 };
		const lower = { valueAt: (x: number) => 90 + x * 0.4 };
		const result = evaluateTouchesEx(candles, upper, lower, 0, 19);
		expect(result.upperTouches.length).toBeGreaterThanOrEqual(0);
		expect(result.lowerTouches.length).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeGreaterThanOrEqual(0);
		expect(result.score).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// calcAlternationScoreEx
// ---------------------------------------------------------------------------
describe('calcAlternationScoreEx', () => {
	it('完全に交互なら 1', () => {
		const touches = {
			upperTouches: [
				{ index: 0, distance: 0, isBreak: false },
				{ index: 4, distance: 0, isBreak: false },
			],
			lowerTouches: [
				{ index: 2, distance: 0, isBreak: false },
				{ index: 6, distance: 0, isBreak: false },
			],
			upperQuality: 2,
			lowerQuality: 2,
			score: 0.5,
		};
		expect(calcAlternationScoreEx(touches)).toBe(1);
	});

	it('全て同じ方向なら 0', () => {
		const touches = {
			upperTouches: [
				{ index: 0, distance: 0, isBreak: false },
				{ index: 1, distance: 0, isBreak: false },
				{ index: 2, distance: 0, isBreak: false },
			],
			lowerTouches: [],
			upperQuality: 3,
			lowerQuality: 0,
			score: 0.375,
		};
		expect(calcAlternationScoreEx(touches)).toBe(0);
	});

	it('タッチが1つ以下なら 0', () => {
		const touches = {
			upperTouches: [{ index: 0, distance: 0, isBreak: false }],
			lowerTouches: [],
			upperQuality: 1,
			lowerQuality: 0,
			score: 0.125,
		};
		expect(calcAlternationScoreEx(touches)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// calcInsideRatioEx
// ---------------------------------------------------------------------------
describe('calcInsideRatioEx', () => {
	it('全て内側なら 1', () => {
		const candles: readonly CandleData[] = [
			{ open: 100, close: 100, high: 105, low: 95 },
			{ open: 100, close: 100, high: 105, low: 95 },
		];
		const upper = { valueAt: () => 110 };
		const lower = { valueAt: () => 90 };
		expect(calcInsideRatioEx(candles, upper, lower, 0, 1)).toBe(1);
	});

	it('全て外側なら 0', () => {
		const candles: readonly CandleData[] = [{ open: 100, close: 100, high: 120, low: 80 }];
		const upper = { valueAt: () => 105 };
		const lower = { valueAt: () => 95 };
		expect(calcInsideRatioEx(candles, upper, lower, 0, 0)).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// calcDurationScoreEx
// ---------------------------------------------------------------------------
describe('calcDurationScoreEx', () => {
	it('範囲内の中央値で最高スコア', () => {
		const score = calcDurationScoreEx(57, { windowSizeMin: 25, windowSizeMax: 90 });
		expect(score).toBeCloseTo(1, 1);
	});

	it('範囲外なら 0', () => {
		expect(calcDurationScoreEx(10, { windowSizeMin: 25, windowSizeMax: 90 })).toBe(0);
		expect(calcDurationScoreEx(100, { windowSizeMin: 25, windowSizeMax: 90 })).toBe(0);
	});

	it('デフォルトパラメータを使用', () => {
		const score = calcDurationScoreEx(57, {});
		expect(score).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// calculatePatternScoreEx
// ---------------------------------------------------------------------------
describe('calculatePatternScoreEx', () => {
	it('全コンポーネント=1 なら 1', () => {
		const components = {
			fitScore: 1,
			convergeScore: 1,
			touchScore: 1,
			alternationScore: 1,
			insideScore: 1,
			durationScore: 1,
		};
		expect(calculatePatternScoreEx(components)).toBeCloseTo(1, 5);
	});

	it('全コンポーネント=0 なら 0', () => {
		const components = {
			fitScore: 0,
			convergeScore: 0,
			touchScore: 0,
			alternationScore: 0,
			insideScore: 0,
			durationScore: 0,
		};
		expect(calculatePatternScoreEx(components)).toBe(0);
	});

	it('カスタム重みを使用可能', () => {
		const components = {
			fitScore: 1,
			convergeScore: 0,
			touchScore: 0,
			alternationScore: 0,
			insideScore: 0,
			durationScore: 0,
		};
		const weights = { fit: 1, converge: 0, touch: 0, alternation: 0, inside: 0, duration: 0 };
		expect(calculatePatternScoreEx(components, weights)).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// periodScoreDays
// ---------------------------------------------------------------------------
describe('periodScoreDays', () => {
	it('ISO文字列なしは 0.7', () => {
		expect(periodScoreDays()).toBe(0.7);
	});

	it('短期間は低スコア', () => {
		expect(periodScoreDays('2024-01-01', '2024-01-03')).toBe(0.6);
	});

	it('15-30日は高スコア', () => {
		expect(periodScoreDays('2024-01-01', '2024-01-20')).toBe(0.9);
	});
});

// ---------------------------------------------------------------------------
// finalizeConf
// ---------------------------------------------------------------------------
describe('finalizeConf', () => {
	it('head_and_shoulders はボーナス（*1.1）', () => {
		const result = finalizeConf(0.8, 'head_and_shoulders');
		expect(result).toBeCloseTo(0.88, 2);
	});

	it('triple_top はボーナス（*1.05）', () => {
		const result = finalizeConf(0.8, 'triple_top');
		expect(result).toBeCloseTo(0.84, 2);
	});

	it('triangle はペナルティ（*0.95）', () => {
		const result = finalizeConf(0.8, 'triangle_ascending');
		expect(result).toBeCloseTo(0.76, 2);
	});

	it('1 を超えない', () => {
		expect(finalizeConf(1, 'head_and_shoulders')).toBeLessThanOrEqual(1);
	});

	it('0 未満にならない', () => {
		expect(finalizeConf(0, 'unknown')).toBeGreaterThanOrEqual(0);
	});
});

// ---------------------------------------------------------------------------
// detectWedgeBreak
// ---------------------------------------------------------------------------
describe('detectWedgeBreak', () => {
	it('ブレイクがない場合は detected=false', () => {
		const candles = makeCandles(50, 100);
		const upper = { valueAt: () => 200 };
		const lower = { valueAt: () => 0 };
		const result = detectWedgeBreak(candles, 'falling_wedge', upper, lower, 0, 30, 49, 10);
		expect(result.detected).toBe(false);
		expect(result.breakIdx).toBe(-1);
	});

	it('上方ブレイクを検出する', () => {
		const candles: CandleData[] = Array.from({ length: 60 }, (_, i) => ({
			open: 100,
			close: i >= 40 ? 250 : 100,
			high: i >= 40 ? 260 : 110,
			low: 90,
			isoTime: `2024-01-${String(i + 1).padStart(2, '0')}`,
		}));
		const upper = { valueAt: () => 120 };
		const lower = { valueAt: () => 80 };
		const result = detectWedgeBreak(candles, 'falling_wedge', upper, lower, 0, 50, 59, 5);
		expect(result.detected).toBe(true);
		expect(result.breakPrice).toBeGreaterThan(120);
	});
});

// ---------------------------------------------------------------------------
// deduplicatePatterns
// ---------------------------------------------------------------------------
describe('deduplicatePatterns', () => {
	it('重複しないパターンはそのまま返す', () => {
		const patterns = [
			{ type: 'double_top', confidence: 0.8, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'double_bottom', confidence: 0.7, range: { start: '2024-02-01', end: '2024-02-10' } },
		];
		expect(deduplicatePatterns(patterns)).toHaveLength(2);
	});

	it('同種・重複期間のパターンは confidence が高い方を残す', () => {
		const patterns = [
			{ type: 'double_top', confidence: 0.6, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'double_top', confidence: 0.9, range: { start: '2024-01-02', end: '2024-01-12' } },
		];
		const result = deduplicatePatterns(patterns);
		expect(result).toHaveLength(1);
		expect(result[0].confidence).toBe(0.9);
	});

	it('type や range がない場合はそのまま追加', () => {
		const patterns = [{ foo: 'bar' }, { type: 'double_top' }];
		expect(deduplicatePatterns(patterns)).toHaveLength(2);
	});

	it('空配列は空を返す', () => {
		expect(deduplicatePatterns([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// globalDedup
// ---------------------------------------------------------------------------
describe('globalDedup', () => {
	it('異なるカテゴリのパターンは残す', () => {
		const patterns = [
			{ type: 'double_top', confidence: 0.8, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'rising_wedge', confidence: 0.7, range: { start: '2024-01-01', end: '2024-01-10' } },
		];
		expect(globalDedup(patterns)).toHaveLength(2);
	});

	it('同カテゴリで重複する場合は confidence が高い方を残す', () => {
		const patterns = [
			{ type: 'rising_wedge', confidence: 0.6, range: { start: '2024-01-01', end: '2024-01-10' } },
			{ type: 'falling_wedge', confidence: 0.9, range: { start: '2024-01-01', end: '2024-01-10' } },
		];
		const result = globalDedup(patterns);
		expect(result).toHaveLength(1);
		expect(result[0].confidence).toBe(0.9);
	});

	it('空配列は空を返す', () => {
		expect(globalDedup([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// barsPerDay / daysPerBar
// ---------------------------------------------------------------------------
describe('barsPerDay', () => {
	it('1day は 1 を返す', () => {
		expect(barsPerDay('1day')).toBe(1);
	});

	it('intraday は 1 日あたりのバー数を返す', () => {
		expect(barsPerDay('1hour')).toBe(24);
		expect(barsPerDay('4hour')).toBe(6);
		expect(barsPerDay('15min')).toBe(96);
		expect(barsPerDay('1min')).toBe(1440);
	});

	it('1week / 1month は 1 未満を返す', () => {
		expect(barsPerDay('1week')).toBeCloseTo(1 / 7, 10);
		expect(barsPerDay('1month')).toBeCloseTo(1 / 30, 10);
	});

	it('未知の time frame は 1 にフォールバック', () => {
		expect(barsPerDay('unknown' as string)).toBe(1);
	});
});

describe('daysPerBar', () => {
	it('barsPerDay の逆数を返す', () => {
		expect(daysPerBar('1day')).toBe(1);
		expect(daysPerBar('1hour')).toBeCloseTo(1 / 24, 10);
		expect(daysPerBar('1week')).toBe(7);
		expect(daysPerBar('1month')).toBe(30);
	});

	it('formationBars × daysPerBar で日数に換算できる', () => {
		// 1hour × 48 bars = 2 days
		expect(48 * daysPerBar('1hour')).toBeCloseTo(2, 10);
		// 1week × 4 bars = 28 days
		expect(4 * daysPerBar('1week')).toBe(28);
		// 1month × 3 bars = 90 days
		expect(3 * daysPerBar('1month')).toBe(90);
	});
});

// ---------------------------------------------------------------------------
// computeTargetReach — ブレイク後の target 到達判定（high/low ベース）
// ---------------------------------------------------------------------------
describe('computeTargetReach', () => {
	// candle factory: high / low を明示指定可能
	function c(high: number, low: number, close: number, iso?: string): CandleData {
		return { open: close, high, low, close, isoTime: iso ?? `2026-01-01T00:00:00.000Z` };
	}

	// direction='down' ─────────────────────────────────────

	it('direction=down: 最安 low が target を割り込む → reached=true, pct>=100', () => {
		// breakoutPrice=100, target=80, idx=2 で low=70 (<= target) → 到達
		const candles = [
			c(105, 95, 100, 'iso-0'),
			c(105, 90, 100, 'iso-1'),
			c(95, 70, 90, 'iso-2'),
			c(100, 85, 95, 'iso-3'),
		];
		const r = computeTargetReach(candles, 0, 100, 80, 'down');
		expect(r).toBeDefined();
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(r?.targetReachedPrice).toBe(70);
		expect(r?.targetReachedDate).toBe('iso-2');
	});

	it('direction=down: 一度到達後に close が戻っても最安 low ベースで到達扱い', () => {
		// breakoutPrice=100, target=80, idx=1 で low=75（到達） / idx=3 で close=100 へ戻し
		const candles = [
			c(102, 99, 100, 'iso-0'),
			c(95, 75, 90, 'iso-1'),
			c(110, 92, 105, 'iso-2'),
			c(115, 99, 110, 'iso-3'),
		];
		const r = computeTargetReach(candles, 0, 100, 80, 'down');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPrice).toBe(75);
		expect(r?.targetReachedDate).toBe('iso-1');
	});

	it('direction=down: ブレイク close が既に target を下回る（オーバーシュート）→ reached=true & pct>=100', () => {
		// breakoutPrice=70, target=80 → 既に到達済み
		const candles = [c(72, 65, 70, 'iso-0'), c(75, 60, 70, 'iso-1')];
		const r = computeTargetReach(candles, 0, 70, 80, 'down');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(r?.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('direction=down: low が target に届かない → reached=false, pct<100', () => {
		// breakoutPrice=100, target=50, 最安 low=90 → moveDistance=10, distance=50, pct=20
		const candles = [c(102, 100, 100, 'iso-0'), c(101, 90, 99, 'iso-1')];
		const r = computeTargetReach(candles, 0, 100, 50, 'down');
		expect(r?.targetReached).toBe(false);
		expect(r?.targetReachedPct).toBe(20);
		expect(r?.targetReachedPrice).toBe(90);
	});

	// direction='up' ───────────────────────────────────────

	it('direction=up: 最高 high が target を超える → reached=true, pct>=100', () => {
		// breakoutPrice=100, target=120, idx=2 で high=130 (>= target) → 到達
		const candles = [c(102, 98, 100, 'iso-0'), c(110, 100, 108, 'iso-1'), c(130, 115, 125, 'iso-2')];
		const r = computeTargetReach(candles, 0, 100, 120, 'up');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(r?.targetReachedPrice).toBe(130);
		expect(r?.targetReachedDate).toBe('iso-2');
	});

	it('direction=up: 一度到達後に close が戻っても最高 high ベースで到達扱い', () => {
		// breakoutPrice=100, target=120, idx=1 で high=125（到達） / idx=2 で close=100 へ戻し
		const candles = [c(101, 99, 100, 'iso-0'), c(125, 100, 122, 'iso-1'), c(105, 95, 100, 'iso-2')];
		const r = computeTargetReach(candles, 0, 100, 120, 'up');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPrice).toBe(125);
		expect(r?.targetReachedDate).toBe('iso-1');
	});

	it('direction=up: ブレイク close が既に target を超える（オーバーシュート）→ reached=true & pct>=100', () => {
		// breakoutPrice=130, target=120 → 既に到達済み
		const candles = [c(135, 125, 130, 'iso-0'), c(140, 128, 135, 'iso-1')];
		const r = computeTargetReach(candles, 0, 130, 120, 'up');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBeGreaterThanOrEqual(100);
		expect(r?.targetReachedPct).toBeGreaterThanOrEqual(0);
	});

	it('direction=up: high が target に届かない → reached=false, pct<100', () => {
		// breakoutPrice=100, target=150, 最高 high=110 → moveDistance=10, distance=50, pct=20
		const candles = [c(105, 98, 100, 'iso-0'), c(110, 100, 108, 'iso-1')];
		const r = computeTargetReach(candles, 0, 100, 150, 'up');
		expect(r?.targetReached).toBe(false);
		expect(r?.targetReachedPct).toBe(20);
		expect(r?.targetReachedPrice).toBe(110);
	});

	// 0 距離 ───────────────────────────────────────────────

	it('0 距離（breakoutPrice == target）→ reached=true, pct=100, price=breakoutPrice', () => {
		const candles = [c(102, 98, 100, 'iso-0'), c(105, 95, 100, 'iso-1')];
		const r = computeTargetReach(candles, 0, 100, 100, 'down');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBe(100);
		expect(r?.targetReachedPrice).toBe(100);
		expect(r?.targetReachedDate).toBe('iso-0');
	});

	it('0 距離（direction=up）→ reached=true, pct=100, price=breakoutPrice', () => {
		const candles = [c(102, 98, 100, 'iso-0'), c(105, 95, 100, 'iso-1')];
		const r = computeTargetReach(candles, 0, 100, 100, 'up');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBe(100);
		expect(r?.targetReachedPrice).toBe(100);
		expect(r?.targetReachedDate).toBe('iso-0');
	});

	// 入力不正 ─────────────────────────────────────────────

	it('breakoutPrice が NaN → undefined を返す', () => {
		const candles = [c(102, 98, 100, 'iso-0')];
		expect(computeTargetReach(candles, 0, Number.NaN, 80, 'down')).toBeUndefined();
	});

	it('target が NaN → undefined を返す', () => {
		const candles = [c(102, 98, 100, 'iso-0')];
		expect(computeTargetReach(candles, 0, 100, Number.NaN, 'down')).toBeUndefined();
	});

	it('breakoutIdx が candles.length 以上 → undefined を返す', () => {
		const candles = [c(102, 98, 100, 'iso-0')];
		expect(computeTargetReach(candles, 5, 100, 80, 'down')).toBeUndefined();
	});

	it('breakoutIdx が負 → Math.max(0, ...) で 0 から走査', () => {
		const candles = [c(95, 70, 90, 'iso-0'), c(100, 80, 95, 'iso-1')];
		const r = computeTargetReach(candles, -1, 100, 80, 'down');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPrice).toBe(70);
	});

	// 丸めの非対称性（reached=false なら 100 に丸めない） ───

	it('reached=false で raw pct が 99.x → 99 にキャップ（100 にせり上がらない）', () => {
		// breakoutPrice=100, target=0, extremeLow=0.4
		// targetReached = 0.4 <= 0 → false
		// rawPct = (100 - 0.4) / 100 * 100 = 99.6
		// 旧: Math.round(99.6)=100（reached=false なのに pct=100）
		// 新: Math.min(99, Math.floor(99.6))=99
		const candles = [c(101, 0.4, 100, 'iso-0')];
		const r = computeTargetReach(candles, 0, 100, 0, 'down');
		expect(r?.targetReached).toBe(false);
		expect(r?.targetReachedPct).toBe(99);
	});

	it('reached=true なら通常通り round（オーバーシュート/到達の区別を維持）', () => {
		// breakoutPrice=100, target=80, extremeLow=80（ちょうど到達）
		// rawPct = 20/20 * 100 = 100 → reached=true & pct=100
		const candles = [c(95, 80, 90, 'iso-0')];
		const r = computeTargetReach(candles, 0, 100, 80, 'down');
		expect(r?.targetReached).toBe(true);
		expect(r?.targetReachedPct).toBe(100);
	});
});
