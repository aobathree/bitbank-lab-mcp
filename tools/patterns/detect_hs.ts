/**
 * Head & Shoulders / Inverse Head & Shoulders 検出（完成済み＋形成中）
 * detect_patterns.ts Section 3 から抽出
 *
 * 完成済み構造の右肩形成後にネックライン突破が確認できた場合は
 * confirmation = 'neckline_breakout' を立てて status = 'completed' を付与する
 * （detect_doubles / detect_triples と同方針）。未確認の場合は
 * status = 'near_completion' + confirmation = 'not_confirmed' で返し、
 * detect_patterns 側の `!p.status` フォールバックで誤って completed 扱い
 * されるのを防ぐ。ネックラインは 2 点を結ぶ傾きつきラインとして外挿する。
 */
import { EPSILON } from '../../lib/math.js';
import { generatePatternDiagram } from '../../lib/pattern-diagrams.js';
import { finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, marginFromRelDev, relDev } from './regression.js';
import {
	HS_NECKLINE_MAX_PCT,
	HS_SHOULDER_MAX_PCT,
	isSameLevel,
	type PriorTrendResult,
	validateHorizontalNeckline,
	validatePriorTrend,
} from './structural.js';
import type {
	CandleData,
	DeduplicablePattern,
	DetectContext,
	DetectResult,
	PatternConfirmation,
	PatternPrecedingTrend,
} from './types.js';

// ── Helper: PriorTrendResult → PatternPrecedingTrend ──

function buildPrecedingTrend(
	candles: CandleData[],
	trend: PriorTrendResult,
	startIdx: number,
): PatternPrecedingTrend | undefined {
	const startIso = candles[trend.priorStartIdx]?.isoTime;
	const endIso = candles[startIdx]?.isoTime;
	if (!startIso || !endIso) return undefined;
	return {
		start: startIso,
		end: endIso,
		direction: trend.classification,
		returnPct: Number((trend.priorReturn * 100).toFixed(2)),
		lookbackBars: trend.lookbackBars,
	};
}

// ── 定数 ──

const RELAXED_FACTORS = [
	{ shoulder: 1.6, head: 0.6, tag: 'x1.6_0.6' },
	{ shoulder: 2.0, head: 0.4, tag: 'x2.0_0.4' },
] as const;

const FORMING_RIGHT_TOLERANCE_PCT = 0.08;
const FORMING_MAX_DAYS = 90;
const FORMING_MIN_DAYS = 21;
const FORMING_MIN_COMPLETION = 0.4;
// detect_triples.ts と同値。形状不十分な forming 候補を上位表示させないための最低 confidence。
const FORMING_MIN_CONFIDENCE = 0.5;

// ── ネックラインブレイク検出（detect_doubles / detect_triples と同値の 1.5% バッファ） ──
// H&S は傾きつきネックライン（谷1→谷2 / 山1→山2）を外挿して判定する。
const HS_BREAKOUT_BUFFER_PCT = 0.015;
// 右肩から最大何バー後までブレイクをスキャンするか。aftermath.ts と同じ 30 を採用。
// 例: 日足で右肩から約 4 週間後までのブレイクを拾える。
const HS_BREAKOUT_MAX_BARS = 30;

// ── Helper: ネックライン補間 ──

type NecklinePt = { x: number; y: number };

function necklineAt(neckline: NecklinePt[] | undefined, i: number): number {
	if (!Array.isArray(neckline) || neckline.length < 2) return NaN;
	const [a, b] = neckline;
	if (!(Number.isFinite(a?.x) && Number.isFinite(b?.x) && Number.isFinite(a?.y) && Number.isFinite(b?.y))) return NaN;
	if (b.x === a.x) return a.y;
	return a.y + ((b.y - a.y) * (i - a.x)) / (b.x - a.x);
}

// ── Helper: 右肩後のネックラインブレイクインデックスを検出 ──
// direction='below': H&S（close < necklineAt * (1 - buffer)）
// direction='above': 逆H&S（close > necklineAt * (1 + buffer)）

function findHsBreakoutIdx(
	candles: CandleData[],
	neckline: NecklinePt[],
	rightShoulderIdx: number,
	direction: 'below' | 'above',
): number {
	const end = Math.min(rightShoulderIdx + HS_BREAKOUT_MAX_BARS + 1, candles.length);
	for (let k = rightShoulderIdx + 1; k < end; k++) {
		const closeK = Number(candles[k]?.close ?? NaN);
		if (!Number.isFinite(closeK)) continue;
		const nlPrice = necklineAt(neckline, k);
		if (!Number.isFinite(nlPrice)) continue;
		if (direction === 'below' && closeK < nlPrice * (1 - HS_BREAKOUT_BUFFER_PCT)) return k;
		if (direction === 'above' && closeK > nlPrice * (1 + HS_BREAKOUT_BUFFER_PCT)) return k;
	}
	return -1;
}

// ── Helper: H&S / 逆H&S 用 target reached 判定（high/low ベース） ──
//
// 最終 close ベースだと、ブレイク後に一度 target 以下/以上まで動いてから戻ったケースで
// 未到達扱いされてしまう。実際には「ブレイク後に target を越えたか」を見たいので、
// breakoutIdx 以降のローソク足を走査して extremum（H&S なら min low / 逆H&S なら max high）を取り、
// その値で進捗率を計算する。

type HsTargetReachInfo = {
	targetReachedPct: number;
	targetReached: boolean;
	targetReachedDate?: string;
	targetReachedPrice: number;
};

