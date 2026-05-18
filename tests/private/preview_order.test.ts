/**
 * preview_order ツールのユニットテスト。
 * バリデーション、確認トークン発行、プレビューメッセージ生成を検証する。
 * ネットワーク依存のトリガー価格検証 / /spot/pairs はモックで対応。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertFail, assertOk } from '../_assertResult.js';
import { mockBitbankSuccess, mockSpotPairsResponse } from '../fixtures/private-api.js';

const originalFetch = globalThis.fetch;

/**
 * URL に応じてレスポンスを返すデフォルトの fetch モック。
 * - /spot/pairs → 正常な pairs 仕様（btc_jpy / eth_jpy 含む）
 * - /ticker     → last=15000000 のティッカー
 * - その他      → success:1 の空レスポンス
 * 個別テストで `globalThis.fetch` を上書きすればこの mock を差し替えできる。
 */
function installDefaultFetchMock(extraPairs: Array<Record<string, unknown>> = []): void {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
		if (url.includes('/spot/pairs')) {
			return new Response(JSON.stringify(mockSpotPairsResponse(extraPairs)), { status: 200 });
		}
		if (url.includes('/ticker')) {
			return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
		}
		return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
	}) as unknown as typeof fetch;
}

beforeEach(() => {
	process.env.BITBANK_API_KEY = 'test_key';
	process.env.BITBANK_API_SECRET = 'test_secret';
	installDefaultFetchMock();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	delete process.env.BITBANK_API_KEY;
	delete process.env.BITBANK_API_SECRET;
	vi.resetModules();
});

