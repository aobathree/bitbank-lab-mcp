/**
 * portfolio/fetch のページネーションロジックのユニットテスト。
 *
 * 検証対象:
 *   - ページ境界の同一タイムスタンプレコードの取りこぼし防止（trade_id / uuid 重複排除）
 *   - 進捗ゼロ検出による無限ループ防止
 *   - 通常ケース（境界重複なし）のリグレッション防止
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paginateMarginTrades, paginateTrades } from '../../../src/handlers/portfolio/fetch.js';
import { BitbankPrivateClient } from '../../../src/private/client.js';
import { mockBitbankSuccess } from '../../fixtures/private-api.js';

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
});

/** 順次レスポンスを返す fetcher（呼び出し回数と URL を記録する） */
function makeSequentialFetcher(responses: unknown[]) {
	const calls: string[] = [];
	let index = 0;
	const fetcher = async (url: string) => {
		calls.push(url);
		if (index >= responses.length) {
			throw new Error(`Unexpected fetch call #${index + 1}: ${url}`);
		}
		const body = responses[index++];
		return new Response(JSON.stringify(body), { status: 200 });
	};
	return { fetcher, calls };
}

function makeTrade(overrides: { trade_id: number; executed_at: number; pair?: string }) {
	return {
		trade_id: overrides.trade_id,
		pair: overrides.pair ?? 'btc_jpy',
		order_id: 5000 + overrides.trade_id,
		side: 'buy' as const,
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0.00001',
		fee_amount_quote: '0',
		executed_at: overrides.executed_at,
	};
}

function makeMarginTrade(overrides: { trade_id: number; executed_at: number; profit_loss?: string }) {
	return {
		trade_id: overrides.trade_id,
		pair: 'btc_jpy',
		order_id: 5000 + overrides.trade_id,
		side: 'sell' as const,
		position_side: 'long',
		type: 'limit',
		amount: '0.01',
		price: '15000000',
		maker_taker: 'maker',
		fee_amount_base: '0',
		fee_amount_quote: '0',
		profit_loss: overrides.profit_loss,
		executed_at: overrides.executed_at,
	};
}

function makeDeposit(overrides: { uuid: string; confirmed_at: number; asset?: string }) {
	return {
		uuid: overrides.uuid,
		asset: overrides.asset ?? 'jpy',
		amount: '1000',
		status: 'DONE',
		found_at: overrides.confirmed_at - 100,
		confirmed_at: overrides.confirmed_at,
	};
}

function makeWithdrawal(overrides: { uuid: string; requested_at: number; asset?: string }) {
	return {
		uuid: overrides.uuid,
		asset: overrides.asset ?? 'jpy',
		amount: '1000',
		fee: '550',
		status: 'DONE',
		requested_at: overrides.requested_at,
	};
}

describe('paginateTrades — ページネーション境界', () => {
	it('ページ境界に同一 executed_at のレコードが跨っていても全件取得できる', async () => {
		// バグ回帰防止: 旧実装は executed_at + 1 を次ページ since にしていたため、
		// ページ末尾と次ページ先頭に同じ executed_at が存在すると取りこぼしていた。
		// page1 末尾 3 件（id 998-1000）と page2 先頭 2 件（id 998, 1000）が同一 ts。
		// page2 には id 1001-1003 の新規レコードも同一 ts で存在し、旧実装ではスキップされていた。
		const tBoundary = 1710000999000;
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({
				trade_id: i + 1,
				executed_at: i < 997 ? 1710000000000 + i * 1000 : tBoundary,
			}),
		);
		const page2 = [
			makeTrade({ trade_id: 998, executed_at: tBoundary }),
			makeTrade({ trade_id: 1000, executed_at: tBoundary }),
			makeTrade({ trade_id: 1001, executed_at: tBoundary }),
			makeTrade({ trade_id: 1002, executed_at: tBoundary }),
			makeTrade({ trade_id: 1003, executed_at: tBoundary + 1000 }),
		];

		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		// 全 1003 件（page1 1000 + page2 新規 3）が取得され、重複 2 件は dedup される
		expect(result.trades).toHaveLength(1003);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toContain(1001);
		expect(ids).toContain(1002);
		expect(ids).toContain(1003);
		expect(new Set(ids).size).toBe(ids.length);

		// 2 回目の URL に since=tBoundary（+1 ではない）が含まれることを検証
		expect(calls.length).toBe(2);
		expect(calls[1]).toContain(`since=${tBoundary}`);
		expect(calls[1]).not.toContain(`since=${tBoundary + 1}`);
		expect(result.truncated).toBe(false);
	});

	it('連続ページで重複する trade_id は dedup される（次ページ先頭が前ページ末尾と一致）', async () => {
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000 }),
		);
		// page2 先頭 2 件を page1 末尾と意図的に重複させる
		const lastTwo = page1.slice(-2);
		const newRecords = Array.from({ length: 997 }, (_, i) =>
			makeTrade({ trade_id: 1001 + i, executed_at: 1710001000000 + i * 1000 }),
		);
		const page2 = [...lastTwo, ...newRecords];

		const { fetcher } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		// 1000 (page1) + 997 (page2 新規) = 1997 件
		expect(result.trades).toHaveLength(1997);
		const ids = result.trades.map((t) => t.trade_id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(result.truncated).toBe(false);
	});

	it('全件同一 executed_at で進捗ゼロのとき truncated=true で打ち切る（無限ループ防止）', async () => {
		// 同一 ts が PAGE_SIZE 件以上連続するエッジケース。新実装は since=lastTs にしているため、
		// 次ページが同じ範囲を返し続けて進捗ゼロになると無限ループする可能性がある。
		// 進捗ゼロ検出により truncated=true で打ち切られることを検証。
		const sameTs = 1710000000000;
		const page1 = Array.from({ length: 1000 }, (_, i) => makeTrade({ trade_id: i + 1, executed_at: sameTs }));
		// 次ページ以降も全く同じレコードを返す（API が since=sameTs で同じ範囲を返却する想定）
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page1 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		// MAX_PAGES (10) より早く打ち切られたことを確認（page1 + 1 回目の重複検出 = 2 回）
		expect(calls.length).toBeLessThan(10);
	});

	it('境界に重複がない通常ケース: ページネーションが従来どおり動作する（リグレッション防止）', async () => {
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeTrade({ trade_id: i + 1, executed_at: 1710000000000 + i * 1000 }),
		);
		const page2 = Array.from({ length: 500 }, (_, i) =>
			makeTrade({ trade_id: 1001 + i, executed_at: 1710001000000 + i * 1000 }),
		);

		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(1500);
		expect(result.truncated).toBe(false);
		expect(calls.length).toBe(2);
	});

	it('空配列レスポンスで truncated=false を返す', async () => {
		const { fetcher } = makeSequentialFetcher([mockBitbankSuccess({ trades: [] })]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateTrades(client);
		expect(result.trades).toHaveLength(0);
		expect(result.truncated).toBe(false);
	});
});