function computeHsTargetReach(
	candles: CandleData[],
	breakoutIdx: number,
	breakoutPrice: number,
	target: number,
	direction: 'down' | 'up',
): HsTargetReachInfo | undefined {
	if (!Number.isFinite(breakoutPrice) || !Number.isFinite(target)) return undefined;
	const targetDistance = Math.abs(target - breakoutPrice);
	if (targetDistance <= EPSILON) return undefined;
	const startIdx = Math.max(0, breakoutIdx);
	if (startIdx >= candles.length) return undefined;

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
	// pct は「ブレイク価格から target に向かってどれだけ進んだか」を 100% スケールで返す。
	// 分母を Math.abs にして方向を明示することで、ブレイク足が深く動いて breakoutPrice が
	// 既に target を越えていた場合の符号反転（targetReached=true なのに pct<0）を防ぐ。
	const moveDistance = direction === 'down' ? breakoutPrice - extremePrice : extremePrice - breakoutPrice;
	let targetReachedPct = Math.round((moveDistance / targetDistance) * 100);
	if (targetReached) targetReachedPct = Math.max(100, targetReachedPct);
	targetReachedPct = Math.max(0, targetReachedPct);
	const targetReachedDate = candles[extremeIdx]?.isoTime;
	return {
		targetReachedPct,
		targetReached,
		...(targetReachedDate ? { targetReachedDate } : {}),
		targetReachedPrice: extremePrice,
	};
}

// ── Helper: ブレイク確認済み / 未確認に応じた完成フィールド ──
//
// 確認済み: status='completed', confirmation=neckline_breakout, breakout 系メタ一式 + outcome='success'
// 未確認:   status='near_completion', confirmation=not_confirmed
//
// `!p.status` を completed 扱いする detect_patterns.ts のフォールバック対策として
// 未確認時にも status を明示的に設定する。

type HsCompletionFields = {
	status: 'completed' | 'near_completion';
	confirmation: PatternConfirmation;
	breakout?: { idx: number; price: number };
	breakoutBarIndex?: number;
	breakoutDate?: string;
	breakoutDirection?: 'up' | 'down';
	outcome?: 'success';
	rangeEnd: string;
};

function buildHsCompletionFields(
	candles: CandleData[],
	breakoutIdx: number,
	direction: 'down' | 'up',
	structureEndIso: string,
): HsCompletionFields | null {
	if (breakoutIdx < 0) {
		return {
			status: 'near_completion',
			confirmation: { type: 'not_confirmed' },
			rangeEnd: structureEndIso,
		};
	}
	const breakoutDate = candles[breakoutIdx]?.isoTime;
	const breakoutPrice = Number(candles[breakoutIdx]?.close ?? NaN);
	if (!breakoutDate || !Number.isFinite(breakoutPrice)) return null;
	return {
		status: 'completed',
		confirmation: {
			type: 'neckline_breakout',
			date: breakoutDate,
			idx: breakoutIdx,
			price: breakoutPrice,
		},
		breakout: { idx: breakoutIdx, price: breakoutPrice },
		breakoutBarIndex: breakoutIdx,
		breakoutDate,
		breakoutDirection: direction === 'down' ? 'down' : 'up',
		outcome: 'success',
		rangeEnd: breakoutDate,
	};
}

// ── Helper: Strict Inverse H&S (L-H-L-H-L) ──