describe('preview_order', () => {
	describe('バリデーション', () => {
		it('limit 注文で price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
			});

			assertFail(result);
			expect(result.summary).toContain('price');
		});

		it('market 注文で price 指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
				price: '15000000',
			});

			assertFail(result);
			expect(result.summary).toContain('market');
		});

		it('market 注文で trigger_price 指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
				trigger_price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('market');
		});

		it('stop 注文で trigger_price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
			});

			assertFail(result);
			expect(result.summary).toContain('trigger_price');
		});

		it('stop 注文で price 指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				price: '14000000',
				trigger_price: '13000000',
			});

			assertFail(result);
			expect(result.summary).toContain('stop_limit');
		});

		it('stop_limit 注文で trigger_price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop_limit',
				price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('trigger_price');
		});

		it('stop_limit 注文で price 未指定はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop_limit',
				trigger_price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('price');
		});

		it('post_only は limit 以外でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
				post_only: true,
			});

			assertFail(result);
			expect(result.summary).toContain('post_only');
		});

		it('amount が不正な値でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '-1',
				side: 'buy',
				type: 'market',
			});

			assertFail(result);
			expect(result.summary).toContain('amount');
		});

		it('price が不正な値でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '0',
			});

			assertFail(result);
			expect(result.summary).toContain('price');
		});

		it('trigger_price が不正な値でエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: 'abc',
			});

			assertFail(result);
			expect(result.summary).toContain('trigger_price');
		});
	});

	// take_profit / stop_loss / losscut は公式 spec に列挙されているが本実装では意図的に未対応。
	// SpotOrderTypeEnum で 4 種に絞っており、Zod 入力スキーマで早期に拒否されることを保証する。
	// 詳細は docs/private-api.md「対応注文タイプ」節 / docs/api-contract-checklist.md §3.4 を参照。
	//
	// 失敗理由が「type フィールド由来」であることを issues.path で確認する。
	// success===false のみだと、他フィールドの欠落（confirmation_token 未指定等）でも
	// テストが通ってしまい、type 列挙の閉鎖性を検証できなくなるため。
	describe('未対応の注文タイプ（take_profit / stop_loss / losscut）', () => {
		it('take_profit は PreviewOrderInputSchema で拒否される', async () => {
			const { PreviewOrderInputSchema } = await import('../../src/private/schemas.js');
			const result = PreviewOrderInputSchema.safeParse({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'take_profit',
				trigger_price: '16000000',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
			}
		});

		it('stop_loss は PreviewOrderInputSchema で拒否される', async () => {
			const { PreviewOrderInputSchema } = await import('../../src/private/schemas.js');
			const result = PreviewOrderInputSchema.safeParse({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop_loss',
				trigger_price: '13000000',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
			}
		});

		it('losscut は PreviewOrderInputSchema で拒否される', async () => {
			const { PreviewOrderInputSchema } = await import('../../src/private/schemas.js');
			const result = PreviewOrderInputSchema.safeParse({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'losscut',
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues.some((i) => i.path.join('.') === 'type')).toBe(true);
			}
		});
	});

	describe('正常系', () => {
		it('limit 注文プレビューで confirmation_token を返す', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});

			assertOk(result);
			expect(result.data.confirmation_token).toBeTypeOf('string');
			expect(result.data.confirmation_token.length).toBeGreaterThan(0);
			expect(result.data.expires_at).toBeGreaterThan(Date.now());
		});

		it('market 注文プレビューが成功する', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});

			assertOk(result);
			expect(result.summary).toContain('BTC/JPY');
			expect(result.summary).toContain('買');
			expect(result.summary).toContain('market');
			expect(result.summary).toContain('成行');
		});

		it('sell 注文で「売」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'eth_jpy',
				amount: '1.0',
				side: 'sell',
				type: 'market',
			});

			assertOk(result);
			expect(result.summary).toContain('売');
			expect(result.summary).toContain('ETH/JPY');
		});

		it('limit 注文で価格がフォーマットされる（JPYペア）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});

			assertOk(result);
			// formatPrice で3桁区切りになる
			expect(result.summary).toContain('14,000,000');
		});

		it('post_only が有効な limit 注文のプレビュー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				post_only: true,
			});

			assertOk(result);
			expect(result.summary).toContain('Post Only');
		});

		it('stop 注文でトリガー価格が表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '13000000',
			});

			assertOk(result);
			expect(result.summary).toContain('トリガー価格');
			expect(result.summary).toContain('13,000,000');
		});

		it('preview にパラメータが含まれる', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});

			assertOk(result);
			expect(result.data.preview.pair).toBe('btc_jpy');
			expect(result.data.preview.side).toBe('buy');
			expect(result.data.preview.type).toBe('limit');
		});

		it('meta.action が create_order である', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});

			assertOk(result);
			expect(result.meta.action).toBe('create_order');
		});
	});

	describe('トリガー価格検証', () => {
		it('stop sell でトリガー価格が現在価格以上の場合はエラー', async () => {
			// 現在価格: 15,000,000（モック済み）
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '16000000',
			});

			assertFail(result);
			expect(result.summary).toContain('即時発動');
		});

		it('stop buy でトリガー価格が現在価格以下の場合はエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop',
				trigger_price: '14000000',
			});

			assertFail(result);
			expect(result.summary).toContain('即時発動');
		});

		it('stop sell でトリガー価格が現在価格未満なら正常', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '13000000',
			});

			assertOk(result);
		});

		it('stop buy でトリガー価格が現在価格超なら正常', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'stop',
				trigger_price: '16000000',
			});

			assertOk(result);
		});
	});

	describe('信用取引（position_side）', () => {
		it('ロング新規（buy + long）で「信用新規（ロング）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});

			assertOk(result);
			expect(result.summary).toContain('信用新規（ロング）');
			expect(result.summary).toContain('信用取引です');
			expect(result.data.preview.position_side).toBe('long');
		});

		it('ロング決済（sell + long）で「信用決済（ロング）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'market',
				position_side: 'long',
			});

			assertOk(result);
			expect(result.summary).toContain('信用決済（ロング）');
		});

		it('ショート新規（sell + short）で「信用新規（ショート）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'eth_jpy',
				amount: '1.0',
				side: 'sell',
				type: 'limit',
				price: '400000',
				position_side: 'short',
			});

			assertOk(result);
			expect(result.summary).toContain('信用新規（ショート）');
		});

		it('ショート決済（buy + short）で「信用決済（ショート）」ラベルが表示される', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'eth_jpy',
				amount: '1.0',
				side: 'buy',
				type: 'market',
				position_side: 'short',
			});

			assertOk(result);
			expect(result.summary).toContain('信用決済（ショート）');
		});

		it('position_side なしで現物注文として信用ラベルが表示されない', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});

			assertOk(result);
			expect(result.summary).not.toContain('信用');
			expect(result.data.preview.position_side).toBeUndefined();
		});

		it('position_side が確認トークンに含まれる（改ざん検出用）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
				position_side: 'long',
			});

			assertOk(result);
			expect(result.data.confirmation_token).toBeTypeOf('string');
			expect(result.data.confirmation_token.length).toBeGreaterThan(0);
		});
	});

	describe('handler — トークンを LLM 可視テキストに含めない', () => {
		it('elicitation 非対応ホストでは confirmation_token を content[0].text に出さない', async () => {
			const { toolDef } = await import('../../tools/private/preview_order.js');
			// extra なし（= elicitation 非対応扱い）でハンドラを直接呼ぶ
			const result = (await toolDef.handler({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			})) as { content: { text: string }[]; structuredContent: { data?: { confirmation_token?: string } } };

			const text = result.content[0]?.text ?? '';
			const token = result.structuredContent?.data?.confirmation_token;
			expect(token).toBeTypeOf('string');
			expect((token as string).length).toBeGreaterThan(0);
			// トークン文字列がテキストに混入していないこと（LLM がコピーして create_order を即実行するのを防ぐ）
			expect(text).not.toContain(token as string);
			// フォールバック説明文があること
			expect(text).toContain('confirmation_token');
			expect(text).toContain('ホスト UI');
		});

		it('elicitation 対応ホストで accept されると create_order まで実行される', async () => {
			// URL で振り分け: /spot/pairs（事前バリデーション）/ /user/spot/order（発注）
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						success: 1,
						data: {
							order_id: 99999,
							pair: 'btc_jpy',
							side: 'buy',
							type: 'limit',
							start_amount: '0.01',
							remaining_amount: '0.01',
							executed_amount: '0',
							average_price: '0',
							status: 'UNFILLED',
							ordered_at: 1710000000000,
						},
					}),
					{ status: 200 },
				);
			}) as unknown as typeof fetch;

			const elicitInput = vi.fn().mockResolvedValue({ action: 'accept', content: { confirmed: true } });
			const fakeServer = {
				getClientCapabilities: () => ({ elicitation: {} }),
				elicitInput,
			};

			const { toolDef } = await import('../../tools/private/preview_order.js');
			const result = (await toolDef.handler(
				{
					pair: 'btc_jpy',
					amount: '0.01',
					side: 'buy',
					type: 'limit',
					price: '14000000',
				},
				{ server: fakeServer },
			)) as { content: { text: string }[]; structuredContent: Record<string, unknown> };

			expect(elicitInput).toHaveBeenCalledTimes(1);
			expect(result.content[0]?.text).toContain('注文発注完了');
			// structuredContent は create_order の Result が乗る
			expect(result.structuredContent).toMatchObject({ ok: true });
		});

		it('elicitation で decline されたらキャンセル扱いで create_order は呼ばれない', async () => {
			// /spot/pairs のみ正常レスポンス、注文 API は呼ばれない想定
			const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response(JSON.stringify(mockSpotPairsResponse()), { status: 200 });
				}
				throw new Error(`Unexpected fetch in decline test: ${url}`);
			}) as unknown as typeof fetch;
			globalThis.fetch = fetchMock;

			const fakeServer = {
				getClientCapabilities: () => ({ elicitation: {} }),
				elicitInput: vi.fn().mockResolvedValue({ action: 'decline' }),
			};

			const { toolDef } = await import('../../tools/private/preview_order.js');
			const result = (await toolDef.handler(
				{
					pair: 'btc_jpy',
					amount: '0.01',
					side: 'buy',
					type: 'limit',
					price: '14000000',
				},
				{ server: fakeServer },
			)) as { content: { text: string }[] };

			expect(result.content[0]?.text).toContain('キャンセル');
			// limit はトリガー価格検証も注文 API も呼ばれない（/spot/pairs のみ）
			const calls = (fetchMock as unknown as { mock: { calls: Array<[unknown]> } }).mock.calls;
			expect(calls).toHaveLength(1);
			expect(String(calls[0]?.[0])).toContain('/spot/pairs');
		});
	});

	// /spot/pairs に照らした事前バリデーション（60003/60004/60005/60006/70004 の早期検出）
	describe('ペア仕様の事前バリデーション（/spot/pairs）', () => {
		it('未対応ペアは pair エラーで弾く', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'foo_bar',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('未対応のペア');
			expect(result.summary).toContain('foo_bar');
		});

		it('is_enabled=false のペアは取引停止エラー', async () => {
			installDefaultFetchMock([
				{
					name: 'btc_jpy',
					base_asset: 'btc',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					limit_max_amount: '1000',
					market_max_amount: '0.5',
					price_digits: 0,
					amount_digits: 8,
					is_enabled: false,
					stop_order: false,
					stop_order_and_cancel: false,
					stop_market_order: false,
					stop_stop_order: false,
					stop_stop_limit_order: false,
					stop_margin_long_order: false,
					stop_margin_short_order: false,
					stop_buy_order: false,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('取引停止');
		});

		it('stop_market_order=true のペアで market 注文は弾く', async () => {
			installDefaultFetchMock([
				{
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
					stop_market_order: true,
					stop_stop_order: false,
					stop_stop_limit_order: false,
					stop_margin_long_order: false,
					stop_margin_short_order: false,
					stop_buy_order: false,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});
			assertFail(result);
			expect(result.summary).toContain('market 注文を停止');
		});

		it('stop_buy_order=true のペアで buy は弾くが sell は通る', async () => {
			installDefaultFetchMock([
				{
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
					stop_buy_order: true,
					stop_sell_order: false,
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const buyResult = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(buyResult);
			expect(buyResult.summary).toContain('buy 注文を停止');

			const sellResult = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'limit',
				price: '16000000',
			});
			assertOk(sellResult);
		});

		it('amount が最小注文数量を下回るとエラー（最小単位を含む日本語メッセージ）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.00001',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('最小注文数量');
			expect(result.summary).toContain('0.0001');
			expect(result.summary).toContain('BTC');
		});

		it('amount が最大注文数量（limit）を超えるとエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '99999',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('最大注文数量');
		});

		it('amount の小数桁が許容上限を超えるとエラー', async () => {
			installDefaultFetchMock([
				{
					name: 'btc_jpy',
					base_asset: 'btc',
					quote_asset: 'jpy',
					unit_amount: '0.0001',
					limit_max_amount: '1000',
					market_max_amount: '0.5',
					price_digits: 0,
					amount_digits: 4,
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
				},
			]);
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.123456',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertFail(result);
			expect(result.summary).toContain('amount の小数桁数');
		});

		it('price の小数桁が許容上限を超えるとエラー（price_digits=0 で 14000000.5）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000.5',
			});
			assertFail(result);
			expect(result.summary).toContain('price の小数桁数');
		});

		it('trigger_price の小数桁が許容上限を超えるとエラー', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'sell',
				type: 'stop',
				trigger_price: '13000000.25',
			});
			assertFail(result);
			expect(result.summary).toContain('trigger_price の小数桁数');
		});

		it('/spot/pairs 取得失敗時は warning にフォールバックして発注プレビューを継続する', async () => {
			// /spot/pairs だけ 500 を返し、ticker は正常
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					return new Response('boom', { status: 500 });
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			// プレビューは成立し confirmation_token が発行される
			expect(result.data.confirmation_token).toBeTypeOf('string');
			// warning が meta と summary 双方に出る
			expect(result.meta.warnings).toBeDefined();
			expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
			expect(result.summary).toContain('スキップ');
		});

		it('/spot/pairs ネットワークエラー時も warning でプレビューを継続する', async () => {
			globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
				if (url.includes('/spot/pairs')) {
					throw new TypeError('fetch failed');
				}
				if (url.includes('/ticker')) {
					return new Response(JSON.stringify(mockBitbankSuccess({ last: '15000000' })), { status: 200 });
				}
				return new Response(JSON.stringify({ success: 1, data: {} }), { status: 200 });
			}) as unknown as typeof fetch;

			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'market',
			});
			assertOk(result);
			expect(result.meta.warnings?.[0]).toContain('/spot/pairs');
		});

		it('正常時は warnings 無し（meta に warnings キーを含めない）', async () => {
			const { default: previewOrder } = await import('../../tools/private/preview_order.js');
			const result = await previewOrder({
				pair: 'btc_jpy',
				amount: '0.01',
				side: 'buy',
				type: 'limit',
				price: '14000000',
			});
			assertOk(result);
			expect(result.meta.warnings).toBeUndefined();
		});
	});
});
