/**
 * lib/pairs.ts のユニットテスト。
 * /spot/pairs 取得・キャッシュ・正規化と、validateOrderConstraints のすべての分岐を検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearPairsSpecCache,
	fetchPairsSpec,
	fractionalDigitCount,
	type PairSpec,
	SPOT_PAIRS_URL,
	validateOrderConstraints,
} from '../../lib/pairs.js';
import { mockSpotPairSpec, mockSpotPairsResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

function makePairSpec(overrides: Partial<PairSpec> = {}): PairSpec {
	return {
		name: 'btc_jpy',
		base_asset: 'btc',
		quote_asset: 'jpy',
		unit_amount: '0.0001',
		limit_max_amount: '1000',
		market_max_amount: '0.5',
		price_digits: 0,
		amount_digits: 8,
		is_enabled: true,
		stop_order: false,
		stop_order_and_cancel: false,
		stop_market_order: false,
		stop_stop_order: false,
		stop_stop_limit_order: false,
		stop_margin_long_order: false,
		stop_margin_short_order: false,
		stop_buy_order: false,
		stop_sell_order: false,
		...overrides,
	};
}

describe('fractionalDigitCount', () => {
	it('整数は 0', () => {
		expect(fractionalDigitCount('100')).toBe(0);
	});
	it('末尾ドットだけは 0', () => {
		expect(fractionalDigitCount('100.')).toBe(0);
	});
	it('小数 1 桁', () => {
		expect(fractionalDigitCount('0.1')).toBe(1);
	});
	it('小数 5 桁', () => {
		expect(fractionalDigitCount('0.12345')).toBe(5);
	});
	it('末尾ゼロは無視（"0.10" は 1 桁扱い）', () => {
		expect(fractionalDigitCount('0.10')).toBe(1);
	});
	it('末尾ゼロを大量に含むケース', () => {
		expect(fractionalDigitCount('0.00010')).toBe(4);
	});
	it('整数 + 末尾ゼロ小数（"100.000" は 0 桁扱い）', () => {
		expect(fractionalDigitCount('100.000')).toBe(0);
	});
	it('全ゼロ小数（"0.000" は 0 桁扱い）', () => {
		expect(fractionalDigitCount('0.000')).toBe(0);
	});
	it('空文字は 0', () => {
		expect(fractionalDigitCount('')).toBe(0);
	});
});

describe('validateOrderConstraints', () => {
	const baseInput = {
		pair: 'btc_jpy',
		type: 'limit' as const,
		side: 'buy' as const,
		amount: '0.01',
		price: '14000000',
	};

	describe('ペア存在チェック', () => {
		it('spec=undefined は pair 違反', () => {
			const v = validateOrderConstraints(undefined, baseInput);
			expect(v?.field).toBe('pair');
			expect(v?.message).toContain('未対応のペア');
			expect(v?.message).toContain('btc_jpy');
		});
	});

	describe('取引停止フラグ', () => {
		it('is_enabled=false で pair 違反', () => {
			const v = validateOrderConstraints(makePairSpec({ is_enabled: false }), baseInput);
			expect(v?.field).toBe('pair');
			expect(v?.message).toContain('取引停止');
		});

		it('stop_order_and_cancel=true で pair 違反（stop_order より優先）', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_order: true, stop_order_and_cancel: true }), baseInput);
			expect(v?.field).toBe('pair');
			expect(v?.message).toContain('stop_order_and_cancel');
		});

		it('stop_order=true で pair 違反', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_order: true }), baseInput);
			expect(v?.field).toBe('pair');
			expect(v?.message).toContain('新規注文を停止');
		});
	});

	describe('type 単位の停止フラグ', () => {
		it('market 注文停止', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_market_order: true }), {
				...baseInput,
				type: 'market',
				price: undefined,
			});
			expect(v?.field).toBe('type');
			expect(v?.message).toContain('market');
		});

		it('stop 注文停止', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_stop_order: true }), {
				...baseInput,
				type: 'stop',
				price: undefined,
				trigger_price: '13000000',
			});
			expect(v?.field).toBe('type');
			expect(v?.message).toContain('stop 注文');
		});

		it('stop_limit 注文停止', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_stop_limit_order: true }), {
				...baseInput,
				type: 'stop_limit',
				trigger_price: '14000000',
			});
			expect(v?.field).toBe('type');
			expect(v?.message).toContain('stop_limit');
		});

		it('limit 注文停止フラグはない（=stop_market_order=true でも limit は通る）', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_market_order: true }), baseInput);
			expect(v).toBeNull();
		});
	});

	describe('side 単位の停止フラグ', () => {
		it('buy 注文停止', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_buy_order: true }), baseInput);
			expect(v?.field).toBe('side');
			expect(v?.message).toContain('buy');
		});

		it('sell 注文停止', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_sell_order: true }), {
				...baseInput,
				side: 'sell',
			});
			expect(v?.field).toBe('side');
			expect(v?.message).toContain('sell');
		});

		it('buy 注文停止は sell では発生しない', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_buy_order: true }), { ...baseInput, side: 'sell' });
			expect(v).toBeNull();
		});
	});

	describe('信用新規建ての停止', () => {
		it('ロング新規建て（buy+long）が stop_margin_long_order で拒否', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_margin_long_order: true }), {
				...baseInput,
				position_side: 'long',
			});
			expect(v?.field).toBe('type');
			expect(v?.message).toContain('ロング新規建て');
		});

		it('ロング決済（sell+long）は stop_margin_long_order の影響を受けない', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_margin_long_order: true }), {
				...baseInput,
				side: 'sell',
				position_side: 'long',
			});
			expect(v).toBeNull();
		});

		it('ショート新規建て（sell+short）が stop_margin_short_order で拒否', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_margin_short_order: true }), {
				...baseInput,
				side: 'sell',
				position_side: 'short',
			});
			expect(v?.field).toBe('type');
			expect(v?.message).toContain('ショート新規建て');
		});

		it('ショート決済（buy+short）は stop_margin_short_order の影響を受けない', () => {
			const v = validateOrderConstraints(makePairSpec({ stop_margin_short_order: true }), {
				...baseInput,
				position_side: 'short',
			});
			expect(v).toBeNull();
		});
	});

	describe('最小数量チェック', () => {
		it('amount < unit_amount で amount 違反', () => {
			const v = validateOrderConstraints(makePairSpec({ unit_amount: '0.001' }), { ...baseInput, amount: '0.0001' });
			expect(v?.field).toBe('amount');
			expect(v?.message).toContain('最小注文数量 0.001');
			expect(v?.message).toContain('BTC');
		});

		it('amount === unit_amount は通る（境界値）', () => {
			const v = validateOrderConstraints(makePairSpec({ unit_amount: '0.001' }), { ...baseInput, amount: '0.001' });
			expect(v).toBeNull();
		});

		it('amount > unit_amount は通る', () => {
			const v = validateOrderConstraints(makePairSpec({ unit_amount: '0.0001' }), { ...baseInput, amount: '0.01' });
			expect(v).toBeNull();
		});
	});

	describe('最大数量チェック', () => {
		it('limit 注文で limit_max_amount を超えると違反', () => {
			const v = validateOrderConstraints(makePairSpec({ limit_max_amount: '10' }), { ...baseInput, amount: '20' });
			expect(v?.field).toBe('amount');
			expect(v?.message).toContain('最大注文数量 10');
			expect(v?.message).toContain('limit / stop_limit');
		});

		it('market 注文で market_max_amount を超えると違反', () => {
			const v = validateOrderConstraints(makePairSpec({ market_max_amount: '0.5' }), {
				...baseInput,
				type: 'market',
				price: undefined,
				amount: '1',
			});
			expect(v?.field).toBe('amount');
			expect(v?.message).toContain('最大注文数量 0.5');
			expect(v?.message).toContain('market / stop');
		});

		it('stop_limit は limit_max_amount を使う', () => {
			const v = validateOrderConstraints(makePairSpec({ limit_max_amount: '10', market_max_amount: '0.5' }), {
				...baseInput,
				type: 'stop_limit',
				trigger_price: '14000000',
				amount: '20',
			});
			expect(v?.field).toBe('amount');
			expect(v?.message).toContain('limit / stop_limit');
		});

		it('stop は market_max_amount を使う', () => {
			const v = validateOrderConstraints(makePairSpec({ limit_max_amount: '10', market_max_amount: '0.5' }), {
				...baseInput,
				type: 'stop',
				price: undefined,
				trigger_price: '13000000',
				amount: '1',
			});
			expect(v?.field).toBe('amount');
			expect(v?.message).toContain('market / stop');
		});

		it('limit_max_amount が空文字 / 0 のときは検証スキップ', () => {
			const v = validateOrderConstraints(makePairSpec({ limit_max_amount: '' }), { ...baseInput, amount: '99999' });
			expect(v).toBeNull();
		});
	});

	describe('数量の小数桁数チェック', () => {
		it('amount_digits を超えると違反', () => {
			const v = validateOrderConstraints(makePairSpec({ amount_digits: 4 }), { ...baseInput, amount: '0.12345' });
			expect(v?.field).toBe('amount');
			expect(v?.message).toContain('小数桁数 (5)');
			expect(v?.message).toContain('許容上限 (4)');
		});

		it('amount_digits 以下は通る', () => {
			const v = validateOrderConstraints(makePairSpec({ amount_digits: 4 }), { ...baseInput, amount: '0.1234' });
			expect(v).toBeNull();
		});

		it('末尾ゼロは無視される（"0.10000" は 1 桁扱い）', () => {
			const v = validateOrderConstraints(makePairSpec({ amount_digits: 2 }), { ...baseInput, amount: '0.10000' });
			expect(v).toBeNull();
		});
	});

	describe('価格の小数桁数チェック', () => {
		it('price_digits=0 のペアで小数の price は違反', () => {
			const v = validateOrderConstraints(makePairSpec({ price_digits: 0 }), {
				...baseInput,
				price: '14000000.5',
			});
			expect(v?.field).toBe('price');
			expect(v?.message).toContain('price の小数桁数 (1)');
		});

		it('price_digits=3 のペアで price=100.123 は通る', () => {
			const v = validateOrderConstraints(makePairSpec({ price_digits: 3 }), {
				...baseInput,
				price: '100.123',
			});
			expect(v).toBeNull();
		});

		it('price 未指定（market）はスキップ', () => {
			const v = validateOrderConstraints(makePairSpec({ price_digits: 0 }), {
				...baseInput,
				type: 'market',
				price: undefined,
			});
			expect(v).toBeNull();
		});

		it('trigger_price の桁数も検証する', () => {
			const v = validateOrderConstraints(makePairSpec({ price_digits: 0 }), {
				...baseInput,
				type: 'stop_limit',
				price: '14000000',
				trigger_price: '13000000.5',
			});
			expect(v?.field).toBe('trigger_price');
			expect(v?.message).toContain('trigger_price の小数桁数');
		});
	});

	describe('正常系', () => {
		it('全条件を満たす標準的な注文は null', () => {
			const v = validateOrderConstraints(makePairSpec(), baseInput);
			expect(v).toBeNull();
		});
	});
});

describe('fetchPairsSpec', () => {
	beforeEach(() => {
		clearPairsSpecCache();
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		clearPairsSpecCache();
		vi.restoreAllMocks();
	});

	it('成功時はペア名 → spec の Map を返す', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const map = await fetchPairsSpec();
		expect(map.size).toBeGreaterThanOrEqual(2);
		const btc = map.get('btc_jpy');
		expect(btc?.unit_amount).toBe('0.0001');
		expect(btc?.amount_digits).toBe(8);
		expect(btc?.is_enabled).toBe(true);
	});

	it('手数料率フィールドを文字列のまま保持する', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const map = await fetchPairsSpec();
		const btc = map.get('btc_jpy');
		// フィクスチャ: taker 0.0012 / maker -0.0002（負リベート）/ base 0 / margin null
		expect(btc?.taker_fee_rate_quote).toBe('0.0012');
		expect(btc?.maker_fee_rate_quote).toBe('-0.0002');
		expect(btc?.taker_fee_rate_base).toBe('0');
		expect(btc?.maker_fee_rate_base).toBe('0');
	});

	it('欠損した手数料率フィールドは null になる', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }),
		);
		const map = await fetchPairsSpec();
		const btc = map.get('btc_jpy');
		// フィクスチャの margin_* は null
		expect(btc?.margin_open_maker_fee_rate_quote).toBeNull();
		expect(btc?.margin_open_taker_fee_rate_quote).toBeNull();
		expect(btc?.margin_close_maker_fee_rate_quote).toBeNull();
		expect(btc?.margin_close_taker_fee_rate_quote).toBeNull();
	});

	it('手数料率フィールドが完全に欠落していても null で正規化される', async () => {
		// fee 系を一切含まない最小ペア（unit_amount のみ override し name 維持）
		const bare = {
			name: 'xrp_jpy',
			base_asset: 'xrp',
			quote_asset: 'jpy',
			unit_amount: '1',
			limit_max_amount: '10000',
			market_max_amount: '5000',
			price_digits: 3,
			amount_digits: 4,
			is_enabled: true,
		};
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ success: 1, data: { pairs: [bare] } }), { status: 200 }),
		);
		const map = await fetchPairsSpec();
		const xrp = map.get('xrp_jpy');
		expect(xrp?.taker_fee_rate_quote).toBeNull();
		expect(xrp?.maker_fee_rate_quote).toBeNull();
		expect(xrp?.margin_open_maker_fee_rate_quote).toBeNull();
	});

	it('SPOT_PAIRS_URL を叩く', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		await fetchPairsSpec();
		expect(spy).toHaveBeenCalledWith(SPOT_PAIRS_URL, expect.objectContaining({ signal: expect.any(Object) }));
	});

	it('キャッシュが効く（2回目は fetch しない）', async () => {
		const spy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		await fetchPairsSpec();
		await fetchPairsSpec();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('HTTP エラーで throw', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
		await expect(fetchPairsSpec()).rejects.toThrow(/取得失敗/);
	});

	it('success:0 で throw', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ success: 0, data: { code: 10000 } }), { status: 200 }),
		);
		await expect(fetchPairsSpec()).rejects.toThrow(/上流レスポンスが不正/);
	});

	it('pairs が空配列で throw', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ success: 1, data: { pairs: [] } }), { status: 200 }),
		);
		await expect(fetchPairsSpec()).rejects.toThrow(/空/);
	});

	it('ネットワークエラーで throw', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('fetch failed'));
		await expect(fetchPairsSpec()).rejects.toThrow(/取得失敗/);
	});

	it('タイムアウトは "取得タイムアウト" メッセージで throw', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementationOnce(
			() =>
				new Promise((_, reject) => {
					setTimeout(() => {
						const err = new Error('aborted');
						err.name = 'AbortError';
						reject(err);
					}, 5);
				}),
		);
		await expect(fetchPairsSpec({ timeoutMs: 1 })).rejects.toThrow(/取得タイムアウト/);
	});

	it('name 無しのペアは無視される', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					success: 1,
					data: { pairs: [mockSpotPairSpec({ name: 'btc_jpy' }), { /* no name */ unit_amount: '1' }] },
				}),
				{ status: 200 },
			),
		);
		const map = await fetchPairsSpec();
		expect(map.has('btc_jpy')).toBe(true);
		expect(map.size).toBe(1);
	});
});