function findStrictInverseHS(ctx: DetectContext): { patterns: DeduplicablePattern[]; found: boolean } {
	const { candles, pivots, tolerancePct, minDist, near, debugCandidates } = ctx;
	const patterns: DeduplicablePattern[] = [];
	let found = false;

	for (let i = 0; i < pivots.length - 4; i++) {
		const p0 = pivots[i],
			p1 = pivots[i + 1],
			p2 = pivots[i + 2],
			p3 = pivots[i + 3],
			p4 = pivots[i + 4];
		if (!(p0.kind === 'L' && p1.kind === 'H' && p2.kind === 'L' && p3.kind === 'H' && p4.kind === 'L')) continue;
		if (
			p1.idx - p0.idx < minDist ||
			p2.idx - p1.idx < minDist ||
			p3.idx - p2.idx < minDist ||
			p4.idx - p3.idx < minDist
		)
			continue;
		const shouldersNear = near(p0.price, p4.price) && isSameLevel(p0.price, p4.price, HS_SHOULDER_MAX_PCT);
		const headLower = p2.price < Math.min(p0.price, p4.price) * (1 - tolerancePct);
		const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
		if (shouldersNear && headLower && necklineCheck.ok) {
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (start && end) {
				const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'down_or_sideways');
				if (!trend.ok) {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				const neckline = [
					{ x: p1.idx, y: p1.price },
					{ x: p3.idx, y: p3.price },
				];
				const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct);
				const symmetry = clamp01(1 - relDev(p0.price, p4.price));
				const per = periodScoreDays(start, end);
				const base = (tolMargin + symmetry + per) / 3;
				const confidence = finalizeConf(base, 'inverse_head_and_shoulders');
				const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
				// 右肩後のネックライン上抜けを確認する。
				const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'above');
				const completion = buildHsCompletionFields(candles, breakoutIdx, 'up', end);
				if (!completion) continue;
				const rangeEnd = completion.rangeEnd;
				const diagram = generatePatternDiagram(
					'inverse_head_and_shoulders',
					[
						{ ...p0, date: candles[p0.idx]?.isoTime },
						{ ...p1, date: candles[p1.idx]?.isoTime },
						{ ...p2, date: candles[p2.idx]?.isoTime },
						{ ...p3, date: candles[p3.idx]?.isoTime },
						{ ...p4, date: candles[p4.idx]?.isoTime },
					],
					{ price: nlAvg },
					{ start, end: rangeEnd },
				);
				// ターゲットはブレイク日（または右肩日）時点のネックライン値を基準に算出する。
				const targetAnchorIdx = breakoutIdx >= 0 ? breakoutIdx : p4.idx;
				const nlAtAnchor = necklineAt(neckline, targetAnchorIdx);
				const ihsTarget = Math.round(
					(Number.isFinite(nlAtAnchor) ? nlAtAnchor : nlAvg) +
						((Number.isFinite(nlAtAnchor) ? nlAtAnchor : nlAvg) - p2.price),
				);
				const ihsReach = completion.breakout
					? computeHsTargetReach(candles, breakoutIdx, completion.breakout.price, ihsTarget, 'up')
					: undefined;
				const ihsPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);

				patterns.push({
					type: 'inverse_head_and_shoulders',
					confidence,
					range: { start, end: rangeEnd },
					structureRange: { start, end },
					status: completion.status,
					confirmation: completion.confirmation,
					...(completion.breakout ? { breakout: completion.breakout } : {}),
					...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
					...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
					...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
					...(completion.outcome ? { outcome: completion.outcome } : {}),
					...(ihsPrecedingTrend ? { precedingTrend: ihsPrecedingTrend } : {}),
					pivots: [p0, p1, p2, p3, p4],
					neckline,
					trendlineLabel: 'ネックライン',
					breakoutTarget: ihsTarget,
					targetMethod: 'neckline_projection' as const,
					...(ihsReach
						? {
								targetReachedPct: ihsReach.targetReachedPct,
								targetReached: ihsReach.targetReached,
								...(ihsReach.targetReachedDate ? { targetReachedDate: ihsReach.targetReachedDate } : {}),
								targetReachedPrice: ihsReach.targetReachedPrice,
							}
						: {}),
					structureDiagram: diagram,
				});
				found = true;
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: true,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					points: [
						{ role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: candles[p0.idx]?.isoTime },
						{ role: 'peak1', idx: p1.idx, price: p1.price, isoTime: candles[p1.idx]?.isoTime },
						{ role: 'head', idx: p2.idx, price: p2.price, isoTime: candles[p2.idx]?.isoTime },
						{ role: 'peak2', idx: p3.idx, price: p3.price, isoTime: candles[p3.idx]?.isoTime },
						{ role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: candles[p4.idx]?.isoTime },
					],
				});
			}
		} else {
			const reason = !shouldersNear
				? 'shoulders_not_near'
				: !headLower
					? 'head_not_lower'
					: !necklineCheck.ok
						? 'neckline_not_horizontal'
						: 'unknown';
			debugCandidates.push({
				type: 'inverse_head_and_shoulders',
				accepted: false,
				reason,
				details: {
					leftShoulder: p0.price,
					rightShoulder: p4.price,
					shouldersDiff: Math.abs(p0.price - p4.price),
					shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
					shoulderMaxPct: HS_SHOULDER_MAX_PCT,
					head: p2.price,
					thresholdPct: tolerancePct,
					necklineP1: p1.price,
					necklineP3: p3.price,
					necklineDiffPct: necklineCheck.diffPct,
					necklineMaxPct: HS_NECKLINE_MAX_PCT,
				},
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
			});
		}
	}

	return { patterns, found };
}

// ── Helper: Strict H&S (H-L-H-L-H) ──

