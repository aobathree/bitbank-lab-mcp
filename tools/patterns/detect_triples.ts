/**
 * Triple Top / Triple Bottom 検出（完成済み＋形成中）
 * detect_patterns.ts Section 6 / 6b から抽出
 */
import { generatePatternDiagram, type PatternDiagramData } from '../../lib/pattern-diagrams.js';
import { MIN_CONFIDENCE } from '../patterns/config.js';
import { daysPerBar, finalizeConf, periodScoreDays } from './helpers.js';
import { clamp01, relDev } from './regression.js';
import type { DeduplicablePattern, DetectContext, DetectResult } from './types.js';
import { pushCand } from './types.js';

// ── 定数 ──

const NECKLINE_SLOPE_LIMIT = 0.02;
const MAX_VALLEY_SPREAD = 0.015;
const FORMING_MAX_DAYS = 90;
const FORMING_MIN_DAYS = 21;
const FORMING_TOLERANCE_MULTIPLIER = 1.2;
const FORMING_MIN_COMPLETION = 0.4;
const FORMING_MIN_CONFIDENCE = 0.5;

type Pcand = (arg: Parameters<typeof pushCand>[1]) => void;

// ── Helper: Strict Triple Top ──

function findStrictTripleTop(ctx: DetectContext): DeduplicablePattern[] {
	const { candles, pivots, allValleys, tolerancePct, minDist, near } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const patterns: DeduplicablePattern[] = [];
	const highsOnly = pivots.filter((p) => p.kind === 'H');
	if (highsOnly.length < 3) return patterns;

	for (let i = 0; i <= highsOnly.length - 3; i++) {
		const a = highsOnly[i],
			b = highsOnly[i + 1],
			c = highsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		const nearAll = near(a.price, b.price) && near(b.price, c.price) && near(a.price, c.price);
		if (!nearAll) continue;
		const start = candles[a.idx].isoTime;
		const end = candles[c.idx].isoTime;
		if (!(start && end)) continue;

		// Additional strict checks: valleys equality and neckline slope
		const v1cands = allValleys.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const v2cands = allValleys.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const v1 = v1cands.length ? v1cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		const v2 = v2cands.length ? v2cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		if (!(v1 && v2)) {
			pcand({ type: 'triple_top', accepted: false, reason: 'valleys_missing', idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		const valleysNear = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price)) <= tolerancePct;
		const necklineSlope = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price));
		const necklineValid = necklineSlope <= NECKLINE_SLOPE_LIMIT;
		if (!(valleysNear && necklineValid)) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: !valleysNear ? 'valleys_not_equal' : 'neckline_slope_excess',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
		const tolMargin = clamp01(1 - devs.reduce((s, v) => s + v, 0) / devs.length / Math.max(1e-12, tolerancePct));
		const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
		const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
		const per = periodScoreDays(start, end);
		const base = (tolMargin + symmetry + per) / 3;
		const confidence = finalizeConf(base, 'triple_top');
		const nlAvg = (Number(v1.price) + Number(v2.price)) / 2;
		const neckline = [
			{ x: a.idx, y: nlAvg },
			{ x: c.idx, y: nlAvg },
		];
		let diagram: PatternDiagramData | undefined;
		diagram = generatePatternDiagram(
			'triple_top',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...v1, date: candles[v1.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...v2, date: candles[v2.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: nlAvg },
			{ start, end },
		);
		if (confidence >= (MIN_CONFIDENCE.triple_top ?? 0)) {
			const ttAvgPeak = (a.price + b.price + c.price) / 3;
			const ttTarget = nlAvg != null ? Math.round(nlAvg - (ttAvgPeak - nlAvg)) : undefined;
			patterns.push({
				type: 'triple_top',
				confidence,
				range: { start, end },
				pivots: [a, b, c],
				...(neckline ? { neckline, trendlineLabel: 'ネックライン' } : {}),
				...(ttTarget !== undefined ? { breakoutTarget: ttTarget, targetMethod: 'neckline_projection' as const } : {}),
				...(diagram ? { structureDiagram: diagram } : {}),
			});
			pcand({
				type: 'triple_top',
				accepted: true,
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: b.idx, price: b.price },
					{ role: 'peak3', idx: c.idx, price: c.price },
				],
			});
		} else {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'confidence_below_min',
				idxs: [a.idx, b.idx, c.idx],
			});
		}
	}

	return patterns;
}

