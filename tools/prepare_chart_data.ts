/**
 * prepare_chart_data — Visualizer / チャート描画用の時系列データを返す。
 *
 * analyze_indicators の chart (ChartPayload) を内部で呼び出し、
 * コンパクトな配列形式に整形して返す。
 * 一目均衡表の chikou シフトは適用済み。
 *
 * デフォルトではローソク足（OHLCV）のみ返す。
 * indicators パラメータで指標グループを明示指定した場合のみ、その系列を付加する。
 */

import { dayjs, toIsoWithTz } from '../lib/datetime.js';
import { fail, failFromError, ok, toStructured } from '../lib/result.js';
import { createMeta, ensurePair } from '../lib/validate.js';
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';
import type { Candle, FailResult, NumericSeries, OkResult } from '../src/schemas.js';
import { PrepareChartDataInputSchema } from '../src/schemas.js';
import type { ToolDefinition } from '../src/tool-definition.js';
import analyzeIndicators from './analyze_indicators.js';

// ── candles 配列の各要素の意味 ──
const CANDLE_FORMAT = ['open', 'high', 'low', 'close', 'volume'] as const;

// ── 指標グループ → chart.indicators キーのマッピング ──

const MAIN_SERIES_KEYS: Record<string, string[]> = {
	SMA_5: ['SMA_5'],
	SMA_20: ['SMA_20'],
	SMA_25: ['SMA_25'],
	SMA_50: ['SMA_50'],
	SMA_75: ['SMA_75'],
	SMA_200: ['SMA_200'],
	EMA_12: ['EMA_12'],
	EMA_26: ['EMA_26'],
	EMA_50: ['EMA_50'],
	EMA_200: ['EMA_200'],
	BB: ['BB_upper', 'BB_middle', 'BB_lower'],
	ICHIMOKU: ['ICHI_tenkan', 'ICHI_kijun', 'ICHI_spanA', 'ICHI_spanB', 'ICHI_chikou'],
};

/** JPY ペアかどうか判定 */
function isJpyPair(pair: string): boolean {
	return pair.endsWith('_jpy');
}

/** 数値を丸める（JPY ペアは整数、それ以外は小数2桁） */
function roundValue(v: number | null, jpyPair: boolean): number | null {
	if (v === null) return null;
	return jpyPair ? Math.round(v) : Number(v.toFixed(2));
}

/** 系列が全て null かどうか判定 */
function isAllNull(series: NumericSeries): boolean {
	return series.every((v) => v === null);
}

/** NumericSeries → 丸め済み値配列（全 null なら undefined） */
function toRoundedArray(series: NumericSeries, jpyPair: boolean): (number | null)[] | undefined {
	if (isAllNull(series)) return undefined;
	return series.map((v) => roundValue(v, jpyPair));
}

// ── コンパクト出力型 ──

interface CompactCandle {
	/** [open, high, low, close, volume] */
	ohlcv: number[];
}

interface CompactSubPanels {
	RSI_14?: (number | null)[];
	MACD?: { line: (number | null)[]; signal: (number | null)[]; hist: (number | null)[] };
	STOCH_K?: (number | null)[];
	STOCH_D?: (number | null)[];
}

interface PrepareChartDataResult {
	times: string[];
	labels?: string[];
	candleFormat: readonly string[];
	candles: CompactCandle['ohlcv'][];
	series?: Record<string, (number | null)[]>;
	subPanels?: CompactSubPanels;
}

interface PrepareChartDataMeta {
	pair: string;
	type: string;
	count: number;
	indicators: string[];
	volumeUnit: string;
	/** 上流 get_candles → analyze_indicators から伝播した取得層の警告。partial fetch 等。 */
	warning?: string;
	/** 上流 analyze_indicators の指標不足警告（"SMA_200: データ不足" 等）。warning とは別系統。 */
	warnings?: string[];
}

/**
 * CandleType に応じた短縮ラベルフォーマットを返す。
 * 日足以上は "MM/DD"、それ以外は "MM/DD HH:mm"。
 */
function labelFormat(candleType: string): string {
	switch (candleType) {
		case '1day':
		case '1week':
		case '1month':
			return 'MM/DD';
		default:
			return 'MM/DD HH:mm';
	}
}

