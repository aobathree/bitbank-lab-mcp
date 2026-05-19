import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICHIMOKU_SHIFT } from '../lib/indicator-config.js';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/get_flow_metrics.js', () => ({
	default: vi.fn(),
}));

vi.mock('../tools/get_volatility_metrics.js', () => ({
	default: vi.fn(),
}));

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import { toolDef } from '../src/handlers/analyzeMarketSignalHandler.js';
import analyzeIndicators from '../tools/analyze_indicators.js';
import analyzeMarketSignal from '../tools/analyze_market_signal.js';
import getFlowMetrics from '../tools/get_flow_metrics.js';
import getVolatilityMetrics from '../tools/get_volatility_metrics.js';

function flowOk(aggressorRatio: number, cvdValues: number[]) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			aggregates: { aggressorRatio },
			series: {
				buckets: cvdValues.map((cvd) => ({ cvd })),
			},
		},
		meta: {},
	};
}

function volOk(rvStdAnn: number) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			aggregates: { rv_std_ann: rvStdAnn },
		},
		meta: {},
	};
}

function makeCloses(count: number, close: number) {
	return Array.from({ length: count }, (_, idx) => ({
		close,
		isoTime: `2024-01-${String((idx % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
	}));
}

function indicatorsOk(params: {
	close: number;
	rsi: number;
	sma25: number;
	sma75: number;
	sma200: number;
	normalizedCount?: number;
	trend?:
		| 'strong_uptrend'
		| 'uptrend'
		| 'strong_downtrend'
		| 'downtrend'
		| 'overbought'
		| 'oversold'
		| 'sideways'
		| 'insufficient_data';
}) {
	const { close, rsi, sma25, sma75, sma200, normalizedCount = 220, trend = 'sideways' } = params;
	return {
		ok: true,
		summary: 'ok',
		data: {
			indicators: {
				RSI_14: rsi,
				SMA_25: sma25,
				SMA_75: sma75,
				SMA_200: sma200,
			},
			normalized: makeCloses(normalizedCount, close),
			trend,
		},
		meta: {},
	};
}

describe('analyze_market_signal', () => {
	const mockedGetFlowMetrics = vi.mocked(getFlowMetrics);
	const mockedGetVolatilityMetrics = vi.mocked(getVolatilityMetrics);
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('inputSchema: flowLimit は整数のみ許可する', () => {
		const parse = () => toolDef.inputSchema.parse({ pair: 'btc_jpy', flowLimit: 10.5 });
		expect(parse).toThrow();
	});

	it('中立シグナル時の nextActions は存在しない detect_forming_chart_patterns ではなく detect_patterns を案内すべき', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.nextActions.map((action) => action.tool)).toContain('detect_patterns');
	});

	it('主要要素が矛盾する低信頼ケースで nextActions に未登録の multiple_analysis を含めるべきではない', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 5, 10, 20, 30, 40, 50, 60, 80, 100])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 120, rsi: 0, sma25: 110, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.confidence).toBe('low');
		expect(res.data.nextActions.map((action) => action.tool)).not.toContain('multiple_analysis');
	});

	it('強い弱気シグナル: CVD下降 + RSI低 + SMA下降配列 → bearish recommendation', async () => {
		// CVD が下降トレンド
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.2, [100, 80, 60, 40, 20, 10, 5, 0, -5, -10])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.8)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 80,
					rsi: 20,
					sma25: 90,
					sma75: 100,
					sma200: 110,
					trend: 'strong_downtrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.recommendation).toBe('bearish');
		expect(res.data.score).toBeLessThan(0);
	});

	it('強い強気シグナル: CVD上昇 + RSI高 + SMA上昇配列 → bullish recommendation', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.8, [0, 10, 20, 40, 60, 80, 100, 120, 140, 160])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(
				indicatorsOk({
					close: 120,
					rsi: 65,
					sma25: 115,
					sma75: 110,
					sma200: 100,
					trend: 'strong_uptrend',
				}),
			),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.recommendation).toBe('bullish');
		expect(res.data.score).toBeGreaterThan(0);
	});

	it('overbought: RSI > 70 で買われすぎリスク', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.6, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.4)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 130, rsi: 75, sma25: 125, sma75: 120, sma200: 110, trend: 'uptrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.rsi).toBe(75);
	});

	it('oversold: RSI < 30 で売られすぎ', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.3, [50, 40, 30, 20, 10, 5, 0, -5, -10, -15])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.6)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 85, rsi: 25, sma25: 95, sma75: 105, sma200: 115, trend: 'downtrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.rsi).toBe(25);
	});

	it('高ボラティリティ: rv_std_ann > 1.0 で信頼度に影響', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(1.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.rv_std_ann).toBe(1.5);
	});

	it('SMA 整列: price > sma25 > sma75 > sma200 で aligned_up', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.6, [0, 10, 20, 30, 40, 50, 60, 70, 80, 90])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.3)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 130, rsi: 60, sma25: 120, sma75: 110, sma200: 100, trend: 'uptrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.sma!.arrangement).toBe('bullish');
	});

	it('SMA 整列: price < sma25 < sma75 < sma200 で aligned_down', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.3, [50, 40, 30, 20, 10, 5, 0, -5, -10, -15])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 80, rsi: 35, sma25: 90, sma75: 100, sma200: 110, trend: 'strong_downtrend' })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.sma!.arrangement).toBe('bearish');
	});

	it('toolDef.handler: content テキストに分析結果が含まれる', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { content: Array<{ text: string }> };
		expect(res.content).toBeDefined();
		expect(res.content[0].text).toContain('BTC_JPY');
	});

	// ── 「今日の雲」判定のバグ修正（spanA[len-ICHIMOKU_SHIFT] を使うこと）──

	it('toolDef.handler: 雲判定は ichi_series.spanA/B の末尾 ICHIMOKU_SHIFT 本前を使う（ICHIMOKU_spanA/B とズレているケース）', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		const length = ICHIMOKU_SHIFT + 4;
		// - ICHIMOKU_spanA/B（末尾＝ICHIMOKU_SHIFT 本後）: 80/70 → これを使うと close=100 が above_cloud（バグ）
		// - 今日の雲（spanA/B[len-ICHIMOKU_SHIFT]）: 130/120 → 正しくは below_cloud
		const ichiSeries = {
			tenkan: Array.from({ length }, () => 130),
			kijun: Array.from({ length }, () => 120),
			spanA: Array.from({ length }, (_, i) => (i === length - 1 ? 80 : 130)),
			spanB: Array.from({ length }, (_, i) => (i === length - 1 ? 70 : 120)),
			chikou: Array.from({ length }, () => 130),
		};
		const indRes = indicatorsOk({ close: 100, rsi: 55, sma25: 100, sma75: 100, sma200: 100 });
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 80;
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 70;
		(indRes.data.indicators as Record<string, unknown>).ichi_series = ichiSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indRes));

		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { content: Array<{ text: string }> };
		const text = res.content[0].text;
		// 「今日の雲」は 130/120、close=100 → 雲の下
		expect(text).toContain('一目均衡表: 雲の下');
		expect(text).not.toContain('一目均衡表: 雲の上');
	});

	it('toolDef.handler: ichi_series が ICHIMOKU_SHIFT 本未満なら雲判定は null にフォールバック', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(0.5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		const length = ICHIMOKU_SHIFT - 1;
		const ichiSeries = {
			tenkan: Array.from({ length }, () => 130),
			kijun: Array.from({ length }, () => 120),
			spanA: Array.from({ length }, () => 130),
			spanB: Array.from({ length }, () => 120),
			chikou: Array.from({ length }, () => 130),
		};
		const indRes = indicatorsOk({ close: 100, rsi: 55, sma25: 100, sma75: 100, sma200: 100 });
		// 末尾の scalar 値は存在するが、判定には使わない
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanA = 80;
		(indRes.data.indicators as Record<string, unknown>).ICHIMOKU_spanB = 70;
		(indRes.data.indicators as Record<string, unknown>).ichi_series = ichiSeries;
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indRes));

		const res = (await toolDef.handler({ pair: 'btc_jpy' })) as { content: Array<{ text: string }> };
		const text = res.content[0].text;
		// 「今日の雲」が取れないので一目均衡表セクションは出ない
		expect(text).not.toContain('一目均衡表: 雲の上');
		expect(text).not.toContain('一目均衡表: 雲の下');
		expect(text).not.toContain('一目均衡表: 雲の中');
	});

	it('aggressorRatio が最大で板圧力が極端なときは get_orderbook を深掘り候補に含めるべき', async () => {
		mockedGetFlowMetrics.mockResolvedValueOnce(asMockResult(flowOk(1, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])));
		mockedGetVolatilityMetrics.mockResolvedValueOnce(asMockResult(volOk(0.5)));
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk({ close: 100, rsi: 50, sma25: 100, sma75: 100, sma200: 100 })),
		);

		const res = await analyzeMarketSignal('btc_jpy');
		assertOk(res);
		expect(res.data.metrics.buyPressure).toBe(1);
		expect(res.data.nextActions.map((action) => action.tool)).toContain('get_orderbook');
	});
});
