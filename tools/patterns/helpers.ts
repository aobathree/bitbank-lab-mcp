/**
 * パターン検出の共通ヘルパー関数
 *
 * detect_patterns.ts 内にネストされていた関数を、candles 等を明示的に受け取る
 * モジュールレベル関数に変換したもの。
 */

import { dayjs } from '../../lib/datetime.js';
import { trueRange } from '../../lib/indicators.js';
import { EPSILON } from '../../lib/math.js';
import type {
	CandleData,
	DeduplicablePattern,
	PatternScoreComponents,
	PatternScoreWeights,
	TouchPoint,
	TouchResult,
	TrendLine,
	WedgeParams,
} from './types.js';

// ---------------------------------------------------------------------------
// 時間足スケーリング — バー数 ↔ 日数の変換
//
// 検出器の閾値（ウィンドウサイズ・タッチギャップ・形成中ウィンドウ等）は
// 元々日足前提のバー数で書かれていたため、他時間軸では意味がずれていた。
// 「日数」を基準に統一し、各検出器で bars-per-day を介して換算する。
// ---------------------------------------------------------------------------

/**
 * 時間足ごとの「1日あたりのバー本数」を返す。
 *
 * 1day を 1 とし、intraday は >1（1hour=24, 1min=1440 等）、
 * 1week / 1month は <1（1/7, 1/30）。未知の time frame は 1day フォールバック。
 *
 * @param tf - 時間足文字列（'1min', '5min', '15min', '30min', '1hour', '4hour',
 *             '8hour', '12hour', '1day', '1week', '1month'）
 * @returns 1 日あたりのバー本数
 */
export function barsPerDay(tf: string): number {
	switch (tf) {
		case '1min':
			return 1440;
		case '5min':
			return 288;
		case '15min':
			return 96;
		case '30min':
			return 48;
		case '1hour':
			return 24;
		case '4hour':
			return 6;
		case '8hour':
			return 3;
		case '12hour':
			return 2;
		case '1day':
			return 1;
		case '1week':
			return 1 / 7;
		case '1month':
			return 1 / 30;
		default:
			return 1;
	}
}

/**
 * 時間足ごとの「1バーあたりの日数」を返す（`barsPerDay` の逆数）。
 *
 * 形成中パターンの patternDays 計算（formationBars × daysPerBar）で
 * intraday / 1week / 1month を正しく日数換算するために使う。
 *
 * @param tf - 時間足文字列（`barsPerDay` 参照）
 * @returns 1 バーあたりの日数
 */
export function daysPerBar(tf: string): number {
	return 1 / barsPerDay(tf);
}

// ---------------------------------------------------------------------------
// ブレイク後の target 到達判定（high/low ベース）
//
// 最終 close ベースだと、ブレイク後に一度 target を越えてから戻ったケースで
// 未到達扱いされてしまう。実際には「ブレイク後に target を越えたか」を見たいので、
// breakoutIdx 以降のローソク足を走査して extremum
// （下方ブレイクなら min low / 上方ブレイクなら max high）を取り、その値で進捗率を計算する。
//
// 入力:
//   - candles: 全ローソク足
//   - breakoutIdx: ブレイク確定足のインデックス（このバー以降を走査）
//   - breakoutPrice: ブレイク確定時の参照価格（通常は close）
//   - target: 想定ターゲット価格
//   - direction: 'up'  → breakoutIdx 以降の最高 high で評価
//                'down' → breakoutIdx 以降の最安 low で評価
//
// 戻り値:
//   - 0 距離（breakoutPrice == target）の場合: reached=true, pct=100, price=breakoutPrice
//   - 到達済みなら pct を最低 100 にクランプ（オーバーシュート時の符号反転防止）
//   - extremum が見つからない / 入力不正なら undefined
// ---------------------------------------------------------------------------

export interface TargetReachInfo {
	targetReachedPct: number;
	targetReached: boolean;
	targetReachedDate?: string;
	targetReachedPrice: number;
}