export default async function prepareChartData(
	pair: string = 'btc_jpy',
	type: string = '1day',
	limit: number = 30,
	indicators?: string[],
	tz: string = 'Asia/Tokyo',
): Promise<OkResult<PrepareChartDataResult, PrepareChartDataMeta> | FailResult> {
	const chk = ensurePair(pair);
	if (!chk.ok) return fail(chk.error.message, chk.error.type);

	// サーバー側ガード: limit × インジケーター系列数がしきい値を超える場合、limit を自動切り詰め
	const MAX_TOTAL_SERIES = 150; // limit × (1 + indicatorCount) の上限
	const indicatorCount = indicators?.length ?? 0;
	const seriesMultiplier = 1 + indicatorCount; // 1 = OHLCV 本体
	let effectiveLimit = limit;
	if (seriesMultiplier > 1 && limit * seriesMultiplier > MAX_TOTAL_SERIES) {
		effectiveLimit = Math.max(5, Math.floor(MAX_TOTAL_SERIES / seriesMultiplier));
	}

	const jpyPair = isJpyPair(chk.pair);

	try {
		const res = await analyzeIndicators(chk.pair, type, effectiveLimit);
		if (!res.ok) return fail(res.summary.replace(/^Error: /, ''), res.meta.errorType);

		const chart = res.data.chart;
		const candles = chart.candles.slice(-effectiveLimit);
		const chartIndicators = chart.indicators as Record<string, unknown>;

		// 指標フィルタ: 指定がなければ空（ローソク足のみ）
		const selectedGroups = indicators && indicators.length > 0 ? new Set(indicators) : new Set<string>();

		// 共有タイムスタンプ（tz 指定時はローカル時刻に変換）
		const useTz = typeof tz === 'string' && tz.length > 0;
		const fmt = labelFormat(type);
		const times: string[] = [];
		const labels: string[] | undefined = useTz ? [] : undefined;

		for (const c of candles) {
			const iso = c.isoTime ?? '';
			if (!useTz || !iso) {
				times.push(iso);
			} else {
				const ms = dayjs.utc(iso).valueOf();
				times.push(toIsoWithTz(ms, tz) ?? iso);
				labels?.push(dayjs(ms).tz(tz).format(fmt));
			}
		}

		// コンパクトなローソク足配列: [o, h, l, c, v]
		const compactCandles = candles.map((c: Candle) => {
			const o = roundValue(c.open, jpyPair) ?? c.open;
			const h = roundValue(c.high, jpyPair) ?? c.high;
			const l = roundValue(c.low, jpyPair) ?? c.low;
			const cl = roundValue(c.close, jpyPair) ?? c.close;
			const v = c.volume ?? 0;
			return [o, h, l, cl, v];
		});

		// メインパネル系列の構築（全 null 系列は除外）
		const series: Record<string, (number | null)[]> = {};
		for (const [group, keys] of Object.entries(MAIN_SERIES_KEYS)) {
			if (!selectedGroups.has(group)) continue;
			for (const key of keys) {
				const arr = chartIndicators[key];
				if (!Array.isArray(arr)) continue;
				const sliced = (arr as NumericSeries).slice(-effectiveLimit);
				const rounded = toRoundedArray(sliced, jpyPair);
				if (rounded) {
					series[key] = rounded;
				}
			}
		}

		// サブパネル系列の構築
		const subPanels: CompactSubPanels = {};

		if (selectedGroups.has('RSI')) {
			const rsiArr = chartIndicators.RSI_14_series;
			if (Array.isArray(rsiArr)) {
				const sliced = (rsiArr as NumericSeries).slice(-effectiveLimit);
				const rounded = toRoundedArray(sliced, false); // RSI は 0-100 なので小数2桁を維持
				if (rounded) subPanels.RSI_14 = rounded;
			}
		}

		if (selectedGroups.has('MACD')) {
			const macdData = chartIndicators.macd_series as
				| { line: NumericSeries; signal: NumericSeries; hist: NumericSeries }
				| undefined;
			if (macdData) {
				const line = toRoundedArray(macdData.line.slice(-effectiveLimit), jpyPair);
				const signal = toRoundedArray(macdData.signal.slice(-effectiveLimit), jpyPair);
				const hist = toRoundedArray(macdData.hist.slice(-effectiveLimit), jpyPair);
				if (line || signal || hist) {
					subPanels.MACD = {
						line: line ?? macdData.line.slice(-effectiveLimit),
						signal: signal ?? macdData.signal.slice(-effectiveLimit),
						hist: hist ?? macdData.hist.slice(-effectiveLimit),
					};
				}
			}
		}

		if (selectedGroups.has('STOCH')) {
			const stochK = chartIndicators.stoch_k_series;
			const stochD = chartIndicators.stoch_d_series;
			if (Array.isArray(stochK)) {
				const rounded = toRoundedArray((stochK as NumericSeries).slice(-effectiveLimit), false);
				if (rounded) subPanels.STOCH_K = rounded;
			}
			if (Array.isArray(stochD)) {
				const rounded = toRoundedArray((stochD as NumericSeries).slice(-effectiveLimit), false);
				if (rounded) subPanels.STOCH_D = rounded;
			}
		}

		const hasSeries = Object.keys(series).length > 0;
		const hasSubPanels = Object.keys(subPanels).length > 0;
		const indicatorNames = [...Object.keys(series), ...Object.keys(subPanels)];

		const data: PrepareChartDataResult = {
			times,
			...(labels ? { labels } : {}),
			candleFormat: CANDLE_FORMAT,
			candles: compactCandles,
			...(hasSeries ? { series } : {}),
			...(hasSubPanels ? { subPanels } : {}),
		};

		// 出来高の単位はペアのベース通貨（例: btc_jpy → BTC）
		const volumeUnit = chk.pair.split('_')[0].toUpperCase();

		// 上流 analyze_indicators の meta を取り込む。
		// - res.meta.warning  → 取得層（get_candles の multi-year/multi-day 部分失敗等）
		// - res.meta.warnings → 計算層（SMA_200 がデータ不足等）
		// 両者は別系統として保持し、summary / handler content では別行で出す。
		const upstream = extractUpstreamWarning(res.meta);

		const meta: PrepareChartDataMeta = {
			...createMeta(chk.pair),
			type,
			count: candles.length,
			indicators: indicatorNames,
			volumeUnit,
			...upstream,
		};

		const seriesNote = indicatorNames.length > 0 ? `, indicators: ${indicatorNames.join(', ')}` : '';
		const truncNote =
			effectiveLimit < limit ? ` ⚠️ limit was capped from ${limit} to ${effectiveLimit} to reduce context size` : '';
		const baseSummary = `${chk.pair} ${type} chart data (${candles.length} candles${seriesNote})${truncNote}`;
		// summary 先頭に warning / warnings を別行で連結する（取得層 / 計算層を別系統で出す）。
		// LLM が summary だけ見ても不完全性に気づけるようにするため。
		const summary = prependWarnings(baseSummary, upstream, { separator: '\n' });
		return ok(summary, data, meta);
	} catch (err: unknown) {
		return failFromError(err);
	}
}