function findStrictHS(ctx: DetectContext): { patterns: DeduplicablePattern[]; found: boolean } {
	const { candles, pivots, tolerancePct, minDist, near, debugCandidates } = ctx;
	const patterns: DeduplicablePattern[] = [];
	let found = false;

	for (let i = 0; i < pivots.length - 4; i++) {
		const p0 = pivots[i],
			p1 = pivots[i + 1],
			p2 = pivots[i + 2],
			p3 = pivots[i + 3],
			p4 = pivots[i + 4];
		if (!(p0.kind === 'H' && p1.kind === 'L' && p2.kind === 'H' && p3.kind === 'L' && p4.kind === 'H')) continue;
		if (
			p1.idx - p0.idx < minDist ||
			p2.idx - p1.idx < minDist ||
			p3.idx - p2.idx < minDist ||
			p4.idx - p3.idx < minDist
		)
			continue;
		const shouldersNear = near(p0.price, p4.price) && isSameLevel(p0.price, p4.price, HS_SHOULDER_MAX_PCT);
		const headHigher = p2.price > Math.max(p0.price, p4.price) * (1 + tolerancePct);
		const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
		if (shouldersNear && headHigher && necklineCheck.ok) {
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (start && end) {
				const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'up_or_sideways');
				if (!trend.ok) {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: false,
						reason: `prior_trend_mismatch:${trend.classification}`,
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
					continue;
				}
				if (trend.classification === 'insufficient_data') {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: true,
						reason: 'prior_trend_insufficient_data',
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				const neckline = [
					{ x: p1.idx, y: p1.price },
					{ x: p3.idx, y: p3.price },
				];
				const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct);
				const symmetry = clamp01(1 - relDev(p0.price, p4.price));
				const per = periodScoreDays(start, end);
				const base = (tolMargin + symmetry + per) / 3;
				const confidence = finalizeConf(base, 'head_and_shoulders');
				const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
				// 右肩後のネックライン下抜けを確認する。
				const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'below');
				const completion = buildHsCompletionFields(candles, breakoutIdx, 'down', end);
				if (!completion) continue;
				const rangeEnd = completion.rangeEnd;
				const diagram = generatePatternDiagram(
					'head_and_shoulders',
					[
						{ ...p0, date: candles[p0.idx]?.isoTime },
						{ ...p1, date: candles[p1.idx]?.isoTime },
						{ ...p2, date: candles[p2.idx]?.isoTime },
						{ ...p3, date: candles[p3.idx]?.isoTime },
						{ ...p4, date: candles[p4.idx]?.isoTime },
					],
					{ price: nlAvg },
					{ start, end: rangeEnd },
				);
				// ターゲットはブレイク日（または右肩日）時点のネックライン値を基準に算出する。
				const targetAnchorIdx = breakoutIdx >= 0 ? breakoutIdx : p4.idx;
				const nlAtAnchor = necklineAt(neckline, targetAnchorIdx);
				const hsTarget = Math.round(
					(Number.isFinite(nlAtAnchor) ? nlAtAnchor : nlAvg) -
						(p2.price - (Number.isFinite(nlAtAnchor) ? nlAtAnchor : nlAvg)),
				);
				const hsReach = completion.breakout
					? computeHsTargetReach(candles, breakoutIdx, completion.breakout.price, hsTarget, 'down')
					: undefined;
				const hsPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);

				patterns.push({
					type: 'head_and_shoulders',
					confidence,
					range: { start, end: rangeEnd },
					structureRange: { start, end },
					status: completion.status,
					confirmation: completion.confirmation,
					...(completion.breakout ? { breakout: completion.breakout } : {}),
					...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
					...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
					...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
					...(completion.outcome ? { outcome: completion.outcome } : {}),
					...(hsPrecedingTrend ? { precedingTrend: hsPrecedingTrend } : {}),
					pivots: [p0, p1, p2, p3, p4],
					neckline,
					trendlineLabel: 'ネックライン',
					breakoutTarget: hsTarget,
					targetMethod: 'neckline_projection' as const,
					...(hsReach
						? {
								targetReachedPct: hsReach.targetReachedPct,
								targetReached: hsReach.targetReached,
								...(hsReach.targetReachedDate ? { targetReachedDate: hsReach.targetReachedDate } : {}),
								targetReachedPrice: hsReach.targetReachedPrice,
							}
						: {}),
					structureDiagram: diagram,
				});
				found = true;
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: true,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					points: [
						{ role: 'left_shoulder', idx: p0.idx, price: p0.price, isoTime: candles[p0.idx]?.isoTime },
						{ role: 'valley1', idx: p1.idx, price: p1.price, isoTime: candles[p1.idx]?.isoTime },
						{ role: 'head', idx: p2.idx, price: p2.price, isoTime: candles[p2.idx]?.isoTime },
						{ role: 'valley2', idx: p3.idx, price: p3.price, isoTime: candles[p3.idx]?.isoTime },
						{ role: 'right_shoulder', idx: p4.idx, price: p4.price, isoTime: candles[p4.idx]?.isoTime },
					],
				});
			}
		} else {
			const reason = !shouldersNear
				? 'shoulders_not_near'
				: !headHigher
					? 'head_not_higher'
					: !necklineCheck.ok
						? 'neckline_not_horizontal'
						: 'unknown';
			debugCandidates.push({
				type: 'head_and_shoulders',
				accepted: false,
				reason,
				details: {
					leftShoulder: p0.price,
					rightShoulder: p4.price,
					shouldersDiff: Math.abs(p0.price - p4.price),
					shouldersDiffPct: Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)),
					shoulderMaxPct: HS_SHOULDER_MAX_PCT,
					head: p2.price,
					thresholdPct: tolerancePct,
					necklineP1: p1.price,
					necklineP3: p3.price,
					necklineDiffPct: necklineCheck.diffPct,
					necklineMaxPct: HS_NECKLINE_MAX_PCT,
				},
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
			});
		}
	}

	return { patterns, found };
}

// ── Helper: Relaxed H&S fallback ──