export function computeTargetReach(
	candles: readonly CandleData[],
	breakoutIdx: number,
	breakoutPrice: number,
	target: number,
	direction: 'up' | 'down',
): TargetReachInfo | undefined {
	if (!Number.isFinite(breakoutPrice) || !Number.isFinite(target)) return undefined;
	const targetDistance = Math.abs(target - breakoutPrice);
	const startIdx = Math.max(0, breakoutIdx);
	if (startIdx >= candles.length) return undefined;

	// ブレイク時点で target と一致（距離ゼロ）= 既に到達。
	// undefined を返すと targetReached / targetReachedPrice 等の metadata が落ちるため
	// reached=true, pct=100 を確定で返す。
	if (targetDistance <= EPSILON) {
		const targetReachedDate = candles[startIdx]?.isoTime;
		return {
			targetReachedPct: 100,
			targetReached: true,
			...(targetReachedDate ? { targetReachedDate } : {}),
			targetReachedPrice: breakoutPrice,
		};
	}

	let extremePrice = direction === 'down' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
	let extremeIdx = -1;
	for (let i = startIdx; i < candles.length; i++) {
		const candle = candles[i];
		if (!candle) continue;
		if (direction === 'down') {
			const lo = Number(candle.low ?? NaN);
			if (!Number.isFinite(lo)) continue;
			if (lo < extremePrice) {
				extremePrice = lo;
				extremeIdx = i;
			}
		} else {
			const hi = Number(candle.high ?? NaN);
			if (!Number.isFinite(hi)) continue;
			if (hi > extremePrice) {
				extremePrice = hi;
				extremeIdx = i;
			}
		}
	}
	if (extremeIdx < 0 || !Number.isFinite(extremePrice)) return undefined;

	const targetReached = direction === 'down' ? extremePrice <= target : extremePrice >= target;
	// pct はブレイク価格から target 方向へどれだけ進んだかを 100% スケールで返す。
	// 分母を Math.abs にしておくことで、ブレイク足が既に target を越えていた場合の
	// 符号反転（reached=true なのに pct<0）を防ぐ。
	//
	// 丸めは reached/unreached で非対称にする:
	//   - reached=true:  round して max(100, ..) にクランプ（オーバーシュート時の符号反転防止）
	//   - reached=false: floor して 99 にキャップ（99.6% などが 100 に丸まって
	//     下流の `pct >= 100` 判定を誤らせるのを防ぐ）
	const moveDistance = direction === 'down' ? breakoutPrice - extremePrice : extremePrice - breakoutPrice;
	const rawPct = (moveDistance / targetDistance) * 100;
	const targetReachedPct = targetReached
		? Math.max(100, Math.round(rawPct))
		: Math.min(99, Math.max(0, Math.floor(rawPct)));
	const targetReachedDate = candles[extremeIdx]?.isoTime;
	return {
		targetReachedPct,
		targetReached,
		...(targetReachedDate ? { targetReachedDate } : {}),
		targetReachedPrice: extremePrice,
	};
}

// ---------------------------------------------------------------------------
// ATR 計算（lib/indicators.ts の trueRange に委譲）
// ---------------------------------------------------------------------------
export function calcATR(candles: readonly CandleData[], from: number, to: number, period: number = 14): number {
	const start = Math.max(1, from);
	const end = Math.max(start + 1, to);
	const slice = candles.slice(start - 1, end + 1); // prevClose 用に 1 つ前を含める
	if (slice.length < 2) return 0;

	const highs = slice.map((c) => Number(c?.high ?? NaN));
	const lows = slice.map((c) => Number(c?.low ?? NaN));
	const closes = slice.map((c) => Number(c?.close ?? NaN));

	const tr = trueRange(highs, lows, closes);
	// tr[0] は NaN（prevClose がない）、有効値は tr[1..] — 直近 period 個を取る
	const validTr = tr.filter((v) => Number.isFinite(v));
	if (!validTr.length) return 0;
	const n = Math.min(period, validTr.length);
	const tail = validTr.slice(-n);
	return tail.reduce((s, v) => s + v, 0) / tail.length;
}