// ── Helper: Strict Triple Bottom ──

function findStrictTripleBottom(ctx: DetectContext): DeduplicablePattern[] {
	const { candles, pivots, allPeaks, tolerancePct, minDist, near } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const patterns: DeduplicablePattern[] = [];
	const lowsOnly = pivots.filter((p) => p.kind === 'L');
	if (lowsOnly.length < 3) return patterns;

	for (let i = 0; i <= lowsOnly.length - 3; i++) {
		const a = lowsOnly[i],
			b = lowsOnly[i + 1],
			c = lowsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		const nearAll = near(a.price, b.price) && near(b.price, c.price) && near(a.price, c.price);
		if (!nearAll) continue;
		const start = candles[a.idx].isoTime;
		const end = candles[c.idx].isoTime;
		if (!(start && end)) continue;

		// Additional strict checks: 3 valleys near + spread limit, peaks near and neckline slope limit
		const valleyPrices = [a.price, b.price, c.price];
		const valleyNearStrict = near(a.price, b.price) && near(b.price, c.price) && near(a.price, c.price);
		const valleyMin = Math.min(...valleyPrices);
		const valleyMax = Math.max(...valleyPrices);
		const valleySpreadValid = (valleyMax - valleyMin) / Math.max(1, valleyMin) <= MAX_VALLEY_SPREAD;
		const p1cands = allPeaks.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const p2cands = allPeaks.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const p1 = p1cands.length ? p1cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		const p2 = p2cands.length ? p2cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		if (!(p1 && p2)) {
			pcand({ type: 'triple_bottom', accepted: false, reason: 'peaks_missing', idxs: [a.idx, b.idx, c.idx] });
			continue;
		}
		const peaksNear = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price)) <= tolerancePct;
		const necklineSlope = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price));
		const necklineValid = necklineSlope <= NECKLINE_SLOPE_LIMIT;
		if (!(valleyNearStrict && valleySpreadValid && peaksNear && necklineValid)) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: !valleyNearStrict
					? 'valleys_not_equal'
					: !valleySpreadValid
						? 'valley_spread_excess'
						: !peaksNear
							? 'peaks_not_equal'
							: 'neckline_slope_excess',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
		const tolMargin = clamp01(1 - devs.reduce((s, v) => s + v, 0) / devs.length / Math.max(1e-12, tolerancePct));
		const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
		const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
		const per = periodScoreDays(start, end);
		const base = (tolMargin + symmetry + per) / 3;
		const confidence = finalizeConf(base, 'triple_bottom');
		const nlAvg = (Number(p1.price) + Number(p2.price)) / 2;
		const neckline = [
			{ x: a.idx, y: nlAvg },
			{ x: c.idx, y: nlAvg },
		];
		let diagram: PatternDiagramData | undefined;
		diagram = generatePatternDiagram(
			'triple_bottom',
			[
				{ ...a, date: candles[a.idx]?.isoTime },
				{ ...p1, date: candles[p1.idx]?.isoTime },
				{ ...b, date: candles[b.idx]?.isoTime },
				{ ...p2, date: candles[p2.idx]?.isoTime },
				{ ...c, date: candles[c.idx]?.isoTime },
			],
			{ price: nlAvg },
			{ start, end },
		);
		if (confidence >= (MIN_CONFIDENCE.triple_bottom ?? 0)) {
			const tbAvgValley = (a.price + b.price + c.price) / 3;
			const tbTarget = nlAvg != null ? Math.round(nlAvg + (nlAvg - tbAvgValley)) : undefined;
			patterns.push({
				type: 'triple_bottom',
				confidence,
				range: { start, end },
				pivots: [a, b, c],
				...(neckline ? { neckline, trendlineLabel: 'ネックライン' } : {}),
				...(tbTarget !== undefined ? { breakoutTarget: tbTarget, targetMethod: 'neckline_projection' as const } : {}),
				...(diagram ? { structureDiagram: diagram } : {}),
			});
			pcand({
				type: 'triple_bottom',
				accepted: true,
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: b.idx, price: b.price },
					{ role: 'valley3', idx: c.idx, price: c.price },
				],
			});
		} else {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'confidence_below_min',
				idxs: [a.idx, b.idx, c.idx],
			});
		}
	}

	return patterns;
}

