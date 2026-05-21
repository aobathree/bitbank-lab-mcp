import { describe, expect, it } from 'vitest';
import renderCandlePatternDiagram, { toolDef } from '../tools/render_candle_pattern_diagram.js';
import { assertOk } from './_assertResult.js';

type Candle = {
	date: string;
	open: number;
	high: number;
	low: number;
	close: number;
	type: 'bullish' | 'bearish';
	isPartial?: boolean;
};

function makeCandle(
	date: string,
	open: number,
	high: number,
	low: number,
	close: number,
	type: 'bullish' | 'bearish',
	isPartial = false,
): Candle {
	return {
		date,
		open,
		high,
		low,
		close,
		type,
		isPartial,
	};
}

function buildSampleCandles(): Candle[] {
	return [
		makeCandle('01/01', 100, 110, 95, 98, 'bearish'),
		makeCandle('01/02', 97, 112, 96, 109, 'bullish'),
		makeCandle('01/03', 109, 115, 105, 111, 'bullish', true),
	];
}

describe('render_candle_pattern_diagram', () => {
	it('title と日付ラベルの XML 特殊文字をエスケープできる', async () => {
		const res = await renderCandlePatternDiagram({
			candles: [makeCandle('01/01<&>', 100, 110, 95, 98, 'bearish'), makeCandle('01/02"', 97, 112, 96, 109, 'bullish')],
			title: '包み線 <demo> & "test"',
			pattern: {
				name: '陽線包み線',
				confirmedDate: '01/02',
				involvedIndices: [0, 1],
			},
		});

		assertOk(res);
		expect(res.data.svg).toContain('包み線 &lt;demo&gt; &amp; &quot;test&quot;');
		expect(res.data.svg).toContain('01/01&lt;&amp;&gt;');
		expect(res.data.svg).toContain('01/02&quot;');
	});

	it('inputSchema: pattern.involvedIndices の負数は拒否するべき', () => {
		const parse = () =>
			toolDef.inputSchema.parse({
				candles: buildSampleCandles(),
				pattern: {
					name: '陽線包み線',
					confirmedDate: '01/02',
					involvedIndices: [-1, 1],
				},
			});

		expect(parse).toThrow();
	});

	it('svg ルート要素に viewBox を持つ（コンテナで縦に切れないように）', async () => {
		const res = await renderCandlePatternDiagram({
			candles: buildSampleCandles(),
			pattern: {
				name: '陽線包み線',
				confirmedDate: '01/02',
				involvedIndices: [0, 1],
			},
		});

		assertOk(res);
		expect(res.data.svg).toMatch(/<svg[^>]*\sviewBox="0 0 \d+ \d+"/);
	});

	it('価格レンジが 0 のときも SVG に NaN や Infinity を含めるべきではない', async () => {
		const res = await renderCandlePatternDiagram({
			candles: [makeCandle('01/01', 100, 100, 100, 100, 'bullish'), makeCandle('01/02', 100, 100, 100, 100, 'bearish')],
			pattern: {
				name: '毛抜き底',
				confirmedDate: '01/02',
				involvedIndices: [0, 1],
			},
		});

		assertOk(res);
		expect(res.data.svg).not.toMatch(/NaN|Infinity/);
	});
});