// ---------------------------------------------------------------------------
// ウェッジのブレイク検出
// ---------------------------------------------------------------------------
export interface WedgeBreakResult {
	detected: boolean;
	breakIdx: number;
	breakIsoTime: string | null;
	breakPrice: number | null;
}

export function detectWedgeBreak(
	candles: CandleData[],
	_wedgeType: 'falling_wedge' | 'rising_wedge',
	upper: { valueAt: (x: number) => number },
	lower: { valueAt: (x: number) => number },
	startIdx: number,
	endIdx: number,
	lastIdx: number,
	atr: number,
): WedgeBreakResult {
	const patternBars = endIdx - startIdx;
	const scanStart = startIdx + Math.max(20, Math.floor(patternBars * 0.3));
	const scanEnd = Math.max(endIdx, lastIdx);

	let firstBreakIdx = -1;

	// 両方向をスキャンし、最初に見つかったブレイクを返す。
	// 方向の判定は呼び出し側（detect_wedges.ts）が breakPrice と
	// トレンドラインの位置関係から行う。
	// - falling_wedge: 上方ブレイク（uLine 超え）が教科書的
	// - rising_wedge:  下方ブレイク（lLine 割れ）が教科書的
	for (let i = scanStart; i <= scanEnd; i++) {
		const close = Number(candles[i]?.close ?? NaN);
		if (!Number.isFinite(close)) continue;

		const uLine = upper.valueAt(i);
		const lLine = lower.valueAt(i);
		if (!Number.isFinite(uLine) || !Number.isFinite(lLine)) continue;

		if (close > uLine + atr * 0.5 || close < lLine - atr * 0.5) {
			firstBreakIdx = i;
			break;
		}
	}

	if (firstBreakIdx !== -1) {
		return {
			detected: true,
			breakIdx: firstBreakIdx,
			breakIsoTime: candles[firstBreakIdx]?.isoTime ?? null,
			breakPrice: Number(candles[firstBreakIdx]?.close ?? NaN),
		};
	}
	return { detected: false, breakIdx: -1, breakIsoTime: null, breakPrice: null };
}