export const toolDef: ToolDefinition = {
	name: 'prepare_chart_data',
	description:
		'[Chart / Candlestick / Visualization] チャート描画の第一選択ツール。\n\n' +
		'⚠️ limit はデフォルト 30 を推奨。ユーザーが期間を明示した場合のみ増やすこと。\n' +
		'indicators はユーザーが明示的に要求した指標のみ指定すること。分析のついでに追加しない。\n' +
		'indicators の同時指定はコンテキストを大幅に消費するため、必要最小限に留めること。\n\n' +
		'デフォルトはローソク足（OHLCV）のみ返す。indicators 未指定 = ローソク足のみ。\n' +
		'指標が必要な場合は indicators に明示指定: SMA_5, SMA_20, SMA_25, SMA_50, SMA_75, SMA_200, EMA_12, EMA_26, EMA_50, EMA_200, BB, ICHIMOKU, RSI, MACD, STOCH\n\n' +
		'レスポンス形式: { times[], labels?[], candles: [[o,h,l,c,v],...], series?: {指標名: values[]}, subPanels?: {...} }\n' +
		'JPY ペアの価格は整数に丸め済み。全 null 系列は自動除外。\n\n' +
		'tz パラメータ（例: "Asia/Tokyo"）指定時、times がローカル時刻に変換され、labels（"03/16 17:00" 等の短縮表示文字列）も付加される。\n\n' +
		'SVG/PNG ファイル保存 → render_chart_svg。指標の最新値やトレンド判定 → analyze_indicators。',
	inputSchema: PrepareChartDataInputSchema,
	handler: async ({
		pair,
		type,
		limit,
		indicators,
		tz,
	}: {
		pair?: string;
		type?: string;
		limit?: number;
		indicators?: string[];
		tz?: string;
	}) => {
		const result = await prepareChartData(pair ?? 'btc_jpy', type ?? '1day', limit ?? 30, indicators, tz);
		if (!result.ok) return result;
		// LLM は structuredContent を参照できないため、content テキストにデータを含める
		const text = `${result.summary}\n${JSON.stringify(result.data)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