function findRelaxedHS(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, pivots, allValleys, tolerancePct, minDist, debugCandidates } = ctx;

	for (const factors of RELAXED_FACTORS) {
		for (let i = 0; i < pivots.length - 4; i++) {
			const p0 = pivots[i],
				p1 = pivots[i + 1],
				p2 = pivots[i + 2],
				p3 = pivots[i + 3],
				p4 = pivots[i + 4];
			if (!(p0.kind === 'H' && p1.kind === 'L' && p2.kind === 'H' && p3.kind === 'L' && p4.kind === 'H')) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			const shouldersNearRelaxed =
				Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)) <= tolerancePct * factors.shoulder &&
				isSameLevel(p0.price, p4.price, HS_SHOULDER_MAX_PCT);
			const headHigherRelaxed = p2.price > Math.max(p0.price, p4.price) * (1 + tolerancePct * factors.head);
			const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
			if (!shouldersNearRelaxed || !headHigherRelaxed || !necklineCheck.ok) {
				if (shouldersNearRelaxed && headHigherRelaxed && !necklineCheck.ok) {
					debugCandidates.push({
						type: 'head_and_shoulders',
						accepted: false,
						reason: 'neckline_not_horizontal',
						details: {
							leftShoulder: p0.price,
							rightShoulder: p4.price,
							head: p2.price,
							necklineP1: p1.price,
							necklineP3: p3.price,
							necklineDiffPct: necklineCheck.diffPct,
							necklineMaxPct: HS_NECKLINE_MAX_PCT,
						},
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				continue;
			}
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (!start || !end) continue;
			const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'up_or_sideways');
			if (!trend.ok) {
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: false,
					reason: `prior_trend_mismatch:${trend.classification}`,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}
			if (trend.classification === 'insufficient_data') {
				debugCandidates.push({
					type: 'head_and_shoulders',
					accepted: true,
					reason: 'prior_trend_insufficient_data',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
			}
			const valleyBetween = allValleys.filter((v: { idx: number }) => v.idx > p0.idx && v.idx < p4.idx);
			const postValleys = allValleys.filter((v: { idx: number }) => v.idx > p2.idx);
			const minValley = valleyBetween.length
				? valleyBetween.reduce((m, v) => (v.price < m.price ? v : m))
				: postValleys.length
					? postValleys.reduce((m, v) => (v.price < m.price ? v : m))
					: null;
			const nlY = minValley ? minValley.price : Math.min(p1.price, p3.price);
			const neckline = [
				{ x: p1.idx, y: nlY },
				{ x: p3.idx, y: nlY },
			];
			const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct * factors.shoulder);
			const symmetry = clamp01(1 - relDev(p0.price, p4.price));
			const per = periodScoreDays(start, end);
			const base = (tolMargin + symmetry + per) / 3;
			const confidence = finalizeConf(base * 0.95, 'head_and_shoulders');
			const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
			// 右肩後のネックライン下抜けを確認する。
			const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'below');
			const completion = buildHsCompletionFields(candles, breakoutIdx, 'down', end);
			if (!completion) continue;
			const rangeEnd = completion.rangeEnd;
			const diagram = generatePatternDiagram(
				'head_and_shoulders',
				[
					{ ...p0, date: candles[p0.idx]?.isoTime },
					{ ...p1, date: candles[p1.idx]?.isoTime },
					{ ...p2, date: candles[p2.idx]?.isoTime },
					{ ...p3, date: candles[p3.idx]?.isoTime },
					{ ...p4, date: candles[p4.idx]?.isoTime },
				],
				{ price: nlAvg },
				{ start, end: rangeEnd },
			);
			// nlY は水平ネックラインの y。breakout 時点でも同値なので nlY を直接使う。
			// TODO: relaxed H&S も strict と同じく 谷1→谷2 の傾きつきネックラインを使うべき。
			//       別 PR で検討（今回の主目的は target reached の high/low 化）。
			const hsRelTarget = Math.round(nlY - (p2.price - nlY));
			const hsRelReach = completion.breakout
				? computeHsTargetReach(candles, breakoutIdx, completion.breakout.price, hsRelTarget, 'down')
				: undefined;
			const hsRelPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);
			debugCandidates.push({
				type: 'head_and_shoulders',
				accepted: true,
				reason: 'fallback_relaxed',
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
			});
			return {
				type: 'head_and_shoulders',
				confidence,
				range: { start, end: rangeEnd },
				structureRange: { start, end },
				status: completion.status,
				confirmation: completion.confirmation,
				...(completion.breakout ? { breakout: completion.breakout } : {}),
				...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
				...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
				...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
				...(completion.outcome ? { outcome: completion.outcome } : {}),
				...(hsRelPrecedingTrend ? { precedingTrend: hsRelPrecedingTrend } : {}),
				pivots: [p0, p1, p2, p3, p4],
				neckline,
				trendlineLabel: 'ネックライン',
				breakoutTarget: hsRelTarget,
				targetMethod: 'neckline_projection' as const,
				...(hsRelReach
					? {
							targetReachedPct: hsRelReach.targetReachedPct,
							targetReached: hsRelReach.targetReached,
							...(hsRelReach.targetReachedDate ? { targetReachedDate: hsRelReach.targetReachedDate } : {}),
							targetReachedPrice: hsRelReach.targetReachedPrice,
						}
					: {}),
				structureDiagram: diagram,
				_fallback: `relaxed_hs_${factors.tag}`,
			};
		}
	}
	return null;
}

// ── Helper: Relaxed Inverse H&S fallback ──