// ---------------------------------------------------------------------------
// ウィンドウ生成
// ---------------------------------------------------------------------------
export function generateWindows(
	totalBars: number,
	minSize: number,
	maxSize: number,
	step: number,
): Array<{ startIdx: number; endIdx: number }> {
	const out: Array<{ startIdx: number; endIdx: number }> = [];
	for (let size = minSize; size <= maxSize; size += step) {
		for (let start = 0; start + size < totalBars; start += step) {
			out.push({ startIdx: start, endIdx: start + size });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// ウェッジタイプ判定
// ---------------------------------------------------------------------------
export function determineWedgeType(
	slopeHigh: number,
	slopeLow: number,
	params: WedgeParams,
): 'rising_wedge' | 'falling_wedge' | null {
	const minSlope = params?.minSlope ?? 0.0001;
	const ratioMinRising = params?.slopeRatioMinRising ?? 1.2;
	const ratioMinFalling = params?.slopeRatioMinFalling ?? params?.slopeRatioMin ?? 1.15;
	const minWeakerSlopeRatio = params?.minWeakerSlopeRatio ?? 0.3;

	// Rising Wedge: 両ライン上向き、下側がより急
	if (slopeHigh > minSlope && slopeLow > minSlope) {
		if (slopeHigh < slopeLow * minWeakerSlopeRatio) return null;
		if (Math.abs(slopeLow) >= Math.abs(slopeHigh) * ratioMinRising) return 'rising_wedge';
	}
	// Falling Wedge: 両ライン下向き、上側がより急
	if (slopeHigh < -minSlope && slopeLow < -minSlope) {
		const absHi = Math.abs(slopeHigh);
		const absLo = Math.abs(slopeLow);
		const weakerRatio = Math.min(absHi, absLo) / Math.max(absHi, absLo);
		if (weakerRatio < minWeakerSlopeRatio) return null;
		if (absHi >= absLo * ratioMinFalling) return 'falling_wedge';
		return null;
	}
	const slopeRatio = Math.abs(slopeLow / (slopeHigh || slopeLow * 1e-6));
	if (slopeRatio > 0.9 && slopeRatio < 1.1) return null;
	return null;
}

// ---------------------------------------------------------------------------
// Apex（頂点）計算 — UAlgo 方式
// ---------------------------------------------------------------------------
/**
 * 2本のトレンドラインの交差点（Apex）を計算する。
 *
 * UAlgo: apex_x = (y2 - y1 + m1*x1 - m2*x2) / (m1 - m2)
 * 線形回帰の場合: upper = slope_u * x + intercept_u, lower = slope_l * x + intercept_l
 * 交点: slope_u * x + intercept_u = slope_l * x + intercept_l
 *   =>  x = (intercept_l - intercept_u) / (slope_u - slope_l)
 */
export interface ApexResult {
	/** Apex のバーインデックス */
	apexIdx: number;
	/** Apex の価格 */
	apexPrice: number;
	/** Apex が有効か（未来にあるか） */
	isValid: boolean;
	/** 現在のバーからApexまでのバー数 */
	barsToApex: number;
}

export function calcApex(upper: TrendLine, lower: TrendLine, endIdx: number): ApexResult {
	const slopeDiff = upper.slope - lower.slope;
	if (Math.abs(slopeDiff) < 1e-15) {
		// 平行 — Apex は無限遠
		return { apexIdx: Infinity, apexPrice: NaN, isValid: false, barsToApex: Infinity };
	}
	const apexIdx = Math.round((lower.intercept - upper.intercept) / slopeDiff);
	const apexPrice = upper.valueAt(apexIdx);
	const barsToApex = apexIdx - endIdx;
	// UAlgo: Apex がウィンドウ終端より先（未来）にあること
	const isValid = barsToApex > 0;
	return { apexIdx, apexPrice, isValid, barsToApex };
}

// ---------------------------------------------------------------------------
// 包含ルール（Containment） — UAlgo 方式
// ---------------------------------------------------------------------------
/**
 * ウェッジ形成中に終値が境界外に出ていないかチェックする。
 *
 * UAlgo: "no candle close is allowed outside the upper or lower boundary"
 * 厳格モードではハード棄却。緩和モードでは許容率を返す。
 *
 * @returns closeInsideRatio: 終値が境界内に収まっている割合 (0-1)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function checkContainment(
	candles: CandleData[],
	upper: { valueAt: (x: number) => number },
	lower: { valueAt: (x: number) => number },
	startIdx: number,
	endIdx: number,
	tolerancePct: number = 0.003,
): { closeInsideRatio: number; violations: number; total: number } {
	let inside = 0;
	let total = 0;
	let violations = 0;
	for (let i = startIdx; i <= endIdx; i++) {
		const c = candles[i];
		if (!c) continue;
		total++;
		const close = c.close;
		const u = upper.valueAt(i);
		const l = lower.valueAt(i);
		const tol = Math.abs(u - l) * tolerancePct;
		if (close > u + tol || close < l - tol) {
			violations++;
		} else {
			inside++;
		}
	}
	return { closeInsideRatio: total > 0 ? inside / total : 0, violations, total };
}

// ---------------------------------------------------------------------------
// ウェッジ品質スコアリング関数群
// ---------------------------------------------------------------------------
/**
 * 収束チェック — Apexベースに移行
 *
 * 旧: gapEnd/gapStart < 0.30（非常に厳しい固定閾値）
 * 新: gapEnd > 0 かつ gapEnd < gapStart（基本収束条件）
 *     + Apex が未来にある（UAlgo 方式）
 *     + ratio を 0.70 以下に緩和（ギャップが30%以上狭まっていればOK）
 *
 * スコアは ratio と加速度で決まる。
 */
export function checkConvergenceEx(upper: TrendLine, lower: TrendLine, startIdx: number, endIdx: number) {
	const midIdx = Math.floor((startIdx + endIdx) / 2);
	const gapStart = upper.valueAt(startIdx) - lower.valueAt(startIdx);
	const gapMid = upper.valueAt(midIdx) - lower.valueAt(midIdx);
	const gapEnd = upper.valueAt(endIdx) - lower.valueAt(endIdx);
	const ratio = gapEnd / Math.max(1e-12, gapStart);

	// 基本条件: ギャップが正で、かつ少なくとも30%収束している
	if (!(gapEnd > 0) || !(ratio < 0.7)) return { isConverging: false, gapStart, gapEnd, ratio };

	// Apex が未来にあるかチェック（スコアへのボーナス）
	const apex = calcApex(upper, lower, endIdx);

	const firstHalf = gapStart - gapMid;
	const secondHalf = gapMid - gapEnd;
	const isAccelerating = secondHalf > firstHalf * 1.2;

	// スコア計算: 収束度 + Apexの位置 + 加速度
	const convergenceComponent = 0.4 * (1 - ratio);
	const apexComponent = 0.35 * (apex.isValid ? 1 : 0.3);
	const accelComponent = 0.25 * (isAccelerating ? 1 : 0.4);
	const score = Math.max(0, Math.min(1, convergenceComponent + apexComponent + accelComponent));

	return { isConverging: true, gapStart, gapMid, gapEnd, ratio, isAccelerating, apex, score };
}

export function evaluateTouchesEx(
	candles: readonly CandleData[],
	upper: Pick<TrendLine, 'valueAt'>,
	lower: Pick<TrendLine, 'valueAt'>,
	startIdx: number,
	endIdx: number,
): TouchResult {
	const touchThresholdPct = 0.005;
	const upperTouches: TouchPoint[] = [],
		lowerTouches: TouchPoint[] = [];
	for (let i = startIdx; i <= endIdx; i++) {
		const c = candles[i];
		if (!c) continue;
		const u = upper.valueAt(i),
			l = lower.valueAt(i);
		const thrUp = Math.abs(u) * touchThresholdPct;
		const distU = Math.abs(c.high - u);
		if (distU < thrUp && c.high <= u + thrUp) upperTouches.push({ index: i, distance: distU, isBreak: false });
		else if (c.high > u + thrUp) upperTouches.push({ index: i, distance: distU, isBreak: true });
		const thrLo = Math.abs(l) * touchThresholdPct;
		const distL = Math.abs(c.low - l);
		if (distL < thrLo && c.low >= l - thrLo) lowerTouches.push({ index: i, distance: distL, isBreak: false });
		else if (c.low < l - thrLo) lowerTouches.push({ index: i, distance: distL, isBreak: true });
	}
	const upQ = upperTouches.filter((t) => !t.isBreak).length;
	const loQ = lowerTouches.filter((t) => !t.isBreak).length;
	const score = Math.max(0, Math.min(1, (upQ + loQ) / 8));
	return { upperTouches, lowerTouches, upperQuality: upQ, lowerQuality: loQ, score };
}

export function calcAlternationScoreEx(touches: TouchResult): number {
	const all = [
		...touches.upperTouches.map((t) => ({ ...t, type: 'upper' as const })),
		...touches.lowerTouches.map((t) => ({ ...t, type: 'lower' as const })),
	].sort((a, b) => a.index - b.index);
	if (all.length < 2) return 0;
	let alternations = 0;
	for (let i = 1; i < all.length; i++) {
		if (all[i].type !== all[i - 1].type) alternations++;
	}
	return Math.max(0, Math.min(1, alternations / Math.max(1, all.length - 1)));
}

export function calcInsideRatioEx(
	candles: readonly CandleData[],
	upper: Pick<TrendLine, 'valueAt'>,
	lower: Pick<TrendLine, 'valueAt'>,
	startIdx: number,
	endIdx: number,
): number {
	let inside = 0,
		total = 0;
	for (let i = startIdx; i <= endIdx; i++) {
		const c = candles[i];
		if (!c) continue;
		total++;
		const u = upper.valueAt(i),
			l = lower.valueAt(i);
		if (c.high <= u && c.low >= l) inside++;
	}
	return total ? inside / total : 0;
}

export function calcDurationScoreEx(
	bars: number,
	params: Pick<WedgeParams, 'windowSizeMin' | 'windowSizeMax'>,
): number {
	const min = params?.windowSizeMin ?? 25,
		max = params?.windowSizeMax ?? 90;
	if (bars < min) return 0;
	if (bars > max) return 0;
	const mid = (min + max) / 2;
	const dist = Math.abs(bars - mid) / Math.max(1, (max - min) / 2);
	return Math.max(0, Math.min(1, 1 - dist));
}

export function calculatePatternScoreEx(components: PatternScoreComponents, weights?: PatternScoreWeights): number {
	const w = weights || { fit: 0.25, converge: 0.25, touch: 0.35, alternation: 0.07, inside: 0.05, duration: 0.03 };
	return (
		w.fit * components.fitScore +
		w.converge * components.convergeScore +
		w.touch * components.touchScore +
		w.alternation * components.alternationScore +
		w.inside * components.insideScore +
		w.duration * components.durationScore
	);
}

// ---------------------------------------------------------------------------
// パターン共通スコアリング
// ---------------------------------------------------------------------------
export function periodScoreDays(startIso?: string, endIso?: string): number {
	if (!startIso || !endIso) return 0.7;
	const d = Math.abs(dayjs(endIso).diff(dayjs(startIso), 'day', true));
	if (d < 5) return 0.6;
	if (d < 15) return 0.8;
	if (d < 30) return 0.9;
	return 0.7;
}

export function finalizeConf(base: number, type: string): number {
	const adj =
		type === 'head_and_shoulders' || type === 'inverse_head_and_shoulders'
			? 1.1
			: type === 'triple_top' || type === 'triple_bottom'
				? 1.05
				: type.startsWith('triangle') || type === 'pennant' || type === 'flag'
					? 0.95
					: 1.0;
	const v = Math.min(1, Math.max(0, base * adj));
	return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// 重複パターンの排除
// ---------------------------------------------------------------------------
export function deduplicatePatterns<T extends DeduplicablePattern>(arr: T[]): T[] {
	const result: T[] = [];
	for (const pattern of arr) {
		if (!pattern?.type || !pattern?.range?.start || !pattern?.range?.end) {
			result.push(pattern);
			continue;
		}
		const overlapping = result.filter((existing) => {
			if (existing?.type !== pattern.type) return false;
			const existingStart = Date.parse(existing.range?.start ?? '');
			const existingEnd = Date.parse(existing.range?.end ?? '');
			const patternStart = Date.parse(pattern.range?.start ?? '');
			const patternEnd = Date.parse(pattern.range?.end ?? '');
			if (
				!Number.isFinite(existingStart) ||
				!Number.isFinite(existingEnd) ||
				!Number.isFinite(patternStart) ||
				!Number.isFinite(patternEnd)
			)
				return false;
			const overlapStart = Math.max(existingStart, patternStart);
			const overlapEnd = Math.min(existingEnd, patternEnd);
			const overlapDuration = Math.max(0, overlapEnd - overlapStart);
			const existingDuration = Math.max(1, existingEnd - existingStart);
			const patternDuration = Math.max(1, patternEnd - patternStart);
			const minDuration = Math.min(existingDuration, patternDuration);
			return overlapDuration / minDuration > 0.5;
		});
		if (overlapping.length === 0) {
			result.push(pattern);
		} else {
			const allCandidates = [...overlapping, pattern];
			const maxEndTime = Math.max(...allCandidates.map((p) => Date.parse(p.range?.end ?? '')));
			let best = allCandidates.filter((p) => Date.parse(p.range?.end ?? '') === maxEndTime);
			if (best.length > 1) {
				const maxConfidence = Math.max(...best.map((p) => Number(p.confidence ?? 0)));
				best = best.filter((p) => Number(p.confidence ?? 0) === maxConfidence);
			}
			if (best.length > 1) {
				const getHeight = (p: DeduplicablePattern) => {
					const piv = Array.isArray(p?.pivots) ? p.pivots : [];
					if (p?.type === 'double_top' && piv.length >= 3) {
						const peak = Math.max(Number(piv[0]?.price ?? 0), Number(piv[2]?.price ?? 0));
						const valley = Number(piv[1]?.price ?? peak);
						return Math.max(0, peak - valley);
					}
					if (p?.type === 'double_bottom' && piv.length >= 3) {
						const valley = Math.min(Number(piv[0]?.price ?? 0), Number(piv[2]?.price ?? 0));
						const peak = Number(piv[1]?.price ?? valley);
						return Math.max(0, peak - valley);
					}
					return 0;
				};
				const maxHeight = Math.max(...best.map(getHeight));
				best = best.filter((p) => getHeight(p) === maxHeight);
			}
			const winner = best[0];
			for (const dup of overlapping) {
				const idx = result.indexOf(dup);
				if (idx >= 0) result.splice(idx, 1);
			}
			result.push(winner);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// グローバル重複排除（全パターン種別横断）
// ---------------------------------------------------------------------------
export function globalDedup(patterns: DeduplicablePattern[]): DeduplicablePattern[] {
	function toMs(iso?: string): number {
		try {
			const t = Date.parse(String(iso));
			return Number.isFinite(t) ? t : NaN;
		} catch {
			return NaN;
		}
	}
	function overlapRatio(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
		const as = toMs(aStart),
			ae = toMs(aEnd),
			bs = toMs(bStart),
			be = toMs(bEnd);
		if (!Number.isFinite(as) || !Number.isFinite(ae) || !Number.isFinite(bs) || !Number.isFinite(be)) return 0;
		const os = Math.max(as, bs);
		const oe = Math.min(ae, be);
		const ov = Math.max(0, oe - os);
		const ad = Math.max(1, ae - as);
		const bd = Math.max(1, be - bs);
		const minD = Math.min(ad, bd);
		return ov / minD;
	}

	// 同一カテゴリとして扱うパターン群（期間重複する場合は同カテゴリ内でも dedup 対象）
	const categoryMap: Record<string, string> = {
		rising_wedge: 'wedge',
		falling_wedge: 'wedge',
		triangle_ascending: 'triangle',
		triangle_descending: 'triangle',
		triangle_symmetrical: 'triangle',
	};
	function isSameCategory(a: string, b: string): boolean {
		if (a === b) return true;
		const ca = categoryMap[a];
		const cb = categoryMap[b];
		return !!(ca && cb && ca === cb);
	}

	const dedupThreshold = 0.7;
	const out: DeduplicablePattern[] = [];
	for (const p of patterns) {
		const pRange = { s: String(p?.range?.start), e: String(p?.range?.end ?? p?.range?.current) };
		const overlapIdx = out.findIndex(
			(q) =>
				isSameCategory(String(q?.type), String(p?.type)) &&
				overlapRatio(String(q?.range?.start), String(q?.range?.end ?? q?.range?.current), pRange.s, pRange.e) >=
					dedupThreshold,
		);
		if (overlapIdx < 0) {
			out.push(p);
		} else {
			const existing = out[overlapIdx];
			const eConf = Number(existing?.confidence ?? 0);
			const pConf = Number(p?.confidence ?? 0);
			if (pConf > eConf) {
				out[overlapIdx] = p;
			} else if (pConf === eConf) {
				const eEnd = toMs(existing?.range?.end ?? existing?.range?.current);
				const pEnd = toMs(p?.range?.end ?? p?.range?.current);
				if (Number.isFinite(pEnd) && Number.isFinite(eEnd) && pEnd > eEnd) {
					out[overlapIdx] = p;
				}
			}
		}
	}
	return out;
}
