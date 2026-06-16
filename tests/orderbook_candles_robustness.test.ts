/**
 * 取得層・提示層の堅牢性リグレッションテスト（2026-06 データ正確性監査の修正分）。
 *
 * 監査で確認した F1 / P2 / P1 の修正後の「正しい挙動」を固定する。
 *   F1: get_orderbook が非数値 price/size を drop し、全 mode で NaN を流出させない
 *       （全滅時は upstream fail、片側欠損の正常系は維持）。
 *   P2: get_orderbook の pressure/statistics 出来高単位がペアのベース通貨になる。
 *   P1: get_candles の view=items でも取得層 warning / meta が保持される。
 *
 * 実行: npx vitest run tests/orderbook_candles_robustness.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allToolDefs } from '../src/tool-registry.js';
import getOrderbook from '../tools/get_orderbook.js';
import { asMockResult } from './_assertResult.js';

function findNonFinite(value: unknown, path = '$'): string[] {
	const found: string[] = [];
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) found.push(`${path}=${String(value)}`);
		return found;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			for (const p of findNonFinite(value[i], `${path}[${i}]`)) found.push(p);
		}
		return found;
	}
	if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			for (const p of findNonFinite(v, `${path}.${k}`)) found.push(p);
		}
	}
	return found;
}

function mockJson(payload: unknown) {
	return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			json: async () => payload,
		}),
	);
}

const TS = 1_700_000_000_000;

afterEach(() => {
	vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────
// F1: get_orderbook の非数値 price/size を全 mode で drop（NaN 非流出 + 適切な分類）
// ─────────────────────────────────────────────────────────────
describe('F1 取得層: get_orderbook の不正レベル sanitize', () => {
	// bids 先頭 price が非数値。もう 1 本は有効 → drop 後も片側は生存。
	const partlyBad = {
		success: 1,
		data: {
			asks: [
				['5000100', '0.2'],
				['5000200', '0.4'],
			],
			bids: [
				['abc', '0.3'], // drop 対象
				['5000000', '0.5'],
			],
			timestamp: TS,
		},
	};

	for (const mode of ['summary', 'statistics', 'raw', 'pressure'] as const) {
		it(`mode=${mode}: drop して ok、NaN 非流出、warning/droppedRows を surface`, async () => {
			mockJson(partlyBad);
			const res = await getOrderbook({ pair: 'btc_jpy', mode });
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			// data に NaN/Infinity が出ない
			expect(findNonFinite({ data: res.data })).toEqual([]);
			// 取得層 warning と droppedRows が surface される
			expect((res.meta as { warning?: string }).warning).toMatch(/不正な板レベルを除外/);
			expect((res.meta as { droppedRows?: { bids: number } }).droppedRows?.bids).toBe(1);
			// LLM 可視テキストにも drop 警告が出る
			expect(res.summary).toMatch(/不正な板レベルを除外/);
			// raw は破損値 "abc" / "NaN円" を含まない
			if (mode === 'raw') {
				expect(JSON.stringify(res.data)).not.toContain('abc');
				expect(res.summary).not.toContain('NaN');
			}
			// pressure は baseMid が有限（無言退行しない）
			if (mode === 'pressure') {
				const bands = (res.data as { bands: Array<{ baseMid: number | null }> }).bands;
				expect(bands[0].baseMid).not.toBeNull();
			}
		});
	}

	it('片側が drop で全滅 → upstream fail（network 誤分類にしない）', async () => {
		mockJson({
			success: 1,
			data: {
				asks: [['5000100', '0.2']],
				bids: [['abc', 'xyz']], // 唯一の bid が drop → bids 全滅
				timestamp: TS,
			},
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		expect(res.ok).toBe(false);
		expect((res.meta as { errorType?: string }).errorType).toBe('upstream');
	});

	it('正常な片側欠損（asks=[] の一方向板）は従来どおり ok・warning なし', async () => {
		// 既存 audit テスト（market_data_audit.test.ts:213）の挙動を維持する。
		mockJson({
			success: 1,
			data: {
				asks: [],
				bids: [
					['5000000', '0.3'],
					['4999900', '0.5'],
				],
				timestamp: TS,
			},
		});
		const res = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics' });
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(findNonFinite({ data: res.data })).toEqual([]);
		// drop は発生していない → warning/droppedRows なし
		expect((res.meta as { warning?: string }).warning).toBeUndefined();
		expect((res.meta as { droppedRows?: unknown }).droppedRows).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────
// P2: get_orderbook pressure/statistics の出来高単位がペアのベース通貨になる
// ─────────────────────────────────────────────────────────────
describe('P2 提示層: get_orderbook の出来高単位がペア依存', () => {
	const goodDepth = {
		success: 1,
		data: {
			asks: [
				['500100', '2.0'],
				['500200', '4.0'],
			],
			bids: [
				['500000', '3.0'],
				['499900', '5.0'],
			],
			timestamp: TS,
		},
	};

	for (const mode of ['pressure', 'statistics'] as const) {
		it(`mode=${mode} (eth_jpy): 単位が "ETH"、"BTC" は出ない`, async () => {
			mockJson(goodDepth);
			const res = await getOrderbook({ pair: 'eth_jpy', mode });
			expect(res.ok).toBe(true);
			expect(res.summary).toMatch(/\bETH\b/);
			expect(res.summary).not.toMatch(/\bBTC\b/);
		});

		it(`mode=${mode} (btc_jpy): 既存どおり "BTC"`, async () => {
			mockJson(goodDepth);
			const res = await getOrderbook({ pair: 'btc_jpy', mode });
			expect(res.ok).toBe(true);
			expect(res.summary).toMatch(/\bBTC\b/);
		});
	}
});

// ─────────────────────────────────────────────────────────────
// P1: get_candles view=items でも取得層 warning / meta が保持される
// ─────────────────────────────────────────────────────────────
describe('P1 提示層: get_candles view=items の warning / meta 保持', () => {
	function mockPartialMultiDay() {
		let call = 0;
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: unknown) => {
			const url = String(input);
			const m = url.match(/\/candlestick\/1hour\/(\d{8})$/);
			const isFirst = call === 0;
			call += 1;
			if (m && isFirst) {
				return asMockResult<Response>({
					ok: true,
					status: 200,
					statusText: 'OK',
					headers: new Headers(),
					json: async () => ({ success: 0, data: { code: 10000 } }),
				});
			}
			const day = m?.[1] ?? '20240101';
			const base = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T00:00:00Z`);
			const ohlcv = [
				['5000000', '5000100', '4999900', '5000050', '1.0', base],
				['5000050', '5000200', '4999800', '5000100', '1.1', base + 3_600_000],
			];
			return asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				headers: new Headers(),
				json: async () => ({ success: 1, data: { candlestick: [{ ohlcv }] } }),
			});
		});
	}

	const getDef = () => {
		const def = allToolDefs.find((t) => t.name === 'get_candles');
		if (!def) throw new Error('get_candles not registered');
		return def;
	};

	it('full view: 部分失敗の警告が content に出る', async () => {
		mockPartialMultiDay();
		const out = (await getDef().handler({ pair: 'btc_jpy', type: '1hour', limit: 96 })) as {
			content?: Array<{ text: string }>;
		};
		const text = (out.content ?? []).map((c) => c.text).join('\n');
		expect(text).toMatch(/失敗しました/);
	});

	it('items view: 同条件で警告が content に保持され、structuredContent に meta が含まれる', async () => {
		mockPartialMultiDay();
		const out = (await getDef().handler({ pair: 'btc_jpy', type: '1hour', limit: 96, view: 'items' })) as {
			content?: Array<{ text: string }>;
			structuredContent?: Record<string, unknown>;
		};
		const text = (out.content ?? []).map((c) => c.text).join('\n');
		expect(text).toMatch(/失敗しました/); // ← 警告が保持される
		// items 配列の JSON も依然として content に含まれる
		expect(text).toContain('"open"');
		// structuredContent に meta（warning 入り）が含まれる
		expect(out.structuredContent && 'meta' in out.structuredContent).toBe(true);
		const meta = (out.structuredContent as { meta?: { warning?: string } }).meta;
		expect(meta?.warning).toMatch(/失敗しました/);
	});
});