// ── Helper: Relaxed Triple Top fallback ──

function findRelaxedTripleTop(ctx: DetectContext, factor: number): DeduplicablePattern | null {
	const { candles, pivots, allValleys, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const tolTriple = tolerancePct * factor;
	const nearTriple = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.max(x, y)) <= tolTriple;
	const highsOnly = pivots.filter((p) => p.kind === 'H');

	for (let i = 0; i <= highsOnly.length - 3; i++) {
		const a = highsOnly[i],
			b = highsOnly[i + 1],
			c = highsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'peaks_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'peak1', idx: a.idx, price: a.price },
					{ role: 'peak2', idx: b.idx, price: b.price },
					{ role: 'peak3', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const start = candles[a.idx].isoTime,
			end = candles[c.idx].isoTime;
		if (!start || !end) continue;
		const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
		const tolMargin = clamp01(1 - devs.reduce((s, v) => s + v, 0) / devs.length / Math.max(1e-12, tolTriple));
		const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
		const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
		const per = periodScoreDays(start, end);
		const base = (tolMargin + symmetry + per) / 3;
		const confidence = finalizeConf(base * 0.95, 'triple_top');
		// valleys for neckline & diagram
		const v1cands = allValleys.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const v2cands = allValleys.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const v1 = v1cands.length ? v1cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		const v2 = v2cands.length ? v2cands.reduce((m, v) => (v.price < m.price ? v : m)) : null;
		const nlAvg = v1 && v2 ? (Number(v1.price) + Number(v2.price)) / 2 : null;
		if (!(v1 && v2)) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'valleys_missing_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const necklineSlope = Math.abs(v1.price - v2.price) / Math.max(1, Math.max(v1.price, v2.price));
		if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
			pcand({
				type: 'triple_top',
				accepted: false,
				reason: 'neckline_slope_excess_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		let diagram: PatternDiagramData | undefined;
		const neckline =
			v1 && v2
				? [
						{ x: a.idx, y: nlAvg },
						{ x: c.idx, y: nlAvg },
					]
				: undefined;
		if (v1 && v2) {
			diagram = generatePatternDiagram(
				'triple_top',
				[
					{ ...a, date: candles[a.idx]?.isoTime },
					{ ...v1, date: candles[v1.idx]?.isoTime },
					{ ...b, date: candles[b.idx]?.isoTime },
					{ ...v2, date: candles[v2.idx]?.isoTime },
					{ ...c, date: candles[c.idx]?.isoTime },
				],
				{ price: nlAvg ?? Number(b.price) },
				{ start, end },
			);
		}
		if (confidence >= (MIN_CONFIDENCE.triple_top ?? 0)) {
			const ttRelAvgPeak = (a.price + b.price + c.price) / 3;
			const ttRelTarget = nlAvg != null ? Math.round(nlAvg - (ttRelAvgPeak - nlAvg)) : undefined;
			return {
				type: 'triple_top',
				confidence,
				range: { start, end },
				pivots: [a, b, c],
				...(neckline ? { neckline, trendlineLabel: 'ネックライン' } : {}),
				...(ttRelTarget !== undefined
					? { breakoutTarget: ttRelTarget, targetMethod: 'neckline_projection' as const }
					: {}),
				...(diagram ? { structureDiagram: diagram } : {}),
				_fallback: `relaxed_triple_x${factor}`,
			};
		}
		pcand({
			type: 'triple_top',
			accepted: false,
			reason: 'confidence_below_min_relaxed',
			idxs: [a.idx, b.idx, c.idx],
		});
		return null; // 構造的に有効な候補だったが confidence 不足 — この factor では停止
	}
	return null;
}

// ── Helper: Relaxed Triple Bottom fallback ──

function findRelaxedTripleBottom(ctx: DetectContext, factor: number): DeduplicablePattern | null {
	const { candles, pivots, allPeaks, tolerancePct, minDist } = ctx;
	const pcand: Pcand = (arg) => pushCand(ctx, arg);
	const tolTriple = tolerancePct * factor;
	const nearTriple = (x: number, y: number) => Math.abs(x - y) / Math.max(1, Math.max(x, y)) <= tolTriple;
	const lowsOnly = pivots.filter((p) => p.kind === 'L');

	for (let i = 0; i <= lowsOnly.length - 3; i++) {
		const a = lowsOnly[i],
			b = lowsOnly[i + 1],
			c = lowsOnly[i + 2];
		if (b.idx - a.idx < minDist || c.idx - b.idx < minDist) continue;
		if (!(nearTriple(a.price, b.price) && nearTriple(b.price, c.price))) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'valleys_not_equal_relaxed',
				idxs: [a.idx, b.idx, c.idx],
				pts: [
					{ role: 'valley1', idx: a.idx, price: a.price },
					{ role: 'valley2', idx: b.idx, price: b.price },
					{ role: 'valley3', idx: c.idx, price: c.price },
				],
			});
			continue;
		}
		const start = candles[a.idx].isoTime,
			end = candles[c.idx].isoTime;
		if (!start || !end) continue;
		const devs = [relDev(a.price, b.price), relDev(b.price, c.price), relDev(a.price, c.price)];
		const tolMargin = clamp01(1 - devs.reduce((s, v) => s + v, 0) / devs.length / Math.max(1e-12, tolTriple));
		const span = Math.max(a.price, b.price, c.price) - Math.min(a.price, b.price, c.price);
		const symmetry = clamp01(1 - span / Math.max(1, Math.max(a.price, b.price, c.price)));
		const per = periodScoreDays(start, end);
		const base = (tolMargin + symmetry + per) / 3;
		const confidence = finalizeConf(base * 0.95, 'triple_bottom');
		// peaks for neckline & diagram
		const p1cands = allPeaks.filter((v: { idx: number }) => v.idx > a.idx && v.idx < b.idx);
		const p2cands = allPeaks.filter((v: { idx: number }) => v.idx > b.idx && v.idx < c.idx);
		const p1 = p1cands.length ? p1cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		const p2 = p2cands.length ? p2cands.reduce((m, v) => (v.price > m.price ? v : m)) : null;
		const nlAvg = p1 && p2 ? (Number(p1.price) + Number(p2.price)) / 2 : null;
		if (!(p1 && p2)) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'peaks_missing_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		const necklineSlope = Math.abs(p1.price - p2.price) / Math.max(1, Math.max(p1.price, p2.price));
		if (necklineSlope > NECKLINE_SLOPE_LIMIT) {
			pcand({
				type: 'triple_bottom',
				accepted: false,
				reason: 'neckline_slope_excess_relaxed',
				idxs: [a.idx, b.idx, c.idx],
			});
			continue;
		}
		let diagram: PatternDiagramData | undefined;
		const neckline =
			p1 && p2
				? [
						{ x: a.idx, y: nlAvg },
						{ x: c.idx, y: nlAvg },
					]
				: undefined;
		if (p1 && p2) {
			diagram = generatePatternDiagram(
				'triple_bottom',
				[
					{ ...a, date: candles[a.idx]?.isoTime },
					{ ...p1, date: candles[p1.idx]?.isoTime },
					{ ...b, date: candles[b.idx]?.isoTime },
					{ ...p2, date: candles[p2.idx]?.isoTime },
					{ ...c, date: candles[c.idx]?.isoTime },
				],
				{ price: nlAvg ?? Number(b.price) },
				{ start, end },
			);
		}
		if (confidence >= (MIN_CONFIDENCE.triple_bottom ?? 0)) {
			const tbRelAvgValley = (a.price + b.price + c.price) / 3;
			const tbRelTarget = nlAvg != null ? Math.round(nlAvg + (nlAvg - tbRelAvgValley)) : undefined;
			return {
				type: 'triple_bottom',
				confidence,
				range: { start, end },
				pivots: [a, b, c],
				...(neckline ? { neckline, trendlineLabel: 'ネックライン' } : {}),
				...(tbRelTarget !== undefined
					? { breakoutTarget: tbRelTarget, targetMethod: 'neckline_projection' as const }
					: {}),
				...(diagram ? { structureDiagram: diagram } : {}),
				_fallback: `relaxed_triple_x${factor}`,
			};
		}
		pcand({
			type: 'triple_bottom',
			accepted: false,
			reason: 'confidence_below_min_relaxed',
			idxs: [a.idx, b.idx, c.idx],
		});
		return null; // 構造的に有効な候補だったが confidence 不足 — この factor では停止
	}
	return null;
}

