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

	it('ページネーションで次ページの since に最後の executed_at をそのまま使う（境界バグ修正）', async () => {
		// バグ回帰防止: 旧実装は executed_at + 1 を since に渡していたため、同一ミリ秒の
		// 境界レコードを次ページで取りこぼしていた。新実装は executed_at をそのまま渡し、
		// trade_id で dedup する。
		const page1 = generateTrades(1000, 1, 1710000000000);
		const lastTimestamp = page1[page1.length - 1].executed_at; // 1710000999000
		const page2 = generateTrades(100, 1001, lastTimestamp + 1);

		const mockFn = setupSequentialFetchMock([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		await getMyTradeHistory({ count: 2000 });

		// 2回目のリクエストの URL に since=lastTimestamp が含まれる（+1 されていない）
		expect(mockFn.mock.calls.length).toBe(2);
		const secondCallUrl = mockFn.mock.calls[1][0] as string;
		expect(secondCallUrl).toContain(`since=${lastTimestamp}`);
		expect(secondCallUrl).not.toContain(`since=${lastTimestamp + 1}`);
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

	it('ページ境界に同一 executed_at のレコードが跨っていても全件取得できる（境界バグ修正）', async () => {
		// バグ回帰防止: 旧実装は executed_at + 1 を次ページ since にしていたため、
		// ページ末尾と次ページ先頭に同じ executed_at が存在すると取りこぼしていた。
		// 新実装は executed_at をそのまま使い、trade_id ベースで dedup する。
		// page1: 末尾 3 件（id 998-1000）が同一 executed_at = T_boundary
		// page2: 先頭 2 件（id 998, 1000）が page1 と重複（同一 ts のため API が再返却）
		//        続く 3 件（id 1001-1003）が新規
		const tBoundary = 1710000999000;
		const page1 = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: i + 1,
			pair: 'btc_jpy',
			order_id: 5000 + i,
			side: 'buy',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: i < 997 ? 1710000000000 + i * 1000 : tBoundary,
		}));
		const page2 = [
			// 同一 ts の前ページ末尾 2 件が再出現（dedup される）
			{
				trade_id: 998,
				pair: 'btc_jpy',
				order_id: 5997,
				side: 'buy',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: tBoundary,
			},
			{
				trade_id: 1000,
				pair: 'btc_jpy',
				order_id: 5999,
				side: 'buy',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0.00001',
				fee_amount_quote: '0',
				executed_at: tBoundary,
			},
			// 旧実装ではここからスキップされていた同一 ts の残レコード
			{
				trade_id: 1001,
				pair: 'btc_jpy',
				order_id: 6001,
				side: 'sell',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0',
				fee_amount_quote: '150',
				executed_at: tBoundary,
			},
			{
				trade_id: 1002,
				pair: 'btc_jpy',
				order_id: 6002,
				side: 'sell',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0',
				fee_amount_quote: '150',
				executed_at: tBoundary,
			},
			{
				trade_id: 1003,
				pair: 'btc_jpy',
				order_id: 6003,
				side: 'sell',
				type: 'limit',
				amount: '0.01',
				price: '15000000',
				maker_taker: 'maker',
				fee_amount_base: '0',
				fee_amount_quote: '150',
				executed_at: tBoundary + 1000,
			},
		];

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 2000, order: 'asc' });

		assertOk(result);
		// 全 1003 件（page1 1000 + page2 新規 3）が取得され、重複 2 件は dedup される
		expect(result.data.trades).toHaveLength(1003);
		const ids = result.data.trades.map((t) => t.trade_id);
		// 同一 ts の残レコード（1001, 1002, 1003）が含まれている
		expect(ids).toContain(1001);
		expect(ids).toContain(1002);
		expect(ids).toContain(1003);
		// 重複は 1 件だけ
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it('count を満たして打ち切ったときは isComplete=false（取り切れた保証はない）', async () => {
		// バグ回帰防止 (Medium 2): 旧実装は count に達したら isComplete=true を返していたが、
		// 期間内にまだ未取得レコードがある可能性があるため誤誘導していた。
		// page1: 1000 件（満杯）→ page2: 1000 件（満杯）= 計 2000 件で count を満たす。
		// 期間内にさらにレコードがあるかは分からないため isComplete=false が正しい。
		const page1 = generateTrades(1000, 1, 1710000000000);
		const page2 = generateTrades(1000, 1001, 1710001000000);

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 2000 });

		assertOk(result);
		expect(result.data.trades).toHaveLength(2000);
		expect(result.meta.isComplete).toBe(false);
		expect(result.summary).toContain('全件ではなく一部のみ取得されています');
	});

	it('全件同一 executed_at で進捗ゼロのとき isComplete=false で無限ループせず打ち切る', async () => {
		// 同一 ts が PAGE_SIZE 件以上連続するエッジケース。新実装は since=lastTs にしているため、
		// 次ページが同じ範囲を返し続けて進捗ゼロになると無限ループする可能性がある。
		// 進捗ゼロ検出により isComplete=false で打ち切られることを検証。
		const sameTs = 1710000000000;
		const page1 = Array.from({ length: 1000 }, (_, i) => ({
			trade_id: i + 1,
			pair: 'btc_jpy',
			order_id: 5000 + i,
			side: 'buy',
			type: 'limit',
			amount: '0.01',
			price: '15000000',
			maker_taker: 'maker',
			fee_amount_base: '0.00001',
			fee_amount_quote: '0',
			executed_at: sameTs,
		}));
		// 次ページ以降も全く同じレコードを返す（API が since=sameTs で同じ範囲を返却する想定）
		const responses = [mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page1 })];
		const mockFn = setupSequentialFetchMock(responses);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 5000 });

		assertOk(result);
		// 1 ページ目で 1000 件取得 → 2 ページ目で全件重複 → 進捗ゼロで打ち切り
		expect(result.data.trades).toHaveLength(1000);
		expect(result.meta.isComplete).toBe(false);
		// MAX_PAGES (10) より早く打ち切られたことを fetch 呼び出し回数で確認
		expect(mockFn.mock.calls.length).toBeLessThan(10);
	});

	it('連続ページで重複する trade_id は dedup される', async () => {
		// page2 の先頭が page1 の末尾と同じ trade_id を返すケース（境界バグ修正の副作用）。
		// dedup により最終結果に 1 件だけ含まれることを検証。
		// page2 は 999 件（< PAGE_SIZE）に抑え、ループが自然終了するようにする。
		const page1 = generateTrades(1000, 1, 1710000000000);
		// page2 の先頭 2 件を page1 末尾と意図的に重複させる
		const lastTwo = page1.slice(-2);
		const newRecords = generateTrades(997, 1001, 1710001000000);
		const page2 = [...lastTwo, ...newRecords];

		setupSequentialFetchMock([mockBitbankSuccess({ trades: page1 }), mockBitbankSuccess({ trades: page2 })]);

		const { default: getMyTradeHistory } = await import('../../tools/private/get_my_trade_history.js');
		const result = await getMyTradeHistory({ count: 3000 });

		assertOk(result);
		// 1000 (page1) + 997 (page2 新規) = 1997 件
		expect(result.data.trades).toHaveLength(1997);
		const ids = result.data.trades.map((t) => t.trade_id);
		expect(new Set(ids).size).toBe(ids.length);
		// page2 が PAGE_SIZE 未満なので全件取得完了
		expect(result.meta.isComplete).toBe(true);
	});
});
