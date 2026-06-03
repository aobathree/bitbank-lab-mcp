/**
 * 見積り側の取引手数料（カテゴリ A: 取引手数料 / B: 信用 手数料）の単一ソース。
 *
 * bitbank の手数料は 3 カテゴリに分かれる（詳細: .claude/rules/fees.md）:
 *   A: 取引手数料 maker/taker … 見積りは GET /v1/spot/pairs の *_fee_rate_quote
 *   B: 信用 手数料/利息       … 見積りは pairs の margin_*_fee_rate_quote
 *   C: 入出金/出金手数料       … API 値パススルー（このモジュールでは扱わない）
 *
 * 実績側（portfolio/calc.ts, get_my_trade_history 等）は trade_history の実額を使う。
 * 本モジュールは **見積り（estimate）専用**で、A/B の手数料率解決を一元化する。
 *
 * 重要な不変条件:
 *   - 解決は必ず `??`（null 合体）で行う。`||` は禁止（campaign の 0 を fallback に化けさせる）。
 *   - クランプ禁止（`Math.max(0, …)` 厳禁）。負の maker リベートはそのまま返す。
 */

import { toNum } from './conversions.js';
import type { PairSpec } from './pairs.js';

/** ペア仕様が引けないときの公称 taker 手数料率（bitbank 現物 taker = 0.12%）。 */
export const DEFAULT_TAKER_FALLBACK = 0.0012;

export type FeeRole = 'maker' | 'taker';

/** 注文タイプ（preview_order / pairs と同じ語彙）。 */
export type OrderType = 'limit' | 'market' | 'stop' | 'stop_limit';

/**
 * 手数料率を解決する共通ロジック。
 *
 * `override ?? toNum(raw) ?? DEFAULT_TAKER_FALLBACK`
 *
 * - `override` が 0 / 負値でも `??` なのでそのまま採用される。
 * - `toNum` は 0 / 負値を保持し、欠損のみ null を返す（`lib/conversions.ts`）。
 * - クランプしないので負の maker リベートが温存される。
 */
function resolveRate(raw: unknown, override?: number): number {
	return override ?? toNum(raw) ?? DEFAULT_TAKER_FALLBACK;
}

/**
 * 現物（spot）の取引手数料率を解決する（カテゴリ A）。
 *
 * @param spec     /spot/pairs のペア仕様。undefined ならフォールバックに落ちる。
 * @param role     maker / taker
 * @param override 明示指定があれば最優先（0 / 負値も尊重）。
 */
export function resolveFeeRate(spec: PairSpec | undefined, role: FeeRole, override?: number): number {
	const raw = spec == null ? undefined : role === 'maker' ? spec.maker_fee_rate_quote : spec.taker_fee_rate_quote;
	return resolveRate(raw, override);
}

/**
 * 注文タイプと post_only から maker / taker を判定する。
 *
 * - `postOnly === true` → 必ず maker（板を跨げず拒否されるため）。
 * - `limit` / `stop_limit` → maker（指値は板に乗る想定）。
 * - それ以外（`market` / `stop`）→ taker。
 */
export function feeRole(type: OrderType, postOnly?: boolean): FeeRole {
	if (postOnly === true) return 'maker';
	if (type === 'limit' || type === 'stop_limit') return 'maker';
	return 'taker';
}

/** 信用建ての open / close を side × positionSide から判定する。 */
function isMarginOpen(side: 'buy' | 'sell', positionSide: 'long' | 'short'): boolean {
	return (side === 'buy' && positionSide === 'long') || (side === 'sell' && positionSide === 'short');
}

/** 信用 手数料率フィールド名を返す（カテゴリ B）。 */
function marginFeeField(open: boolean, role: FeeRole): keyof PairSpec {
	if (open) {
		return role === 'maker' ? 'margin_open_maker_fee_rate_quote' : 'margin_open_taker_fee_rate_quote';
	}
	return role === 'maker' ? 'margin_close_maker_fee_rate_quote' : 'margin_close_taker_fee_rate_quote';
}

/** estimateOrderFee の入力。amount / price は API 由来の文字列も number も受ける。 */
export interface OrderFeeInput {
	type: OrderType;
	side: 'buy' | 'sell';
	price?: string | number | null;
	amount: string | number;
	/** post_only 指定（true なら maker 確定）。 */
	postOnly?: boolean;
	/** 信用建ての建玉方向。指定があれば margin 手数料率を解決する。 */
	positionSide?: 'long' | 'short';
}

/** estimateOrderFee の戻り値。 */
export interface OrderFeeEstimate {
	/** 解決した role。 */
	role: FeeRole;
	/** 解決した手数料率（負のリベートもありうる）。 */
	rate: number;
	/** 見積り手数料（quote 建て）。約定価格依存で省略する場合は undefined。 */
	estimatedFeeQuote?: number;
	/** 見積りコスト（buy=notional+fee / sell=notional-fee）。省略時は undefined。 */
	estimatedCostQuote?: number;
	/** 見積りの前提を説明する注記。 */
	note: string;
}

/** JPY ペアか（quote_asset が jpy）。spec 不明時は false。 */
function isJpyQuote(spec: PairSpec | undefined): boolean {
	return spec?.quote_asset?.toLowerCase() === 'jpy';
}

/**
 * 注文 1 件の見積り手数料を算出する（カテゴリ A / B）。
 *
 * - `limit` / `stop_limit` かつ price 既知 → notional・fee・cost を算出。
 *   JPY ペアは fee を整数丸め。負 fee（リベート）はコストを自然に減らす。
 * - `market` / `stop` → 約定価格依存のため JPY 見積りは省略し note で明示。
 * - `spec === undefined` → フォールバック率（公称 taker）で概算し note に明示。
 * - `positionSide` 指定（信用）→ margin_{open|close}_{role}_fee_rate_quote を解決対象にする。
 */
export function estimateOrderFee(spec: PairSpec | undefined, order: OrderFeeInput): OrderFeeEstimate {
	const role = feeRole(order.type, order.postOnly);

	let rate: number;
	if (order.positionSide != null) {
		const open = isMarginOpen(order.side, order.positionSide);
		const raw = spec == null ? undefined : spec[marginFeeField(open, role)];
		rate = resolveRate(raw);
	} else {
		rate = resolveFeeRate(spec, role);
	}

	const priceNum = toNum(order.price);
	const amountNum = toNum(order.amount);
	const isLimitFamily = order.type === 'limit' || order.type === 'stop_limit';

	let estimatedFeeQuote: number | undefined;
	let estimatedCostQuote: number | undefined;
	let note: string;

	if (isLimitFamily && priceNum != null && amountNum != null) {
		const notional = priceNum * amountNum;
		let fee = notional * rate;
		if (isJpyQuote(spec)) fee = Math.round(fee);
		estimatedFeeQuote = fee;
		// 負 fee（リベート）でも自然にコストが増減する。
		estimatedCostQuote = order.side === 'buy' ? notional + fee : notional - fee;
		note = order.postOnly ? 'maker 確定' : 'maker 想定（板を跨ぐと taker）';
	} else if (order.type === 'market' || order.type === 'stop') {
		note = '成行/逆指値: 約定価格依存で JPY 見積りは省略';
	} else {
		// limit 系だが price 未指定 → notional 算出不可。
		note = '指値だが price 未指定のため JPY 見積りは省略';
	}

	if (spec === undefined) {
		note = `${note}（spec 不明のため公称 taker で概算）`;
	}

	return { role, rate, estimatedFeeQuote, estimatedCostQuote, note };
}