// ── Helper: 形成中 Triple Top ──

function tryFormingTripleTop(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, allPeaks, allValleys, tolerancePct, minDist } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const dpb = daysPerBar(ctx.type);
	const tripleTolerancePct = tolerancePct * FORMING_TOLERANCE_MULTIPLIER;

	if (allPeaks.length < 2) return null;
	const confirmedPeaks = allPeaks.filter((p: { idx: number }) => p.idx < lastIdx - 2);

	for (let i = confirmedPeaks.length - 1; i >= 1; i--) {
		const peak2 = confirmedPeaks[i];
		const peak1 = confirmedPeaks[i - 1];
		if (peak2.idx - peak1.idx < minDist) continue;

		const peakDiff = Math.abs(peak1.price - peak2.price) / Math.max(1, Math.max(peak1.price, peak2.price));
		if (peakDiff > tripleTolerancePct) continue;

		const avgPeakPrice = (peak1.price + peak2.price) / 2;
		const currentDiff = Math.abs(currentPrice - avgPeakPrice) / Math.max(1, avgPeakPrice);
		if (currentDiff > tripleTolerancePct || currentPrice < avgPeakPrice * 0.95) continue;

		const formationBars = Math.max(0, lastIdx - peak1.idx);
		const patternDays = Math.round(formationBars * dpb);
		if (patternDays < FORMING_MIN_DAYS || patternDays > FORMING_MAX_DAYS) continue;

		const progress = Math.min(1, currentPrice / avgPeakPrice);
		const completion = Math.min(1, 0.66 + progress * 0.34);
		const confidence = Math.round((1 - currentDiff / tripleTolerancePct) * 0.8 * 100) / 100;

		if (completion < FORMING_MIN_COMPLETION || confidence < FORMING_MIN_CONFIDENCE) continue;

		// ネックライン（谷の平均）
		const valleysBetween = allValleys.filter((v: { idx: number }) => v.idx > peak1.idx && v.idx < lastIdx);
		const avgValley = valleysBetween.length
			? valleysBetween.reduce((s: number, v: { price: number }) => s + v.price, 0) / valleysBetween.length
			: Math.min(peak1.price, peak2.price) * 0.95;
		const neckline = [
			{ x: peak1.idx, y: avgValley },
			{ x: lastIdx, y: avgValley },
		];

		const formTtTarget = Math.round(avgValley - ((peak1.price + peak2.price) / 2 - avgValley));
		return {
			type: 'triple_top',
			confidence,
			range: { start: isoAt(peak1.idx), end: isoAt(lastIdx) },
			status: 'forming',
			pivots: [
				{ idx: peak1.idx, price: peak1.price, kind: 'H' as const },
				{ idx: peak2.idx, price: peak2.price, kind: 'H' as const },
			],
			neckline,
			trendlineLabel: 'ネックライン',
			breakoutTarget: formTtTarget,
			targetMethod: 'neckline_projection' as const,
			completionPct: Math.round(completion * 100),
			_method: 'forming_triple_top',
		};
	}
	return null;
}