function findRelaxedInverseHS(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, tolerancePct, minDist, debugCandidates } = ctx;

	for (const factors of RELAXED_FACTORS) {
		for (let i = 0; i < pivots.length - 4; i++) {
			const p0 = pivots[i],
				p1 = pivots[i + 1],
				p2 = pivots[i + 2],
				p3 = pivots[i + 3],
				p4 = pivots[i + 4];
			if (!(p0.kind === 'L' && p1.kind === 'H' && p2.kind === 'L' && p3.kind === 'H' && p4.kind === 'L')) continue;
			if (
				p1.idx - p0.idx < minDist ||
				p2.idx - p1.idx < minDist ||
				p3.idx - p2.idx < minDist ||
				p4.idx - p3.idx < minDist
			)
				continue;
			const shouldersNearRelaxed =
				Math.abs(p0.price - p4.price) / Math.max(1, Math.max(p0.price, p4.price)) <= tolerancePct * factors.shoulder &&
				isSameLevel(p0.price, p4.price, HS_SHOULDER_MAX_PCT);
			const headLowerRelaxed = p2.price < Math.min(p0.price, p4.price) * (1 - tolerancePct * factors.head);
			const necklineCheck = validateHorizontalNeckline(p1.price, p3.price, HS_NECKLINE_MAX_PCT);
			if (!(shouldersNearRelaxed && headLowerRelaxed && necklineCheck.ok)) {
				if (shouldersNearRelaxed && headLowerRelaxed && !necklineCheck.ok) {
					debugCandidates.push({
						type: 'inverse_head_and_shoulders',
						accepted: false,
						reason: 'neckline_not_horizontal',
						details: {
							leftShoulder: p0.price,
							rightShoulder: p4.price,
							head: p2.price,
							necklineP1: p1.price,
							necklineP3: p3.price,
							necklineDiffPct: necklineCheck.diffPct,
							necklineMaxPct: HS_NECKLINE_MAX_PCT,
						},
						indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
					});
				}
				continue;
			}
			const start = candles[p0.idx].isoTime;
			const end = candles[p4.idx].isoTime;
			if (!start || !end) continue;
			const trend = validatePriorTrend(candles, p0.idx, p4.idx - p0.idx, 'down_or_sideways');
			if (!trend.ok) {
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: false,
					reason: `prior_trend_mismatch:${trend.classification}`,
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
				continue;
			}
			if (trend.classification === 'insufficient_data') {
				debugCandidates.push({
					type: 'inverse_head_and_shoulders',
					accepted: true,
					reason: 'prior_trend_insufficient_data',
					indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
				});
			}
			const peaksBetween = allPeaks.filter((v: { idx: number }) => v.idx > p0.idx && v.idx < p4.idx);
			const postPeaks = allPeaks.filter((v: { idx: number }) => v.idx > p2.idx);
			const maxPeak = peaksBetween.length
				? peaksBetween.reduce((m, v) => (v.price > m.price ? v : m))
				: postPeaks.length
					? postPeaks.reduce((m, v) => (v.price > m.price ? v : m))
					: null;
			const nlY = maxPeak ? maxPeak.price : Math.max(p1.price, p3.price);
			const neckline = [
				{ x: p1.idx, y: nlY },
				{ x: p3.idx, y: nlY },
			];
			const tolMargin = marginFromRelDev(relDev(p0.price, p4.price), tolerancePct * factors.shoulder);
			const symmetry = clamp01(1 - relDev(p0.price, p4.price));
			const per = periodScoreDays(start, end);
			const base = (tolMargin + symmetry + per) / 3;
			const confidence = finalizeConf(base * 0.95, 'inverse_head_and_shoulders');
			const nlAvg = (Number(p1.price) + Number(p3.price)) / 2;
			// 右肩後のネックライン上抜けを確認する。
			const breakoutIdx = findHsBreakoutIdx(candles, neckline, p4.idx, 'above');
			const completion = buildHsCompletionFields(candles, breakoutIdx, 'up', end);
			if (!completion) continue;
			const rangeEnd = completion.rangeEnd;
			const diagram = generatePatternDiagram(
				'inverse_head_and_shoulders',
				[
					{ ...p0, date: candles[p0.idx]?.isoTime },
					{ ...p1, date: candles[p1.idx]?.isoTime },
					{ ...p2, date: candles[p2.idx]?.isoTime },
					{ ...p3, date: candles[p3.idx]?.isoTime },
					{ ...p4, date: candles[p4.idx]?.isoTime },
				],
				{ price: nlAvg },
				{ start, end: rangeEnd },
			);
			// nlY は水平ネックラインの y。breakout 時点でも同値なので nlY を直接使う。
			// TODO: relaxed Inverse H&S も strict と同じく 山1→山2 の傾きつきネックラインを使うべき。
			//       別 PR で検討（今回の主目的は target reached の high/low 化）。
			const ihsRelTarget = Math.round(nlY + (nlY - p2.price));
			const ihsRelReach = completion.breakout
				? computeHsTargetReach(candles, breakoutIdx, completion.breakout.price, ihsRelTarget, 'up')
				: undefined;
			const ihsRelPrecedingTrend = buildPrecedingTrend(candles, trend, p0.idx);
			debugCandidates.push({
				type: 'inverse_head_and_shoulders',
				accepted: true,
				reason: 'fallback_relaxed',
				indices: [p0.idx, p1.idx, p2.idx, p3.idx, p4.idx],
			});
			return {
				type: 'inverse_head_and_shoulders',
				confidence,
				range: { start, end: rangeEnd },
				structureRange: { start, end },
				status: completion.status,
				confirmation: completion.confirmation,
				...(completion.breakout ? { breakout: completion.breakout } : {}),
				...(completion.breakoutBarIndex !== undefined ? { breakoutBarIndex: completion.breakoutBarIndex } : {}),
				...(completion.breakoutDate ? { breakoutDate: completion.breakoutDate } : {}),
				...(completion.breakoutDirection ? { breakoutDirection: completion.breakoutDirection } : {}),
				...(completion.outcome ? { outcome: completion.outcome } : {}),
				...(ihsRelPrecedingTrend ? { precedingTrend: ihsRelPrecedingTrend } : {}),
				pivots: [p0, p1, p2, p3, p4],
				neckline,
				trendlineLabel: 'ネックライン',
				breakoutTarget: ihsRelTarget,
				targetMethod: 'neckline_projection' as const,
				...(ihsRelReach
					? {
							targetReachedPct: ihsRelReach.targetReachedPct,
							targetReached: ihsRelReach.targetReached,
							...(ihsRelReach.targetReachedDate ? { targetReachedDate: ihsRelReach.targetReachedDate } : {}),
							targetReachedPrice: ihsRelReach.targetReachedPrice,
						}
					: {}),
				structureDiagram: diagram,
				_fallback: `relaxed_ihs_${factors.tag}`,
			};
		}
	}
	return null;
}

// ── Helper: 形成中 H&S ──

