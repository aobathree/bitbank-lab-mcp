/**
 * mid（中値）丸め規約のツール間整合テスト。
 *
 * 同一の /depth スナップショットを get_orderbook（全 mode）/ prepare_depth_data /
 * lib/get-depth に通したとき、mid が経路によって食い違わない（同一板 → 同一 mid）
 * ことを固定する。
 *
 * 背景: 以前は経路ごとに toFixed(2)（小数2桁）と Math.round（整数）が混在し、
 * 奇数 spread の板で LLM が複数ツールをクロスチェックすると mid が乖離していた。
 * 丸め規約は lib/price.ts（roundPrice）へ集約し、JPY ペアは整数へ統一した。
 *
 * 設計は tests/fee-source-consistency.test.ts（別経路の同一量一致を固定する）に倣う。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import getDepth from '../lib/get-depth.js';
import { isJpyPair, roundPrice } from '../lib/price.js';
import getOrderbook from '../tools/get_orderbook.js';
import prepareDepthData from '../tools/prepare_depth_data.js';
import { asMockResult, assertOk } from './_assertResult.js';

const TS = 1_700_000_000_000;

/**
 * 単一の /depth レスポンスを返す fetch モック。
 * get_orderbook（直接 fetch）と prepare_depth_data / get-depth（lib/get-depth 経由 fetch）の
 * 両経路が同一スナップショットを共有する。mockResolvedValue で複数回の fetch に応答する。
 */
function mockDepth(asks: [string, string][], bids: [string, string][]) {
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(
		asMockResult<Response>({
			ok: true,
			status: 200,
			statusText: 'OK',
			headers: new Headers(),
			json: async () => ({ success: 1, data: { asks, bids, timestamp: TS } }),
		}),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('lib/price — roundPrice / isJpyPair（丸め規約の単一ソース）', () => {
	it('isJpyPair: _jpy 接尾辞のみ true', () => {
		expect(isJpyPair('btc_jpy')).toBe(true);
		expect(isJpyPair('eth_jpy')).toBe(true);
		expect(isJpyPair('btc_usdt')).toBe(false);
	});

	it('JPY ペアは整数（四捨五入）に丸める — 円未満は無意味', () => {
		expect(roundPrice(5_000_050.5, true)).toBe(5_000_051);
		expect(roundPrice(5_000_050.4, true)).toBe(5_000_050);
		expect(roundPrice(5_000_050, true)).toBe(5_000_050);
	});

	it('非 JPY ペアは小数2桁に丸める', () => {
		expect(roundPrice(123.456, false)).toBe(123.46);
		expect(roundPrice(123.4, false)).toBe(123.4);
	});
});

describe('mid 丸め規約 — ツール間整合（同一板 → 同一 mid）', () => {
	// 偶数 spread（mid=整数）/ 奇数 spread（mid に .5 が出る）の両方を固定する。
	// 奇数ケースは再現手順そのもの（bestAsk=5000101 / bestBid=5000000 → mid=5000050.5）。
	const cases = [
		{ label: '偶数 spread (mid=整数)', bestAsk: '5000100', bestBid: '5000000', expectedMid: 5_000_050 },
		{ label: '奇数 spread (mid=.5 → 丸め)', bestAsk: '5000101', bestBid: '5000000', expectedMid: 5_000_051 },
	];

	it.each(cases)('JPY ペア: $label → 全経路 mid=$expectedMid で一致', async ({ bestAsk, bestBid, expectedMid }) => {
		const asks: [string, string][] = [
			[bestAsk, '0.2'],
			['5000200', '0.4'],
		];
		const bids: [string, string][] = [
			[bestBid, '0.3'],
			['4999900', '0.5'],
		];
		const midText = `${expectedMid.toLocaleString('ja-JP')}円`;

		mockDepth(asks, bids);

		// 1. get_orderbook summary（normalized.mid）
		const summary = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		assertOk(summary);
		expect(summary.data.normalized.mid).toBe(expectedMid);

		// 2. get_orderbook statistics（basic.currentPrice = mid）
		const stats = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics' });
		assertOk(stats);
		expect(stats.data.basic.currentPrice).toBe(expectedMid);

		// 3. get_orderbook pressure（bands[].baseMid）
		const pressure = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure' });
		assertOk(pressure);
		expect(pressure.data.bands[0].baseMid).toBe(expectedMid);

		// 4. get_orderbook raw（mid はテキスト表示のみ）
		const raw = await getOrderbook({ pair: 'btc_jpy', mode: 'raw' });
		assertOk(raw);
		expect(raw.summary).toContain(`中値: ${midText}`);

		// 5. prepare_depth_data（data.mid）
		const pdd = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(pdd);
		expect(pdd.data.mid).toBe(expectedMid);

		// 6. lib/get-depth（mid はテキスト表示のみ）
		const depth = await getDepth('btc_jpy');
		assertOk(depth);
		expect(depth.summary).toContain(`中値: ${midText}`);
	});

	it('奇数 spread: 構造化 mid（summary / statistics / pressure / prepare_depth_data）が相互に一致', async () => {
		// 再現手順の固定板。経路差ゼロ（Set サイズ=1）を保証する。
		const asks: [string, string][] = [
			['5000101', '0.2'],
			['5000200', '0.4'],
		];
		const bids: [string, string][] = [
			['5000000', '0.3'],
			['4999900', '0.5'],
		];
		mockDepth(asks, bids);

		const summary = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		const stats = await getOrderbook({ pair: 'btc_jpy', mode: 'statistics' });
		const pressure = await getOrderbook({ pair: 'btc_jpy', mode: 'pressure' });
		const pdd = await prepareDepthData({ pair: 'btc_jpy' });
		assertOk(summary);
		assertOk(stats);
		assertOk(pressure);
		assertOk(pdd);

		const mids = [
			summary.data.normalized.mid,
			stats.data.basic.currentPrice,
			pressure.data.bands[0].baseMid,
			pdd.data.mid,
		];
		// 全経路が単一値（以前は summary=5000050.5 / prepare_depth_data=5000051 と乖離していた）。
		expect(new Set(mids).size).toBe(1);
		expect(mids[0]).toBe(5_000_051);
	});

	it('API 異常系（upstream success:0）: get_orderbook / prepare_depth_data / get-depth は fail を返す', async () => {
		// 同一の異常レスポンスを共有経路に流し、全経路が ok:false（upstream 分類）で揃うことを固定する。
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			asMockResult<Response>({
				ok: true,
				status: 200,
				statusText: 'OK',
				headers: new Headers(),
				json: async () => ({ success: 0, data: { code: 20001 } }),
			}),
		);

		const ob = await getOrderbook({ pair: 'btc_jpy', mode: 'summary' });
		expect(ob.ok).toBe(false);
		expect((ob.meta as { errorType?: string }).errorType).toBe('upstream');

		const pdd = await prepareDepthData({ pair: 'btc_jpy' });
		expect(pdd.ok).toBe(false);

		const depth = await getDepth('btc_jpy');
		expect(depth.ok).toBe(false);
	});
});