// ── Helper: 形成中 Triple Bottom ──

function tryFormingTripleBottom(ctx: DetectContext): DeduplicablePattern | null {
	const { candles, allPeaks, allValleys, tolerancePct, minDist } = ctx;
	const lastIdx = candles.length - 1;
	const currentPrice = Number(candles[lastIdx]?.close ?? NaN);
	const isoAt = (i: number) => candles[i]?.isoTime || '';
	const dpb = daysPerBar(ctx.type);
	const tripleTolerancePct = tolerancePct * FORMING_TOLERANCE_MULTIPLIER;

	if (allValleys.length < 2) return null;
	const confirmedValleys = allValleys.filter((v: { idx: number }) => v.idx < lastIdx - 2);

	for (let i = confirmedValleys.length - 1; i >= 1; i--) {
		const valley2 = confirmedValleys[i];
		const valley1 = confirmedValleys[i - 1];
		if (valley2.idx - valley1.idx < minDist) continue;

		const valleyDiff = Math.abs(valley1.price - valley2.price) / Math.max(1, Math.max(valley1.price, valley2.price));
		if (valleyDiff > tripleTolerancePct) continue;

		const avgValleyPrice = (valley1.price + valley2.price) / 2;

		// ネックライン（ピークの平均）
		const peaksBetween = allPeaks.filter((p: { idx: number }) => p.idx > valley1.idx && p.idx < lastIdx);
		if (peaksBetween.length === 0) continue;
		const avgPeakPrice = peaksBetween.reduce((s: number, p: { price: number }) => s + p.price, 0) / peaksBetween.length;

		// 現在価格が谷とネックラインの間にあるか
		if (currentPrice < avgValleyPrice * 0.98 || currentPrice > avgPeakPrice * 1.02) continue;

		const formationBars = Math.max(0, lastIdx - valley1.idx);
		const patternDays = Math.round(formationBars * dpb);
		if (patternDays < FORMING_MIN_DAYS || patternDays > FORMING_MAX_DAYS) continue;

		const progress = (currentPrice - avgValleyPrice) / Math.max(1e-12, avgPeakPrice - avgValleyPrice);
		const completion = Math.min(1, 0.66 + Math.min(1, progress) * 0.34);
		const confidence = Math.round((1 - valleyDiff / tripleTolerancePct) * 0.8 * 100) / 100;

		if (completion < FORMING_MIN_COMPLETION || confidence < FORMING_MIN_CONFIDENCE) continue;

		const neckline = [
			{ x: valley1.idx, y: avgPeakPrice },
			{ x: lastIdx, y: avgPeakPrice },
		];

		const formTbTarget = Math.round(avgPeakPrice + (avgPeakPrice - avgValleyPrice));
		return {
			type: 'triple_bottom',
			confidence,
			range: { start: isoAt(valley1.idx), end: isoAt(lastIdx) },
			status: 'forming',
			pivots: [
				{ idx: valley1.idx, price: valley1.price, kind: 'L' as const },
				{ idx: valley2.idx, price: valley2.price, kind: 'L' as const },
			],
			neckline,
			trendlineLabel: 'ネックライン',
			breakoutTarget: formTbTarget,
			targetMethod: 'neckline_projection' as const,
			completionPct: Math.round(completion * 100),
			_method: 'forming_triple_bottom',
		};
	}
	return null;
}

