import { describe, expect, it } from 'vitest';
import {
	BacktestPeriodEnum,
	BacktestTimeframeEnum,
	RunBacktestInputSchema,
	StrategyConfigSchema,
	StrategyTypeEnum,
} from '../../src/schema/backtest.js';

describe('BacktestTimeframeEnum', () => {
	it('有効な時間軸を受け入れる', () => {
		expect(BacktestTimeframeEnum.parse('1D')).toBe('1D');
		expect(BacktestTimeframeEnum.parse('4H')).toBe('4H');
		expect(BacktestTimeframeEnum.parse('1H')).toBe('1H');
	});

	it('無効な時間軸を拒否する', () => {
		expect(() => BacktestTimeframeEnum.parse('1W')).toThrow();
	});
});

describe('BacktestPeriodEnum', () => {
	it('有効な期間を受け入れる', () => {
		expect(BacktestPeriodEnum.parse('1M')).toBe('1M');
		expect(BacktestPeriodEnum.parse('3M')).toBe('3M');
		expect(BacktestPeriodEnum.parse('6M')).toBe('6M');
	});
});

describe('StrategyTypeEnum', () => {
	it('全戦略タイプを受け入れる', () => {
		const types = ['sma_cross', 'rsi', 'macd_cross', 'bb_breakout'];
		for (const t of types) {
			expect(StrategyTypeEnum.parse(t)).toBe(t);
		}
	});
});

describe('StrategyConfigSchema', () => {
	it('有効な戦略設定を受け入れる', () => {
		const result = StrategyConfigSchema.parse({ type: 'sma_cross', params: { short: 5, long: 20 } });
		expect(result.type).toBe('sma_cross');
		expect(result.params).toEqual({ short: 5, long: 20 });
	});

	it('params 省略時はデフォルト空オブジェクト', () => {
		const result = StrategyConfigSchema.parse({ type: 'rsi' });
		expect(result.params).toEqual({});
	});
});

describe('RunBacktestInputSchema', () => {
	it('最小限の入力でデフォルト値を適用する', () => {
		const result = RunBacktestInputSchema.parse({ strategy: { type: 'sma_cross' } });
		expect(result.pair).toBe('btc_jpy');
		expect(result.timeframe).toBe('1D');
		expect(result.period).toBe('3M');
		// fee_bp 省略時は undefined（実行時に /spot/pairs の taker レートから動的解決される）
		expect(result.fee_bp).toBeUndefined();
		expect(result.execution).toBe('t+1_open');
		expect(result.savePng).toBe(false);
		expect(result.includeSvg).toBe(false);
		expect(result.chartDetail).toBe('default');
	});

	it('カスタム値を受け入れる', () => {
		const result = RunBacktestInputSchema.parse({
			pair: 'eth_jpy',
			timeframe: '4H',
			period: '6M',
			strategy: { type: 'macd_cross', params: { fast: 12 } },
			fee_bp: 5,
		});
		expect(result.pair).toBe('eth_jpy');
		expect(result.timeframe).toBe('4H');
		expect(result.period).toBe('6M');
		expect(result.fee_bp).toBe(5);
	});

	it('fee_bp の範囲外を拒否する', () => {
		expect(() =>
			RunBacktestInputSchema.parse({
				strategy: { type: 'sma_cross' },
				fee_bp: 200,
			}),
		).toThrow();
	});
});
