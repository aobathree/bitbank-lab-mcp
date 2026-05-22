/**
 * patterns/structural.ts - パターン構造検証ユーティリティ
 *
 * 反転パターン（double_top / double_bottom / head_and_shoulders /
 * inverse_head_and_shoulders）の検出に「形として失格な候補を hard reject
 * する層」を入れるための純粋関数群。
 *
 * 本ファイルは純粋関数のみ。detect_doubles.ts / detect_hs.ts への配線は
 * 別 PR で行う。
 *
 * regression.ts の `relDev`（分母 `Math.max(1, Math.max(a, b))`）には
 * 依存させず、構造検証の観点で純粋な相対差を返す `relDiff` を独立に持つ。
 */

import { linearRegressionWithR2 } from './regression.js';

// ---------- 定数 ----------

/** double_top / double_bottom の2点（山-山、谷-谷）同水準の構造上限 */
export const DOUBLE_LEVEL_MAX_PCT = 0.03;

/** H&S / IHS の左右肩同水準の構造上限 */
export const HS_SHOULDER_MAX_PCT = 0.05;

/** H&S / IHS のネックライン構成点（p1, p3）同水準の構造上限 */
export const HS_NECKLINE_MAX_PCT = 0.05;

/** 前提トレンド判定で「横ばい」とみなす priorReturn の範囲 */
export const PRIOR_TREND_SIDEWAYS_PCT = 0.05;

/** 前提トレンド判定の lookback バー数（min / max） */
export const PRIOR_TREND_LOOKBACK_MIN = 10;
export const PRIOR_TREND_LOOKBACK_MAX = 30;

/** 前提トレンド判定で「方向性のあるトレンド」とみなす efficiency 下限 */
export const PRIOR_TREND_MIN_EFFICIENCY = 0.55;

/** 前提トレンド判定で「方向性のあるトレンド」とみなす R² 下限 */
export const PRIOR_TREND_MIN_R2 = 0.35;

// ---------- 純粋関数 ----------

/**
 * 2値の相対差。`Math.max(a, b)` を分母にとり、`|a-b| / max(a, b)` を返す。
 *
 * 両方 0 のときはゼロ除算を避けるため 0 を返す。
 */
export function relDiff(a: number, b: number): number {
	const max = Math.max(a, b);
	if (max === 0) return 0;
	return Math.abs(a - b) / max;
}

/** 2値が `maxPct` 以内に収まっているか（hard cap 用） */
export function isSameLevel(a: number, b: number, maxPct: number): boolean {
	return relDiff(a, b) <= maxPct;
}

/** ネックライン構成2点の水平性検証結果 */
export interface NecklineHorizontalityResult {
	ok: boolean;
	diffPct: number;
}

/**
 * ネックライン構成2点の水平性検証。
 *
 * H&S / IHS の `neckline = [{x:p1.idx,y:p1.price},{x:p3.idx,y:p3.price}]`
 * の y 同士を `maxPct` 以内で同水準とみなす。
 */
export function validateHorizontalNeckline(
	p1Price: number,
	p3Price: number,
	maxPct: number,
): NecklineHorizontalityResult {
	const diffPct = relDiff(p1Price, p3Price);
	return { ok: diffPct <= maxPct, diffPct };
}

export type PriorTrendExpected = 'up_or_sideways' | 'down_or_sideways';

export type PriorTrendClassification = 'up' | 'down' | 'sideways' | 'insufficient_data';

export interface PriorTrendResult {
	ok: boolean;
	priorReturn: number;
	lookbackBars: number;
	/** lookback window 先頭の candle index（= `max(0, startIdx - lookbackBars)`） */
	priorStartIdx: number;
	classification: PriorTrendClassification;
	reason?: string;
	rangePct?: number;
	efficiency?: number;
	r2?: number;
}

