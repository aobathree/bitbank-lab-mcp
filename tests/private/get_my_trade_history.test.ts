/**
 * get_my_trade_history ツールのユニットテスト。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankError, mockBitbankSuccess, rawTradeHistoryResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

function setupFetchMock(response: unknown, status = 200) {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
}

/** N 件の RawTrade を生成するヘルパー */
function generateTrades(n: number, baseId = 1, baseTimestamp = 1710000000000) {
	return Array.from({ length: n }, (_, i) => ({
		trade_id: baseId + i,
		pair: 'btc_jpy',
		order_id: 5000 + i,
		side: i % 2 === 0 ? 'buy' : 'sell',
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0.00001',
		fee_amount_quote: '0',
		executed_at: baseTimestamp + i * 1000,
	}));
}

/** 順次レスポンスを返す fetch モック。呼び出しごとに responses を順に消費する。 */
function setupSequentialFetchMock(responses: unknown[]) {
	const mockFn = vi.fn();
	for (const res of responses) {
		mockFn.mockResolvedValueOnce(new Response(JSON.stringify(res), { status: 200 }));
	}
	globalThis.fetch = mockFn as unknown as typeof fetch;
	return mockFn;
}

describe('get_my_trade_history', () => {
	it('ISO8601 タイムスタンプに変換された約定を返す', async () => {
		setupFetchMock(mockBitbankSuccess(rawTradeHistoryResponse));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertOk(result);
		expect(result.data.trades).toHaveLength(3);
		// unix ms が ISO8601 に変換されている
		for (const trade of result.data.trades) {
			expect(trade.executed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		}
	});

	it('since/end を unix ms に変換して API に渡す', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		await getMyTradeHistory({ since: '2024-03-10T00:00:00Z', end: '2024-03-11T00:00:00Z' });

		const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
		const calledUrl = fetchMock.mock.calls[0][0] as string;
		// unix ms パラメータが含まれている
		expect(calledUrl).toContain('since=');
		expect(calledUrl).toContain('end=');
		// ISO8601 文字列ではなく数値
		expect(calledUrl).not.toContain('2024-03-10');
	});

	it('不正な since 日付で validation_error を返す', async () => {
		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ since: 'not-a-date' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
	});

	it('不正な end 日付で validation_error を返す', async () => {
		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ end: 'invalid' });

		assertFail(result);
		expect(result.meta.errorType).toBe('validation_error');
	});

	it('PrivateApiError で fail を返す', async () => {
		setupFetchMock(mockBitbankError(20001), 400);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('authentication_error');
	});

	it('buy/sell の集計をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawTradeHistoryResponse));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('買 2件');
		expect(result.summary).toContain('売 1件');
	});

	it('trade_id と order_id をサマリーに含む', async () => {
		setupFetchMock(mockBitbankSuccess(rawTradeHistoryResponse));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('[trade: 101 / order: 1001]');
		expect(result.summary).toContain('[trade: 102 / order: 1002]');
		expect(result.summary).toContain('[trade: 103 / order: 1003]');
	});

	it('10件超で省略メッセージを表示する', async () => {
		const trades = Array.from({ length: 15 }, (_, i) => ({
			trade_id: 200 + i,
			pair: 'btc_jpy',
			order_id: 2000 + i,
			side: i % 2 === 0 ? 'buy' : 'sell',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: 1710000000000 + i * 1000,
		}));
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertOk(result);
		expect(result.summary).toContain('他 5件');
		expect(result.data.trades).toHaveLength(15);
	});

	it('非 PrivateApiError の例外で upstream_error を返す', async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('ECONNREFUSED')) as unknown as typeof fetch;

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('ECONNREFUSED');
	});

	it('fee_occurred_amount_quote が API レスポンスに含まれる場合、出力に伝播する', async () => {
		const trades = [
			{
				trade_id: 701,
				pair: 'btc_jpy',
				order_id: 7001,
				side: 'sell',
				type: 'market',
				amount: '0.01',
				price: '15500000',
				maker_taker: 'taker',
				fee_amount_base: '0',
				fee_amount_quote: '500',
				fee_occurred_amount_quote: '500',
				executed_at: 1710000000000,
			},
		];
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertOk(result);
		expect(result.data.trades[0].fee_occurred_amount_quote).toBe('500');
	});

	it('fee_occurred_amount_quote が API レスポンスに含まれない場合、undefined を伝播する（fallback しない）', async () => {
		const trades = [
			{
				trade_id: 702,
				pair: 'btc_jpy',
				order_id: 7002,
				side: 'sell',
				type: 'market',
				amount: '0.01',
				price: '15500000',
				maker_taker: 'taker',
				fee_amount_base: '0',
				fee_amount_quote: '500',
				executed_at: 1710000000000,
			},
		];
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertOk(result);
		expect(result.data.trades[0].fee_occurred_amount_quote).toBeUndefined();
		// fallback で fee_amount_quote の値で埋めないことを明示的にアサート
		expect(result.data.trades[0].fee_occurred_amount_quote).not.toBe(result.data.trades[0].fee_amount_quote);
	});

	it('asc 順で10件超の場合は末尾10件を表示する', async () => {
		const trades = Array.from({ length: 12 }, (_, i) => ({
			trade_id: 300 + i,
			pair: 'btc_jpy',
			order_id: 3000 + i,
			side: 'buy',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: 1710000000000 + i * 1000,
		}));
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ order: 'asc' });

		assertOk(result);
		expect(result.summary).toContain('他 2件');
		// asc の場合は末尾10件が表示される（trade_id 302〜311）
		expect(result.summary).toContain('[trade: 302');
		expect(result.summary).not.toContain('[trade: 300 /');
	});
});