function tryFormingHS(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, allPeaks, allValleys } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const daysPerBar = ctx.type === '1day' ? 1 : ctx.type === '1week' ? 7 : 1;

	const confirmedPeaks = allPeaks.filter((p) => p.idx < lastIdx - 2);
	if (confirmedPeaks.length < 2) return null;

	const head = confirmedPeaks.reduce((best, p) => (p.price > best.price ? p : best), confirmedPeaks[0]);

	// 左肩: 頭より左のピークで、頭より3%以上低い
	const leftCandidates = confirmedPeaks.filter((p) => p.idx < head.idx && head.price > p.price * 1.03);
	if (leftCandidates.length < 1) return null;
	const left = leftCandidates[leftCandidates.length - 1];

	// 頭後の谷を探す
	const postHeadValley = allValleys.find((v) => v.idx > head.idx && v.idx < lastIdx - 1);
	if (!postHeadValley) return null;

	// 右肩候補
	const rightPeakCandidates = allPeaks.filter(
		(p) =>
			p.idx > postHeadValley.idx &&
			p.price < head.price &&
			Math.abs(p.price - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT,
	);

	let rightShoulder: { idx: number; price: number } | null = rightPeakCandidates.length
		? rightPeakCandidates[rightPeakCandidates.length - 1]
		: null;
	let isProvisional = false;

	// 確定右肩がない場合、現在価格が左肩近傍なら暫定右肩
	if (!rightShoulder) {
		const nearLeft = Math.abs(currentPrice - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT;
		if (nearLeft && currentPrice < head.price && currentPrice > postHeadValley.price) {
			rightShoulder = { idx: lastIdx, price: currentPrice };
			isProvisional = true;
		}
	}
	if (!rightShoulder) return null;

	// 完成度計算
	const closeness =
		1 - Math.abs(rightShoulder.price - left.price) / Math.max(1e-12, left.price * FORMING_RIGHT_TOLERANCE_PCT);
	const progress = Math.max(0, Math.min(1, closeness));
	const completion = Math.min(1, (0.75 + 0.25 * progress) * (isProvisional ? 0.9 : 1.0));
	if (completion < FORMING_MIN_COMPLETION) return null;

	const formationBars = Math.max(0, rightShoulder.idx - left.idx);
	const patternDays = Math.round(formationBars * daysPerBar);
	if (patternDays < FORMING_MIN_DAYS || patternDays > FORMING_MAX_DAYS) return null;

	const trend = validatePriorTrend(candles, left.idx, rightShoulder.idx - left.idx, 'up_or_sideways');
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
		});
	}

	// ネックライン
	const preHeadValleys = allValleys.filter((v) => v.idx > left.idx && v.idx < head.idx);
	const preHeadValley = preHeadValleys.length
		? preHeadValleys.reduce((best, v) => (v.price < best.price ? v : best), preHeadValleys[0])
		: null;

	const neckline = preHeadValley
		? [
				{ x: preHeadValley.idx, y: preHeadValley.price },
				{ x: postHeadValley.idx, y: postHeadValley.price },
			]
		: [
				{ x: left.idx, y: postHeadValley.price },
				{ x: postHeadValley.idx, y: postHeadValley.price },
			];

	const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
	const confidence = Math.round(confBase * (isProvisional ? 0.9 : 1.0) * 100) / 100;

	// 形状不十分な forming 候補（confidence=0.01 等）が上位表示されるのを防ぐ。
	// detect_triples.ts と同じ閾値を使う。
	if (confidence < FORMING_MIN_CONFIDENCE) {
		ctx.debugCandidates.push({
			type: 'head_and_shoulders',
			accepted: false,
			reason: 'confidence_below_min_forming',
			indices: [left.idx, head.idx, postHeadValley.idx, rightShoulder.idx],
			details: { confidence, threshold: FORMING_MIN_CONFIDENCE },
		});
		return null;
	}

	const start = isoAt(left.idx);
	const end = isoAt(rightShoulder.idx);

	const formHsNl = neckline[0].y;
	const formHsTarget = Math.round(formHsNl - (head.price - formHsNl));
	const formHsStructureRange = start && end ? { start, end } : undefined;
	const formHsPrecedingTrend = buildPrecedingTrend(candles, trend, left.idx);

	return {
		type: 'head_and_shoulders',
		confidence,
		range: { start, end },
		...(formHsStructureRange ? { structureRange: formHsStructureRange } : {}),
		confirmation: { type: 'not_confirmed' },
		...(formHsPrecedingTrend ? { precedingTrend: formHsPrecedingTrend } : {}),
		status: 'forming',
		pivots: [
			{ idx: left.idx, price: left.price, kind: 'H' as const },
			{ idx: head.idx, price: head.price, kind: 'H' as const },
			{ idx: postHeadValley.idx, price: postHeadValley.price, kind: 'L' as const },
			{ idx: rightShoulder.idx, price: rightShoulder.price, kind: 'H' as const },
		],
		neckline,
		trendlineLabel: 'ネックライン',
		breakoutTarget: formHsTarget,
		targetMethod: 'neckline_projection' as const,
		completionPct: Math.round(completion * 100),
		_method: isProvisional ? 'forming_hs_provisional' : 'forming_hs',
	};
}

// ── Helper: 形成中 Inverse H&S ──

