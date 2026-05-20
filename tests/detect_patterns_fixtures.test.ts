import { afterEach, describe, expect, it, vi } from 'vitest';
import { asMockResult, assertOk } from './_assertResult.js';

vi.mock('../tools/analyze_indicators.js', () => ({
	default: vi.fn(),
}));

import analyzeIndicators from '../tools/analyze_indicators.js';
import detectPatterns from '../tools/detect_patterns.js';

type Candle = {
	isoTime: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume: number;
};

function makeIso(dayOffset: number, year = 2026) {
	return new Date(Date.UTC(year, 0, 1 + dayOffset, 0, 0, 0)).toISOString();
}

function makeCandle(dayOffset: number, close: number, year = 2026): Candle {
	return {
		isoTime: makeIso(dayOffset, year),
		open: close,
		high: close + 3,
		low: close - 3,
		close,
		volume: 100,
	};
}

function indicatorsOk(candles: Candle[]) {
	return {
		ok: true,
		summary: 'ok',
		data: {
			chart: {
				candles,
			},
		},
	};
}

function buildCompletedDoubleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 102, 105, 110, 118, 130, 126, 122, 118, 114, 112, 110, 114, 118, 122, 126, 128, 129, 123, 116, 104, 100, 95,
		100, 99, 98,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildFormingDoubleBottomCandles(year = 2026): Candle[] {
	const closes = [108, 104, 99, 92, 80, 84, 88, 92, 96, 99, 101, 98, 94, 89, 85, 82, 81, 84, 88, 91, 94, 95, 96, 95];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildDescendingTriangleInvalidBreakoutCandles(year = 2026): Candle[] {
	const closes = [
		120, 130, 124, 116, 100, 112, 125, 118, 101, 110, 120, 114, 100, 108, 115, 110, 101, 107, 128, 132, 130, 128, 126,
		124,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildRectangleRangeCandles(year = 2026): Candle[] {
	const closes = [
		105, 110, 104, 109, 101, 108, 102, 110, 101, 109, 100, 108, 102, 109, 101, 110, 100, 109, 101, 108, 102, 109, 101,
		110,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildRisingChannelCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 104, 112, 108, 116, 112, 120, 116, 124, 120, 128, 124, 132, 128, 136, 132, 140, 136, 144, 140, 148, 144,
		152, 148, 156, 152, 160, 156, 164,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildBullFlagFailureCandles(year = 2026): Candle[] {
	const closes = [100, 108, 116, 124, 132, 140, 136, 138, 134, 136, 132, 134, 130, 132, 128, 130, 120, 118, 116, 114];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildBullPennantSuccessCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 170, 172,
		174,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

function buildBullPennantFailureCandles(year = 2026): Candle[] {
	const closes = [
		100, 110, 122, 136, 150, 165, 158, 162, 154, 160, 155, 159, 156, 158, 157, 157.8, 157.2, 158.1, 157.4, 148, 146,
		144,
	];

	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Triple Top: 3 peaks near 130, 2 valleys near 112, then neckline break ---
function buildCompletedTripleTopCandles(year = 2026): Candle[] {
	const closes = [
		100, 105, 112, 120, 128, 130, 126, 120, 115, 112, 116, 122, 128, 130, 131, 126, 120, 115, 113, 117, 122, 128, 130,
		131, 126, 118, 110, 104, 98, 94,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Triple Bottom (forming): 3 valleys near 80, with enough bars after 3rd valley ---
function buildFormingTripleBottomCandles(year = 2026): Candle[] {
	const closes = [
		108, 104, 98, 92, 84, 80, 84, 90, 95, 98, 94, 88, 84, 81, 80, 84, 90, 95, 97, 93, 88, 84, 81, 80, 84, 88, 92, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Head & Shoulders (completed): L-shoulder 125, head 140, R-shoulder 126, neckline ~110-112, break ---
function buildCompletedHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		100, 108, 116, 122, 125, 120, 116, 112, 110, 114, 120, 128, 136, 140, 136, 128, 120, 114, 112, 116, 120, 124, 126,
		122, 116, 108, 102, 96,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Inverse Head & Shoulders (forming): L-shoulder 80, head 64, R-shoulder forming near 80 ---
function buildFormingInverseHeadAndShouldersCandles(year = 2026): Candle[] {
	const closes = [
		108, 100, 92, 84, 80, 84, 90, 96, 100, 96, 88, 78, 68, 64, 70, 80, 90, 98, 100, 96, 90, 84, 80, 84, 88, 92,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Rising Wedge (forming): both slopes up, lower steeper ---
// Peaks at idx 5,12,19,26,33 → highs 133,137,141,145,149 (slope ~0.571/bar)
// Valleys at idx 0,7,14,21,28 → lows 97,105,113,121,129 (slope ~1.143/bar, steeper)
function buildFormingRisingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		100, 106, 112, 118, 124, 130, 119, 108, 113, 118, 124, 129, 134, 125, 116, 120, 125, 129, 134, 138, 131, 124, 128,
		131, 135, 138, 142, 137, 132, 135, 138, 140, 143, 146, 143,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Falling Wedge (completed with upward breakout) ---
// Mirror of rising wedge, inverted: both slopes down, upper steeper in abs value
function buildCompletedFallingWedgeCandles(year = 2026): Candle[] {
	const closes = [
		146, 140, 134, 128, 122, 116, 127, 138, 133, 128, 122, 117, 112, 121, 130, 126, 121, 117, 112, 108, 115, 122, 118,
		115, 111, 108, 104, 109, 114, 111, 108, 106, 103, 100, 103, 110, 118,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Ascending Triangle (forming): flat upper resistance ~130, rising lower support ---
// Peaks: all near close=127 → high=130; Valleys: rising from low=97 upward
// No impulsive pole before window (gradual entry) to avoid pennant reclassification
function buildFormingAscendingTriangleCandles(year = 2026): Candle[] {
	const closes = [
		115, 118, 121, 124, 127, 124, 118, 112, 116, 120, 124, 127, 123, 117, 114, 118, 122, 126, 127, 124, 120, 117, 120,
		123, 126, 127, 125, 122, 120, 123, 126, 127, 126,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

// --- Symmetrical Triangle (forming): upper falling, lower rising, converging ---
// Peaks: descending from ~140 to ~126; Valleys: ascending from ~100 to ~118
function buildFormingSymmetricalTriangleCandles(year = 2026): Candle[] {
	const closes = [
		120, 126, 132, 137, 130, 122, 116, 110, 104, 100, 106, 114, 120, 128, 134, 128, 120, 115, 108, 104, 110, 118, 124,
		130, 126, 120, 116, 112, 108, 114, 120, 126, 124, 120, 117, 114,
	];
	return closes.map((close, index) => makeCandle(index, close, year));
}

describe('detect_patterns fixtures', () => {
	const mockedAnalyzeIndicators = vi.mocked(analyzeIndicators);

	afterEach(() => {
		vi.clearAllMocks();
		vi.useRealTimers();
	});

	it('synthetic fixture から completed の double_top を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedDoubleTopCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 26, {
			patterns: ['double_top'],
			swingDepth: 2,
			tolerancePct: 0.02,
			includeCompleted: true,
			includeForming: false,
		});
		assertOk(res);
		expect(res.data.patterns).toHaveLength(1);
		expect(res.data.patterns[0]).toMatchObject({
			type: 'double_top',
			timeframe: '1day',
			timeframeLabel: '日足',
			trendlineLabel: 'ネックライン',
			breakoutBarIndex: 20,
			targetMethod: 'neckline_projection',
			aftermath: {
				breakoutConfirmed: true,
			},
		});
		expect(res.data.overlays!.ranges).toEqual([
			{
				start: makeIso(5),
				end: makeIso(20),
				label: 'double_top',
			},
		]);
		expect(res.meta.count).toBe(1);
	});

	it('synthetic fixture から forming の double_bottom を completed なしで返せる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingDoubleBottomCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['double_bottom'],
			swingDepth: 2,
			tolerancePct: 0.03,
			includeForming: true,
			includeCompleted: false,
		});

		assertOk(res);
		expect(res.data.patterns).toHaveLength(1);
		expect(res.data.patterns[0]).toMatchObject({
			type: 'double_bottom',
			status: 'forming',
			timeframe: '1day',
			timeframeLabel: '日足',
			trendlineLabel: 'ネックライン',
			completionPct: expect.any(Number),
			targetMethod: 'neckline_projection',
		});
		expect(res.data.patterns[0].range.end).toBe(makeIso(23));
		expect(res.meta.count).toBe(1);
	});

	it('requireCurrentInPattern=true のとき古い fixture は除外される', async () => {
		vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedDoubleTopCandles(2025))));

		const res = await detectPatterns('btc_jpy', '1day', 26, {
			patterns: ['double_top'],
			swingDepth: 2,
			tolerancePct: 0.02,
			requireCurrentInPattern: true,
			currentRelevanceDays: 7,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
		expect(res.data.overlays!.ranges).toEqual([]);
		expect(res.meta.count).toBe(0);
	});

	it('descending triangle の逆方向ブレイクは invalid / failure として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk(buildDescendingTriangleInvalidBreakoutCandles())),
		);

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['triangle_descending'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triangle_descending',
					status: 'invalid',
					breakoutDirection: 'up',
					outcome: 'failure',
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('includeInvalid=false のとき invalid な triangle は結果から除外される', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk(buildDescendingTriangleInvalidBreakoutCandles())),
		);

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['triangle_descending'],
			includeCompleted: true,
			includeInvalid: false,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
	});

	it('矩形レンジの fixture を triangle として誤検出しない', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildRectangleRangeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 24, {
			patterns: ['triangle'],
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
	});

	it('平行な上昇チャネルの fixture を wedge として誤検出しない', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildRisingChannelCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 30, {
			patterns: ['rising_wedge', 'falling_wedge'],
			includeForming: true,
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual([]);
	});

	it('bull flag の逆方向ブレイクは invalid / failure として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildBullFlagFailureCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 20, {
			patterns: ['flag'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'flag',
					status: 'invalid',
					breakoutDirection: 'down',
					outcome: 'failure',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
				}),
			]),
		);
	});

	it('bull pennant の順方向ブレイクは success として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildBullPennantSuccessCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 22, {
			patterns: ['pennant'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'pennant',
					status: 'completed',
					poleDirection: 'up',
					breakoutDirection: 'up',
					outcome: 'success',
					isTrendContinuation: true,
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
				}),
			]),
		);
	});

	it('bull pennant の逆方向ブレイクは failure として保持できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildBullPennantFailureCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 22, {
			patterns: ['pennant'],
			includeCompleted: true,
			includeInvalid: true,
		});

		assertOk(res);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'pennant',
					poleDirection: 'up',
					breakoutDirection: 'down',
					outcome: 'failure',
					isTrendContinuation: false,
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'flagpole_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から triple_top を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedTripleTopCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 30, {
			patterns: ['triple_top'],
			swingDepth: 2,
			tolerancePct: 0.02,
			includeCompleted: true,
			includeForming: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triple_top',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から triple_bottom を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingTripleBottomCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 28, {
			patterns: ['triple_bottom'],
			swingDepth: 2,
			tolerancePct: 0.02,
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triple_bottom',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から head_and_shoulders を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedHeadAndShouldersCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 28, {
			patterns: ['head_and_shoulders'],
			swingDepth: 2,
			tolerancePct: 0.04,
			includeCompleted: true,
			includeForming: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'head_and_shoulders',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から inverse_head_and_shoulders を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(
			asMockResult(indicatorsOk(buildFormingInverseHeadAndShouldersCandles())),
		);

		const res = await detectPatterns('btc_jpy', '1day', 26, {
			patterns: ['inverse_head_and_shoulders'],
			swingDepth: 2,
			tolerancePct: 0.04,
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'inverse_head_and_shoulders',
					timeframe: '1day',
					timeframeLabel: '日足',
					targetMethod: 'neckline_projection',
				}),
			]),
		);
	});

	it('synthetic fixture から forming の rising_wedge を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingRisingWedgeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 35, {
			patterns: ['rising_wedge'],
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'rising_wedge',
					status: expect.stringMatching(/^(forming|near_completion)$/),
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('synthetic fixture から completed の falling_wedge を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildCompletedFallingWedgeCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 37, {
			patterns: ['falling_wedge'],
			includeCompleted: true,
			includeForming: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'falling_wedge',
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('synthetic fixture から forming の triangle_ascending を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingAscendingTriangleCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 33, {
			patterns: ['triangle_ascending'],
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triangle_ascending',
					status: expect.stringMatching(/^(forming|near_completion)$/),
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	it('synthetic fixture から forming の triangle_symmetrical を検出できる', async () => {
		mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(buildFormingSymmetricalTriangleCandles())));

		const res = await detectPatterns('btc_jpy', '1day', 36, {
			patterns: ['triangle_symmetrical'],
			includeForming: true,
			includeCompleted: true,
		});

		assertOk(res);
		expect(res.data.patterns.length).toBeGreaterThan(0);
		expect(res.data.patterns).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: 'triangle_symmetrical',
					status: expect.stringMatching(/^(forming|near_completion)$/),
					timeframe: '1day',
					timeframeLabel: '日足',
				}),
			]),
		);
	});

	// ── 上流 warning の伝播（取得層 meta.warning / 計算層 meta.warnings） ──
	describe('上流 warning の伝播', () => {
		function indicatorsOkWithMeta(candles: Candle[], meta: Record<string, unknown>) {
			return {
				ok: true,
				summary: 'ok',
				data: { chart: { candles } },
				meta,
			};
		}

		it('上流 meta.warning（取得層 partial fetch）が tool の meta.warning と summary 先頭に伝播する', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					indicatorsOkWithMeta(candles, {
						warning: '⚠️ partial fetch (3日中1日の取得に失敗)',
					}),
				),
			);

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (3日中1日の取得に失敗)');
			expect(res.meta.warnings).toBeUndefined();
			// summary 先頭が warning 行
			expect(res.summary.split('\n')[0]).toContain('⚠️ partial fetch');
		});

		it('上流 meta.warnings（計算層 SMA_200 不足等）が tool の meta.warnings に継承され、独自の data.warnings とは別フィールドで保持される', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					indicatorsOkWithMeta(candles, {
						warnings: ['SMA_200: データ不足', 'Ichimoku: データ不足'],
					}),
				),
			);

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			// meta.warnings に上流計算層 warnings が継承される
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足', 'Ichimoku: データ不足']);
			expect(res.meta.warning).toBeUndefined();
			// data.warnings（本ツール独自の検出系警告）と meta.warnings（上流計算層）は別フィールド
			// 独自警告は { type, message, suggestedParams } の形だが上流由来は string[]
			if (Array.isArray(res.data.warnings)) {
				for (const w of res.data.warnings) {
					// data.warnings は独自スキーマで、上流の string そのままが混入していないこと
					expect(typeof w).toBe('object');
				}
			}
			// summary 先頭が warning 行
			expect(res.summary.split('\n')[0]).toMatch(/^⚠️/);
			expect(res.summary).toContain('⚠️ SMA_200: データ不足');
		});

		it('上流の取得層 warning と計算層 warnings の両方が伝播し、別フィールドで保持される', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(
				asMockResult(
					indicatorsOkWithMeta(candles, {
						warning: '⚠️ partial fetch (multi-year)',
						warnings: ['SMA_200: データ不足'],
					}),
				),
			);

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.warning).toBe('⚠️ partial fetch (multi-year)');
			expect(res.meta.warnings).toEqual(['SMA_200: データ不足']);
			// summary の先頭 2 行に取得層 warning と計算層 warnings がそれぞれ出る
			const lines = res.summary.split('\n');
			expect(lines[0]).toContain('⚠️ partial fetch');
			expect(lines[1]).toContain('⚠️ SMA_200: データ不足');
		});

		it('上流 warning 無しなら meta.warning / meta.warnings は付与されない', async () => {
			const candles = buildCompletedDoubleTopCandles();
			mockedAnalyzeIndicators.mockResolvedValueOnce(asMockResult(indicatorsOk(candles)));

			const res = await detectPatterns('btc_jpy', '1day', 26, {
				patterns: ['double_top'],
				swingDepth: 2,
				tolerancePct: 0.02,
			});

			assertOk(res);
			expect(res.meta.warning).toBeUndefined();
			expect(res.meta.warnings).toBeUndefined();
			expect(res.summary.startsWith('⚠️')).toBe(false);
		});
	});
});
