import { describe, expect, it } from 'vitest';
import {
	AnalyzeCandlePatternsInputSchema,
	CandlePatternTypeEnum,
	DetectedPatternSchema,
	DetectPatternsInputSchema,
	PatternTypeEnum,
} from '../../src/schema/patterns.js';

describe('PatternTypeEnum', () => {
	it('全パターンタイプを受け入れる', () => {
		const types = [
			'double_top',
			'double_bottom',
			'triple_top',
			'triple_bottom',
			'head_and_shoulders',
			'inverse_head_and_shoulders',
			'triangle',
			'triangle_ascending',
			'triangle_descending',
			'triangle_symmetrical',
			'falling_wedge',
			'rising_wedge',
			'pennant',
			'flag',
		];
		for (const t of types) {
			expect(PatternTypeEnum.parse(t)).toBe(t);
		}
	});

	it('無効なパターンを拒否する', () => {
		expect(() => PatternTypeEnum.parse('unknown_pattern')).toThrow();
	});
});

describe('DetectPatternsInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = DetectPatternsInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
		expect(result.type).toBe('1day');
		expect(result.limit).toBe(90);
		expect(result.swingDepth).toBe(7);
		expect(result.tolerancePct).toBe(0.04);
		expect(result.view).toBe('detailed');
		expect(result.includeForming).toBe(false);
		expect(result.includeCompleted).toBe(true);
	});

	it('カスタムパターンフィルタを受け入れる', () => {
		const result = DetectPatternsInputSchema.parse({
			patterns: ['double_top', 'double_bottom'],
		});
		expect(result.patterns).toEqual(['double_top', 'double_bottom']);
	});

	it('limit 範囲外を拒否する', () => {
		expect(() => DetectPatternsInputSchema.parse({ limit: 19 })).toThrow();
		expect(() => DetectPatternsInputSchema.parse({ limit: 366 })).toThrow();
	});

	it('tolerancePct 範囲外を拒否する', () => {
		expect(() => DetectPatternsInputSchema.parse({ tolerancePct: 0.2 })).toThrow();
	});
});

describe('DetectedPatternSchema', () => {
	it('基本的なパターンを受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'double_top',
			confidence: 0.85,
			range: { start: '2024-01-01', end: '2024-01-30' },
		});
		expect(result.type).toBe('double_top');
		expect(result.confidence).toBe(0.85);
	});

	it('全オプショナルフィールドを含むパターン', () => {
		const result = DetectedPatternSchema.parse({
			type: 'pennant',
			confidence: 0.7,
			range: { start: '2024-01-01', end: '2024-01-15' },
			status: 'completed',
			breakoutDirection: 'up',
			poleDirection: 'up',
			isTrendContinuation: true,
			aftermath: {
				breakoutConfirmed: true,
				targetReached: false,
				outcome: '部分成功',
			},
		});
		expect(result.status).toBe('completed');
		expect(result.aftermath?.breakoutConfirmed).toBe(true);
	});

	it('confidence 範囲外を拒否する', () => {
		expect(() =>
			DetectedPatternSchema.parse({
				type: 'double_top',
				confidence: 1.5,
				range: { start: '2024-01-01', end: '2024-01-30' },
			}),
		).toThrow();
	});

	it('structureRange / confirmation(neckline_breakout) / precedingTrend を受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'double_bottom',
			confidence: 0.8,
			range: { start: '2025-09-01', end: '2025-10-02' },
			structureRange: { start: '2025-09-01', end: '2025-09-26' },
			confirmation: {
				type: 'neckline_breakout',
				date: '2025-10-02',
				idx: 31,
				price: 1234567,
			},
			precedingTrend: {
				start: '2025-08-22',
				end: '2025-09-01',
				direction: 'down',
				returnPct: -7.5,
				lookbackBars: 10,
			},
		});
		expect(result.structureRange?.end).toBe('2025-09-26');
		expect(result.confirmation?.type).toBe('neckline_breakout');
		if (result.confirmation?.type === 'neckline_breakout') {
			expect(result.confirmation.idx).toBe(31);
		}
		expect(result.precedingTrend?.direction).toBe('down');
	});

	it('confirmation=not_confirmed を受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'head_and_shoulders',
			confidence: 0.7,
			range: { start: '2024-01-01', end: '2024-03-01' },
			confirmation: { type: 'not_confirmed' },
		});
		expect(result.confirmation?.type).toBe('not_confirmed');
	});

	it('precedingTrend.direction=insufficient_data を受け入れる', () => {
		const result = DetectedPatternSchema.parse({
			type: 'double_top',
			confidence: 0.6,
			range: { start: '2024-01-01', end: '2024-01-30' },
			precedingTrend: {
				start: '2024-01-01',
				end: '2024-01-05',
				direction: 'insufficient_data',
				returnPct: 0,
				lookbackBars: 10,
			},
		});
		expect(result.precedingTrend?.direction).toBe('insufficient_data');
	});

	it('confirmation.type が未知の値は拒否する', () => {
		expect(() =>
			DetectedPatternSchema.parse({
				type: 'double_top',
				confidence: 0.8,
				range: { start: '2024-01-01', end: '2024-01-30' },
				confirmation: { type: 'unknown_type' },
			}),
		).toThrow();
	});
});

describe('CandlePatternTypeEnum', () => {
	it('1本足・2本足・3本足パターンを受け入れる', () => {
		const patterns = [
			'bullish_engulfing',
			'bearish_engulfing',
			'hammer',
			'shooting_star',
			'doji',
			'morning_star',
			'evening_star',
			'three_white_soldiers',
			'three_black_crows',
		];
		for (const p of patterns) {
			expect(CandlePatternTypeEnum.parse(p)).toBe(p);
		}
	});
});

describe('AnalyzeCandlePatternsInputSchema', () => {
	it('デフォルト値を適用する', () => {
		const result = AnalyzeCandlePatternsInputSchema.parse({});
		expect(result.pair).toBe('btc_jpy');
		expect(result.timeframe).toBe('1day');
		expect(result.window_days).toBe(5);
		expect(result.focus_last_n).toBe(5);
		expect(result.history_lookback_days).toBe(180);
	});

	it('as_of を受け入れる', () => {
		const result = AnalyzeCandlePatternsInputSchema.parse({ as_of: '2024-01-15' });
		expect(result.as_of).toBe('2024-01-15');
	});

	it('window_days 範囲外を拒否する', () => {
		expect(() => AnalyzeCandlePatternsInputSchema.parse({ window_days: 2 })).toThrow();
		expect(() => AnalyzeCandlePatternsInputSchema.parse({ window_days: 11 })).toThrow();
	});
});