// ── Main ──

export function detectTriples(ctx: DetectContext): DetectResult {
	const { want, includeForming } = ctx;
	const patterns: DeduplicablePattern[] = [];

	const wantTripleTop = want.size === 0 || want.has('triple_top');
	const wantTripleBottom = want.size === 0 || want.has('triple_bottom');

	if (wantTripleTop || wantTripleBottom) {
		if (wantTripleTop) patterns.push(...findStrictTripleTop(ctx));
		if (wantTripleBottom) patterns.push(...findStrictTripleBottom(ctx));

		// relaxed fallback (multi-stage 1.25, 2.0)
		for (const f of [1.25, 2.0]) {
			if (wantTripleTop && !patterns.some((p) => p.type === 'triple_top')) {
				const relaxed = findRelaxedTripleTop(ctx, f);
				if (relaxed) patterns.push(relaxed);
			}
			if (wantTripleBottom && !patterns.some((p) => p.type === 'triple_bottom')) {
				const relaxed = findRelaxedTripleBottom(ctx, f);
				if (relaxed) patterns.push(relaxed);
			}
		}
	}

	// 6b) 形成中トリプルトップ/ボトム
	if (includeForming && (wantTripleTop || wantTripleBottom)) {
		if (wantTripleTop) {
			const forming = tryFormingTripleTop(ctx);
			if (forming) patterns.push(forming);
		}
		if (wantTripleBottom) {
			const forming = tryFormingTripleBottom(ctx);
			if (forming) patterns.push(forming);
		}
	}

	return { patterns };
}