describe('get_my_trade_history — 非 PrivateApiError の generic catch', () => {
	afterEach(() => {
		vi.doUnmock('../../src/private/client.js');
	});

	it('非 PrivateApiError が投げられると upstream_error を返す', async () => {
		vi.doMock('../../src/private/client.js', () => ({
			getDefaultClient: () => ({
				get: () => {
					throw new Error('unexpected crash');
				},
			}),
			PrivateApiError: class extends Error {
				errorType: string;
				constructor(msg: string, errorType: string) {
					super(msg);
					this.errorType = errorType;
				}
			},
		}));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({});

		assertFail(result);
		expect(result.meta.errorType).toBe('upstream_error');
		expect(result.summary).toContain('unexpected crash');
	});
});

describe('get_my_trade_history — handler (toolDef)', () => {
	it('handler がデフォルト引数で動作する', async () => {
		setupFetchMock(mockBitbankSuccess(rawTradeHistoryResponse));

		const { toolDef } = await import('../../tools/private/get_my_trade_history.js');
		const result = await toolDef.handler({});

		expect((result as { ok: boolean }).ok).toBe(true);
	});
});

describe('get_my_trade_history — ページネーション', () => {
	it('count <= 1000 は単発リクエストで isComplete=true（件数未満）', async () => {
		setupFetchMock(mockBitbankSuccess(rawTradeHistoryResponse));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 100 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(3);
		expect(result.meta.isComplete).toBe(true);
	});

	it('count > 1000 で複数ページを自動取得する', async () => {
		// 1ページ目: 1000件（満杯）→ 2ページ目: 500件（不足 → 完了）
		const page1 = generateTrades(1000, 1, 1710000000000);
		const page2 = generateTrades(500, 1001, 1710001000000);

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 2000 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(1500);
		expect(result.meta.isComplete).toBe(true);
		expect(result.meta.tradeCount).toBe(1500);
	});

	it('ページネーションで次ページの since に executed_at + 1 を使う', async () => {
		const page1 = generateTrades(1000, 1, 1710000000000);
		const lastTimestamp = page1[page1.length - 1].executed_at; // 1710000999000
		const page2 = generateTrades(100, 1001, lastTimestamp + 1);

		const mockFn = setupSequentialFetchMock([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		await getMyTradeHistory({ count: 2000 });

		// 2回目のリクエストの URL に since=lastTimestamp+1 が含まれる
		expect(mockFn.mock.calls.length).toBe(2);
		const secondCallUrl = mockFn.mock.calls[1][0] as string;
		expect(secondCallUrl).toContain(`since=${lastTimestamp + 1}`);
	});

	it('MAX_PAGES に達すると isComplete=false で打ち切り通知', async () => {
		// 10ページ全て満杯 → isComplete=false
		const pages = Array.from({ length: 10 }, (_, pageIdx) =>
			mockBitbankSuccess({ trades: generateTrades(1000, pageIdx * 1000 + 1, 1710000000000 + pageIdx * 1000000) }),
		);

		setupSequentialFetchMock(pages);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 50000 });

		assertOk(result);
		expect(result.meta.isComplete).toBe(false);
		expect(result.summary).toContain('全件ではなく一部のみ取得されています');
	});

	it('desc 指定時にページネーション結果が新しい順にソートされる', async () => {
		const page1 = generateTrades(1000, 1, 1710000000000);
		const page2 = generateTrades(200, 1001, 1710001000000);

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 2000, order: 'desc' });

		assertOk(result);
		// desc: 先頭が最新（trade_id が大きい方）
		const tradeIds = result.data.trades.map((t: { trade_id: number }) => t.trade_id);
		expect(tradeIds[0]).toBeGreaterThan(tradeIds[tradeIds.length - 1]);
	});

	it('count=1000 ちょうどで全件返ると isComplete=false（まだある可能性）', async () => {
		const trades = generateTrades(1000, 1, 1710000000000);
		setupFetchMock(mockBitbankSuccess({ trades }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 1000 });

		assertOk(result);
		// count と同数が返った場合 → まだ続きがある可能性
		expect(result.meta.isComplete).toBe(false);
	});

	it('空配列で isComplete=true', async () => {
		setupFetchMock(mockBitbankSuccess({ trades: [] }));

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 100 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(0);
		expect(result.meta.isComplete).toBe(true);
	});
});