/**
 * 形成前トレンド方向の検証。
 *
 * - `lookbackBars = clamp(round(patternBars * 0.5), PRIOR_TREND_LOOKBACK_MIN, PRIOR_TREND_LOOKBACK_MAX)`
 * - `priorStart  = max(0, startIdx - lookbackBars)`
 * - `priorReturn = (close[startIdx] - close[priorStart]) / close[priorStart]`
 *
 * 補助指標（lookback window 内の close 集合に対する集計）:
 * - `rangePct   = (maxClose - minClose) / priorClose`
 * - `efficiency = |startClose - priorClose| / (maxClose - minClose)`
 * - `r2`         = lookback window の (idx, close) に対する線形回帰 R²
 *
 * 分類ルール:
 * - データ不足（`startIdx < lookbackBars`）は `classification='insufficient_data'` で
 *   `ok=true`（hard reject しない）
 * - `|priorReturn| <= PRIOR_TREND_SIDEWAYS_PCT` は `classification='sideways'`
 * - `|priorReturn| > PRIOR_TREND_SIDEWAYS_PCT` でも、
 *   `efficiency >= PRIOR_TREND_MIN_EFFICIENCY` も `r2 >= PRIOR_TREND_MIN_R2` も
 *   満たさない場合は `classification='sideways'`（レンジ内の端点移動を弾く）
 * - 上記を満たす場合のみ `priorReturn > 0 → 'up'` / `priorReturn < 0 → 'down'`
 *
 * `ok` 判定:
 * - `expected='up_or_sideways'`  → `up` / `sideways` / `insufficient_data` を OK
 * - `expected='down_or_sideways'` → `down` / `sideways` / `insufficient_data` を OK
 *
 * close 欠損や window 不正の場合は安全側に `sideways` または `insufficient_data` に倒す。
 */
export function validatePriorTrend(
	candles: ReadonlyArray<{ close: number }>,
	startIdx: number,
	patternBars: number,
	expected: PriorTrendExpected,
): PriorTrendResult {
	const lookbackBars = Math.max(
		PRIOR_TREND_LOOKBACK_MIN,
		Math.min(PRIOR_TREND_LOOKBACK_MAX, Math.round(patternBars * 0.5)),
	);
	const priorStart = Math.max(0, startIdx - lookbackBars);
	const startCloseRaw = candles[startIdx]?.close;
	const priorCloseRaw = candles[priorStart]?.close;
	const startClose = typeof startCloseRaw === 'number' && Number.isFinite(startCloseRaw) ? startCloseRaw : 0;
	const priorClose = typeof priorCloseRaw === 'number' && Number.isFinite(priorCloseRaw) ? priorCloseRaw : 0;
	const priorReturn = priorClose === 0 ? 0 : (startClose - priorClose) / priorClose;

	if (startIdx < lookbackBars) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'insufficient_data',
			reason: 'startIdx < lookbackBars',
		};
	}

	// 両端の close が欠損／不正な場合は安全側に sideways
	if (priorClose === 0 || startClose === 0) {
		const okMissing = expected === 'up_or_sideways' || expected === 'down_or_sideways';
		return {
			ok: okMissing,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'sideways',
			reason: 'missing_close',
		};
	}

	// |priorReturn| が sideways 範囲内なら早期 return（補助指標の計算は不要）
	if (Math.abs(priorReturn) <= PRIOR_TREND_SIDEWAYS_PCT) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'sideways',
		};
	}

	// lookback window の集計（priorStart .. startIdx を含む両端）
	const points: Array<{ x: number; y: number }> = [];
	let maxClose = Number.NEGATIVE_INFINITY;
	let minClose = Number.POSITIVE_INFINITY;
	let hasMissingClose = false;
	for (let i = priorStart; i <= startIdx; i++) {
		const c = candles[i]?.close;
		if (typeof c !== 'number' || !Number.isFinite(c)) {
			hasMissingClose = true;
			continue;
		}
		if (c > maxClose) maxClose = c;
		if (c < minClose) minClose = c;
		points.push({ x: i, y: c });
	}

	// window 内に欠損があれば安全側に sideways
	if (hasMissingClose || points.length < 2 || !Number.isFinite(maxClose) || !Number.isFinite(minClose)) {
		return {
			ok: true,
			priorReturn,
			lookbackBars,
			priorStartIdx: priorStart,
			classification: 'sideways',
			reason: 'invalid_window',
		};
	}

	const range = maxClose - minClose;
	const rangePct = range / priorClose;
	const efficiency = range > 0 ? Math.abs(startClose - priorClose) / range : 0;
	const { r2 } = linearRegressionWithR2(points);

	let classification: PriorTrendClassification;
	const isDirectional = efficiency >= PRIOR_TREND_MIN_EFFICIENCY || r2 >= PRIOR_TREND_MIN_R2;
	if (!isDirectional) {
		classification = 'sideways';
	} else if (priorReturn > 0) {
		classification = 'up';
	} else {
		classification = 'down';
	}

	const ok =
		expected === 'up_or_sideways'
			? classification === 'up' || classification === 'sideways'
			: classification === 'down' || classification === 'sideways';

	return { ok, priorReturn, lookbackBars, priorStartIdx: priorStart, classification, rangePct, efficiency, r2 };
}