// TTL 入力値の検証。Number('') === 0 など、誤った env で「キャッシュ実質無効」を
// 招かないこと（resolvePairsTtlMs 経由でデフォルトにフォールバック）を保証する。
describe('BITBANK_SPOT_PAIRS_TTL_MS の入力値検証', () => {
	const originalTtl = process.env.BITBANK_SPOT_PAIRS_TTL_MS;

	beforeEach(() => {
		// 各テストで lib/pairs.ts を fresh import するため module cache をリセット
		vi.resetModules();
	});

	afterEach(() => {
		if (originalTtl == null) delete process.env.BITBANK_SPOT_PAIRS_TTL_MS;
		else process.env.BITBANK_SPOT_PAIRS_TTL_MS = originalTtl;
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	async function fetchTwice(spy: ReturnType<typeof vi.fn>): Promise<number> {
		globalThis.fetch = spy as unknown as typeof fetch;
		const mod = await import('../../lib/pairs.js');
		mod.clearPairsSpecCache();
		await mod.fetchPairsSpec();
		await mod.fetchPairsSpec();
		return spy.mock.calls.length;
	}

	it('空文字はデフォルト TTL にフォールバック（キャッシュが効く）', async () => {
		process.env.BITBANK_SPOT_PAIRS_TTL_MS = '';
		const spy = vi.fn(async () => new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		expect(await fetchTwice(spy)).toBe(1);
	});

	it('"0" はデフォルト TTL にフォールバック（キャッシュが効く）', async () => {
		process.env.BITBANK_SPOT_PAIRS_TTL_MS = '0';
		const spy = vi.fn(async () => new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		expect(await fetchTwice(spy)).toBe(1);
	});

	it('負値はデフォルト TTL にフォールバック', async () => {
		process.env.BITBANK_SPOT_PAIRS_TTL_MS = '-1000';
		const spy = vi.fn(async () => new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		expect(await fetchTwice(spy)).toBe(1);
	});

	it('NaN 文字列はデフォルト TTL にフォールバック', async () => {
		process.env.BITBANK_SPOT_PAIRS_TTL_MS = 'abc';
		const spy = vi.fn(async () => new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		expect(await fetchTwice(spy)).toBe(1);
	});

	it('正の有限値は採用される', async () => {
		process.env.BITBANK_SPOT_PAIRS_TTL_MS = '60000';
		const spy = vi.fn(async () => new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 }));
		// fetch 1 回でキャッシュが効き、2 回目は呼ばれない
		expect(await fetchTwice(spy)).toBe(1);
	});
});