describe('paginateMarginTrades — ページネーション境界', () => {
	it('ページ境界に同一 executed_at の信用約定が跨っていても全件取得できる', async () => {
		const tBoundary = 1710000999000;
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeMarginTrade({
				trade_id: i + 1,
				executed_at: i < 998 ? 1710000000000 + i * 1000 : tBoundary,
				profit_loss: '100',
			}),
		);
		const page2 = [
			makeMarginTrade({ trade_id: 999, executed_at: tBoundary, profit_loss: '100' }),
			makeMarginTrade({ trade_id: 1000, executed_at: tBoundary, profit_loss: '100' }),
			makeMarginTrade({ trade_id: 1001, executed_at: tBoundary, profit_loss: '200' }),
			makeMarginTrade({ trade_id: 1002, executed_at: tBoundary + 1000, profit_loss: '300' }),
		];

		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page2 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		// 1000 (page1) + 2 新規 (id 1001, 1002) = 1002 件
		expect(result.trades).toHaveLength(1002);
		const ids = result.trades.map((t) => t.trade_id);
		expect(ids).toContain(1001);
		expect(ids).toContain(1002);
		expect(new Set(ids).size).toBe(ids.length);
		expect(result.truncated).toBe(false);
		// 2 回目の URL に type=margin と since=tBoundary が含まれる
		expect(calls[1]).toContain('type=margin');
		expect(calls[1]).toContain(`since=${tBoundary}`);
	});

	it('全件同一 executed_at で進捗ゼロのとき truncated=true で打ち切る', async () => {
		const sameTs = 1710000000000;
		const page1 = Array.from({ length: 1000 }, (_, i) =>
			makeMarginTrade({ trade_id: i + 1, executed_at: sameTs, profit_loss: '100' }),
		);
		const { fetcher, calls } = makeSequentialFetcher([
			mockBitbankSuccess({ trades: page1 }),
			mockBitbankSuccess({ trades: page1 }),
		]);
		const client = new BitbankPrivateClient({ fetcher });

		const result = await paginateMarginTrades(client);
		expect(result.trades).toHaveLength(1000);
		expect(result.truncated).toBe(true);
		expect(calls.length).toBeLessThan(10);
	});
});