function tryFormingInverseHS(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, allPeaks, allValleys } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const daysPerBar = ctx.type === '1day' ? 1 : ctx.type === '1week' ? 7 : 1;

	const confirmedValleys = allValleys.filter((v) => v.idx < lastIdx - 2);
	if (confirmedValleys.length < 2) return null;

	const head = confirmedValleys.reduce((best, v) => (v.price < best.price ? v : best), confirmedValleys[0]);

	// 左肩: 頭より左の谷で、頭より3%以上高い
	const leftCandidates = confirmedValleys.filter((v) => v.idx < head.idx && head.price < v.price * 0.97);
	if (leftCandidates.length < 1) return null;
	const left = leftCandidates[leftCandidates.length - 1];

	// 頭後のピークを探す
	const postHeadPeak = allPeaks.find((p) => p.idx > head.idx && p.idx < lastIdx - 1);
	if (!postHeadPeak) return null;

	// 右肩候補
	const rightValleyCandidates = allValleys.filter(
		(v) =>
			v.idx > postHeadPeak.idx &&
			v.price > head.price &&
			Math.abs(v.price - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT,
	);

	let rightShoulder: { idx: number; price: number } | null = rightValleyCandidates.length
		? rightValleyCandidates[rightValleyCandidates.length - 1]
		: null;
	let isProvisional = false;

	// 確定右肩がない場合、現在価格が左肩近傍なら暫定右肩
	if (!rightShoulder) {
		const nearLeft = Math.abs(currentPrice - left.price) / Math.max(1, left.price) <= FORMING_RIGHT_TOLERANCE_PCT;
		if (nearLeft && currentPrice > head.price && currentPrice < postHeadPeak.price) {
			rightShoulder = { idx: lastIdx, price: currentPrice };
			isProvisional = true;
		}
	}
	if (!rightShoulder) return null;

	// 完成度計算
	const closeness =
		1 - Math.abs(rightShoulder.price - left.price) / Math.max(1e-12, left.price * FORMING_RIGHT_TOLERANCE_PCT);
	const progress = Math.max(0, Math.min(1, closeness));
	const completion = Math.min(1, (0.75 + 0.25 * progress) * (isProvisional ? 0.9 : 1.0));
	if (completion < FORMING_MIN_COMPLETION) return null;

	const formationBars = Math.max(0, rightShoulder.idx - left.idx);
	const patternDays = Math.round(formationBars * daysPerBar);
	if (patternDays < FORMING_MIN_DAYS || patternDays > FORMING_MAX_DAYS) return null;

	const trend = validatePriorTrend(candles, left.idx, rightShoulder.idx - left.idx, 'down_or_sideways');
	if (!trend.ok) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: `prior_trend_mismatch:${trend.classification}`,
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
		return null;
	}
	if (trend.classification === 'insufficient_data') {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: true,
			reason: 'prior_trend_insufficient_data',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
		});
	}

	// ネックライン
	const preHeadPeaks = allPeaks.filter((p) => p.idx > left.idx && p.idx < head.idx);
	const preHeadPeak = preHeadPeaks.length
		? preHeadPeaks.reduce((best, p) => (p.price > best.price ? p : best), preHeadPeaks[0])
		: null;

	const neckline = preHeadPeak
		? [
				{ x: preHeadPeak.idx, y: preHeadPeak.price },
				{ x: postHeadPeak.idx, y: postHeadPeak.price },
			]
		: [
				{ x: left.idx, y: postHeadPeak.price },
				{ x: postHeadPeak.idx, y: postHeadPeak.price },
			];

	const confBase = Math.min(1, Math.max(0, 0.6 * closeness + 0.4 * progress));
	const confidence = Math.round(confBase * (isProvisional ? 0.9 : 1.0) * 100) / 100;

	if (confidence < FORMING_MIN_CONFIDENCE) {
		ctx.debugCandidates.push({
			type: 'inverse_head_and_shoulders',
			accepted: false,
			reason: 'confidence_below_min_forming',
			indices: [left.idx, head.idx, postHeadPeak.idx, rightShoulder.idx],
			details: { confidence, threshold: FORMING_MIN_CONFIDENCE },
		});
		return null;
	}

	const start = isoAt(left.idx);
	const end = isoAt(rightShoulder.idx);

	const formIhsNl = neckline[0].y;
	const formIhsTarget = Math.round(formIhsNl + (formIhsNl - head.price));
	const formIhsStructureRange = start && end ? { start, end } : undefined;
	const formIhsPrecedingTrend = buildPrecedingTrend(candles, trend, left.idx);

	return {
		type: 'inverse_head_and_shoulders',
		confidence,
		range: { start, end },
		...(formIhsStructureRange ? { structureRange: formIhsStructureRange } : {}),
		confirmation: { type: 'not_confirmed' },
		...(formIhsPrecedingTrend ? { precedingTrend: formIhsPrecedingTrend } : {}),
		status: 'forming',
		pivots: [
			{ idx: left.idx, price: left.price, kind: 'L' as const },
			{ idx: head.idx, price: head.price, kind: 'L' as const },
			{ idx: postHeadPeak.idx, price: postHeadPeak.price, kind: 'H' as const },
			{ idx: rightShoulder.idx, price: rightShoulder.price, kind: 'L' as const },
		],
		neckline,
		trendlineLabel: 'ネックライン',
		breakoutTarget: formIhsTarget,
		targetMethod: 'neckline_projection' as const,
		completionPct: Math.round(completion * 100),
		_method: isProvisional ? 'forming_ihs_provisional' : 'forming_ihs',
	};
}

// ── Main ──

export function detectHeadAndShoulders(ctx: DetectContext): DetectResult {
	const { want, includeForming } = ctx;
	const patterns: DeduplicablePattern[] = [];

	// 3) Inverse H&S
	let foundInverseHS = false;
	if (want.size === 0 || want.has('inverse_head_and_shoulders')) {
		const result = findStrictInverseHS(ctx);
		patterns.push(...result.patterns);
		foundInverseHS = result.found;
	}

	// 3b) H&S
	let foundHS = false;
	if (want.size === 0 || want.has('head_and_shoulders')) {
		const result = findStrictHS(ctx);
		patterns.push(...result.patterns);
		foundHS = result.found;
	}

	// Relaxed fallback
	if (!foundHS && (want.size === 0 || want.has('head_and_shoulders'))) {
		const relaxed = findRelaxedHS(ctx);
		if (relaxed) {
			patterns.push(relaxed);
			foundHS = true;
		}
	}
	if (!foundInverseHS && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
		const relaxed = findRelaxedInverseHS(ctx);
		if (relaxed) {
			patterns.push(relaxed);
			foundInverseHS = true;
		}
	}

	// 3c) 形成中 H&S
	if (includeForming && (want.size === 0 || want.has('head_and_shoulders'))) {
		const forming = tryFormingHS(ctx);
		if (forming) patterns.push(forming);
	}

	// 3d) 形成中 Inverse H&S
	if (includeForming && (want.size === 0 || want.has('inverse_head_and_shoulders'))) {
		const forming = tryFormingInverseHS(ctx);
		if (forming) patterns.push(forming);
	}

	return { patterns, found: { head_and_shoulders: foundHS, inverse_head_and_shoulders: foundInverseHS } };
}
