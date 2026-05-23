/**
 * detect_patterns 系モジュール共通の型定義
 */
import type { Pivot } from './swing.js';

/** トレンドライン（線形回帰の結果） */
export interface TrendLine {
	slope: number;
	intercept: number;
	r2?: number;
	valueAt: (x: number) => number;
}

/** ウェッジ検出パラメータ */
export interface WedgeParams {
	minSlope?: number;
	slopeRatioMinRising?: number;
	slopeRatioMinFalling?: number;
	slopeRatioMin?: number;
	minWeakerSlopeRatio?: number;
	windowSizeMin?: number;
	windowSizeMax?: number;
}

/** パターンスコアの各構成要素 */
export interface PatternScoreComponents {
	fitScore: number;
	convergeScore: number;
	touchScore: number;
	alternationScore: number;
	insideScore: number;
	durationScore: number;
}

/** パターンスコアの重み */
export interface PatternScoreWeights {
	fit: number;
	converge: number;
	touch: number;
	alternation: number;
	inside: number;
	duration: number;
}

/** タッチポイント */
export interface TouchPoint {
	index: number;
	distance: number;
	isBreak: boolean;
}

/** evaluateTouchesEx の戻り値 */
export interface TouchResult {
	upperTouches: TouchPoint[];
	lowerTouches: TouchPoint[];
	upperQuality: number;
	lowerQuality: number;
	score: number;
}

/** 重複排除対象のパターンエントリ（最低限のフィールド + 任意の追加フィールド） */
export interface DeduplicablePattern {
	type?: string;
	confidence?: number;
	range?: { start: string; end: string; current?: string };
	pivots?: Array<{ idx?: number; price?: number; kind?: string }>;
	[key: string]: unknown;
}

/** ローソク足データ（detectSwingPoints 互換） */
export interface CandleData {
	open: number;
	close: number;
	high: number;
	low: number;
	isoTime?: string;
}

/** pushCand() に渡すデバッグ引数 */
export interface CandDebugArg {
	type: string;
	accepted: boolean;
	reason?: string;
	idxs?: number[];
	pts?: Array<{ role: string; idx: number; price: number }>;
}

/** debugCandidates 配列の要素 */
export interface CandDebugEntry {
	type: string;
	accepted: boolean;
	reason?: string;
	indices?: number[];
	points?: Array<{ role: string; idx: number; price: number; isoTime?: string }>;
	details?: unknown;
	status?: string;
	breakoutDirection?: string | null;
}

/**
 * パターン検出コンテキスト — 各検出モジュールが共有するデータとコンフィグ。
 * detectPatterns() が組み立てて各検出関数に渡す。
 */
export interface DetectContext {
	candles: CandleData[];
	pivots: Pivot[];
	allPeaks: Pivot[];
	allValleys: Pivot[];
	tolerancePct: number;
	minDist: number;
	/** 検出対象パターン種別。空 = 全種 */
	want: Set<string>;
	includeForming: boolean;
	/** デバッグ候補バッファ（各モジュールが直接 push する） */
	debugCandidates: CandDebugEntry[];
	/** 時間軸（'1day', '1hour', '1week' 等） */
	type: string;
	/** スイング深度 */
	swingDepth: number;
	/** 近接判定ヘルパー（tolerancePct ベース） */
	near: (a: number, b: number) => boolean;
	/** 変化率計算 */
	pct: (a: number, b: number) => number;
	/** R² 付き線形回帰 */
	lrWithR2: (pts: Array<{ x: number; y: number }>) => {
		slope: number;
		intercept: number;
		r2: number;
		valueAt: (x: number) => number;
	};
}

/** 各パターン検出関数の戻り値 */
export interface DetectResult {
	patterns: PatternEntry[];
	/** 検出成否フラグ（後続の relaxed パスに使用） */
	found?: Record<string, boolean>;
}

/** 事後分析結果 */
export interface AftermathResult {
	breakoutDate?: string | null;
	breakoutConfirmed: boolean;
	priceMove?: Record<string, { return: number; high: number; low: number } | null>;
	targetReached: boolean;
	theoreticalTarget?: number | null;
	outcome: string;
	daysToTarget?: number | null;
}

/** パターン構成点のみで張る期間（誤読防止のための追加フィールド）。詳細は schema 参照。 */
export interface PatternStructureRange {
	start: string;
	end: string;
}

/** 検出器自身が確認したブレイク情報。schema 参照。 */
export type PatternConfirmation =
	| { type: 'neckline_breakout'; date: string; idx: number; price: number }
	| { type: 'not_confirmed' };

/** 先行トレンド情報。schema 参照。 */
export interface PatternPrecedingTrend {
	start: string;
	end: string;
	direction: 'up' | 'down' | 'sideways' | 'insufficient_data';
	returnPct: number;
	lookbackBars: number;
}

/** パターンエントリ（検出結果の1件）— 共通フィールド＋任意拡張 */
export interface PatternEntry extends DeduplicablePattern {
	confidence?: number;
	timeframe?: string;
	timeframeLabel?: string;
	neckline?: Array<{ x?: number; y: number }>;
	structureDiagram?: { svg: string; artifact?: { identifier: string; title: string } };
	status?: string;
	breakout?: { idx: number; price: number; direction?: string } | null;
	structureRange?: PatternStructureRange;
	confirmation?: PatternConfirmation;
	precedingTrend?: PatternPrecedingTrend;
	breakoutDirection?: 'up' | 'down';
	outcome?: 'success' | 'failure' | string;
	breakoutTarget?: number;
	targetMethod?: string;
	targetReachedPct?: number;
	targetReached?: boolean;
	targetReachedDate?: string;
	targetReachedPrice?: number;
	trendlineLabel?: string;
	poleDirection?: 'up' | 'down';
	priorTrendDirection?: 'bullish' | 'bearish';
	flagpoleHeight?: number;
	retracementRatio?: number;
	isTrendContinuation?: boolean;
	apexDate?: string;
	daysToApex?: number;
	completionPct?: number;
	breakoutDate?: string;
	breakoutBarIndex?: number;
	daysSinceBreakout?: number;
	aftermath?: AftermathResult | null;
}

/** pushCand ヘルパー（デバッグ候補に isoTime を付加して追加） */
export function pushCand(ctx: DetectContext, arg: CandDebugArg): void {
	const points = (arg.pts || []).map((p) => ({
		...p,
		isoTime: (ctx.candles[p.idx] as CandleData | undefined)?.isoTime,
	}));
	ctx.debugCandidates.push({
		type: arg.type,
		accepted: arg.accepted,
		reason: arg.reason,
		indices: arg.idxs,
		points,
	});
}