describe('paginateDeposits / paginateWithdrawals — ページネーション境界', () => {
	// paginateDeposits / paginateWithdrawals は非エクスポート関数だが、fetchDepositWithdrawal
	// 経由で間接的に検証する。
	it('入金: ページ境界に同一 confirmed_at の入金が跨っていても uuid で dedup されて全件取得', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const tBoundary = 1710000999000;
		// crypto 入金: page1 1000 件（うち末尾 3 件が同一 ts）+ page2 5 件（先頭 2 件重複 + 新規 3 件）
		const cryptoPage1 = Array.from({ length: 1000 }, (_, i) =>
			makeDeposit({
				uuid: `dep-${i + 1}`,
				confirmed_at: i < 997 ? 1710000000000 + i * 1000 : tBoundary,
				asset: 'btc',
			}),
		);
		const cryptoPage2 = [
			makeDeposit({ uuid: 'dep-998', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-1000', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-1001', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-1002', confirmed_at: tBoundary, asset: 'btc' }),
			makeDeposit({ uuid: 'dep-1003', confirmed_at: tBoundary + 1000, asset: 'btc' }),
		];

		// URL ベースで crypto / jpy を振り分ける fetcher
		let cryptoPage = 0;
		const fetcher = vi.fn(async (url: string) => {
			// jpy のレスポンスは空（テストでは crypto のみ検証）
			if (url.includes('asset=jpy')) {
				if (url.includes('deposit_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
			}
			if (url.includes('deposit_history')) {
				const body = cryptoPage === 0 ? cryptoPage1 : cryptoPage2;
				cryptoPage++;
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: body })), { status: 200 });
			}
			// withdrawal: crypto 側も空
			return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		expect(result).not.toBeNull();
		// crypto 入金 1003 件（重複 2 件除く）が dedup されている
		expect(result!.deposits).toHaveLength(1003);
		const uuids = result!.deposits.map((d) => d.uuid);
		expect(uuids).toContain('dep-1001');
		expect(uuids).toContain('dep-1002');
		expect(uuids).toContain('dep-1003');
		expect(new Set(uuids).size).toBe(uuids.length);
		expect(result!.isComplete).toBe(true);

		// crypto deposit の 2 回目呼び出しの URL に since=tBoundary（+1 ではない）が含まれる
		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const cryptoDepositCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('deposit_history') && !u.includes('asset=jpy'));
		expect(cryptoDepositCalls.length).toBeGreaterThanOrEqual(2);
		expect(cryptoDepositCalls[1]).toContain(`since=${tBoundary}`);
		expect(cryptoDepositCalls[1]).not.toContain(`since=${tBoundary + 1}`);
	});

	it('出金: ページ境界に同一 requested_at の出金が跨っていても uuid で dedup されて全件取得', async () => {
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const tBoundary = 1710000999000;
		const cryptoWdPage1 = Array.from({ length: 1000 }, (_, i) =>
			makeWithdrawal({
				uuid: `wd-${i + 1}`,
				requested_at: i < 998 ? 1710000000000 + i * 1000 : tBoundary,
				asset: 'btc',
			}),
		);
		const cryptoWdPage2 = [
			makeWithdrawal({ uuid: 'wd-999', requested_at: tBoundary, asset: 'btc' }),
			makeWithdrawal({ uuid: 'wd-1000', requested_at: tBoundary, asset: 'btc' }),
			makeWithdrawal({ uuid: 'wd-1001', requested_at: tBoundary, asset: 'btc' }),
			makeWithdrawal({ uuid: 'wd-1002', requested_at: tBoundary + 1000, asset: 'btc' }),
		];

		let cryptoPage = 0;
		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('asset=jpy')) {
				if (url.includes('withdrawal_history')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
				}
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
			}
			if (url.includes('withdrawal_history')) {
				const body = cryptoPage === 0 ? cryptoWdPage1 : cryptoWdPage2;
				cryptoPage++;
				return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: body })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		expect(result).not.toBeNull();
		// 1000 + 2 新規 (wd-1001, wd-1002) = 1002 件
		expect(result!.withdrawals).toHaveLength(1002);
		const uuids = result!.withdrawals.map((w) => w.uuid);
		expect(uuids).toContain('wd-1001');
		expect(uuids).toContain('wd-1002');
		expect(new Set(uuids).size).toBe(uuids.length);
		expect(result!.isComplete).toBe(true);

		const fetchMock = fetcher as unknown as ReturnType<typeof vi.fn>;
		const cryptoWdCalls = fetchMock.mock.calls
			.map((c) => c[0] as string)
			.filter((u) => u.includes('withdrawal_history') && !u.includes('asset=jpy'));
		expect(cryptoWdCalls[1]).toContain(`since=${tBoundary}`);
		expect(cryptoWdCalls[1]).not.toContain(`since=${tBoundary + 1}`);
	});

	it('JPY/crypto 間で同一 uuid の入金は重複排除される（fetchDepositWithdrawal レベルの dedup を維持）', async () => {
		// fetchDepositWithdrawal は JPY と crypto を別チャネルで取得して結合するため、
		// 万一同一 uuid が両方に現れる場合の dedup が必要（既存仕様の維持を検証）。
		const { fetchDepositWithdrawal } = await import('../../../src/handlers/portfolio/fetch.js');
		const sharedDeposit = makeDeposit({ uuid: 'dup-1', confirmed_at: 1710000000000, asset: 'jpy' });

		const fetcher = vi.fn(async (url: string) => {
			if (url.includes('deposit_history')) {
				return new Response(JSON.stringify(mockBitbankSuccess({ deposits: [sharedDeposit] })), { status: 200 });
			}
			return new Response(JSON.stringify(mockBitbankSuccess({ withdrawals: [] })), { status: 200 });
		}) as unknown as typeof fetch;
		const client = new BitbankPrivateClient({ fetcher });

		const result = await fetchDepositWithdrawal(client);
		expect(result).not.toBeNull();
		// crypto / jpy 両チャネルで同じ uuid が返っても 1 件に集約される
		expect(result!.deposits).toHaveLength(1);
		expect(result!.deposits[0].uuid).toBe('dup-1');
	});
});
