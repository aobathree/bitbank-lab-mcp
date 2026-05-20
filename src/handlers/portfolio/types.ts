/**
 * portfolio/types — analyzeMyPortfolioHandler で使用する型定義。
 */

import type { z } from 'zod';
import { getErrorMessage } from '../../../lib/error.js';
import type { BitbankPrivateClient } from '../../private/client.js';
import type { GetMarginPositionsDataSchema, GetMarginStatusDataSchema } from '../../private/schemas.js';

// ── Private API レスポンス型 ──

export interface RawAsset {
	asset: string;
	free_amount: string;
	onhand_amount: string;
	locked_amount: string;
	amount_precision: number;
	withdrawal_fee: { min: string; max: string } | string;
	stop_deposit: boolean;
	stop_withdrawal: boolean;
}

export interface RawTrade {
	trade_id: number;
	pair: string;
	order_id: number;
	side: string;
	/** 信用約定が混入した場合のみ存在。現物 API レスポンスでは通常未定義 */
	position_side?: string;
	type: string;
	amount: string;
	price: string;
	maker_taker: string;
	fee_amount_base: string;
	fee_amount_quote: string;
	fee_occurred_amount_quote?: string;
	executed_at: number;
}

/** bitbank /v1/user/spot/trade_history (type=margin) のレスポンス型 */
export interface RawMarginTrade {
	trade_id: number;
	pair: string;
	order_id: number;
	side: string;
	position_side?: string;
	type: string;
	amount: string;
	price: string;
	maker_taker: string;
	fee_amount_base: string;
	fee_amount_quote: string;
	fee_occurred_amount_quote?: string;
	/** 決済時のみ。利益で正、損失で負（bitbank API 標準） */
	profit_loss?: string;
	/** 決済時のみ。コスト = 正の値で支払利息を表す */
	interest?: string;
	executed_at: number;
}

export interface RawDeposit {
	uuid: string;
	asset: string;
	amount: string;
	status: string;
	found_at: number;
	confirmed_at: number;
}

export interface RawWithdrawal {
	uuid: string;
	asset: string;
	amount: string;
	fee?: string;
	status: string;
	requested_at: number;
}

export interface DepositWithdrawalData {
	deposits: RawDeposit[];
	withdrawals: RawWithdrawal[];
	/** 一部の API リクエストが失敗した場合の警告メッセージ */
	warnings: string[];
	/** 全リクエストが失敗した場合 true */
	allFailed: boolean;
	/** 全履歴を取得できたか（false = API 件数上限に達した） */
	isComplete: boolean;
}

/** 個別 API リクエストの結果をラップ */
export type FetchResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ── 損益計算 ──

export interface PnlResult {
	avg_buy_price: number | undefined;
	cost_basis: number | undefined;
	realized_pnl: number;
	trade_count: number;
}

export interface PeriodRealizedPnl {
	/** 期間内の合計実現損益（JPY） */
	realized_pnl: number;
	/** 期間内の売却約定件数 */
	sell_count: number;
	/** 期間の開始日時（ISO8601 JST） */
	period_start: string;
	/** 期間の終了日時（ISO8601 JST） = 取得時点 */
	period_end: string;
}

// ── 口座全体 PnL（現物 + 信用決済損益 - 利息） ──

export interface AccountPnl {
	/** 現物の実現損益（JPY） */
	spot_realized_pnl: number;
	/** 信用の決済済み損益合計（JPY、グロス: 利息・手数料控除前） */
	margin_realized_pnl: number;
	/** 信用の支払利息合計（JPY、コスト = 正値） */
	margin_interest: number;
	/** 信用の発生手数料合計（JPY、fee_occurred_amount_quote の合算。コスト = 正値） */
	margin_fee: number;
	/** 口座全体 PnL = spot_realized + margin_realized - margin_interest - margin_fee */
	total: number;
}

export interface PeriodAccountPnl extends AccountPnl {
	period_start: string;
	period_end: string;
}

// ── 入出金サマリー ──

export interface DepositWithdrawalSummary {
	total_jpy_deposited: number;
	total_jpy_withdrawn: number;
	net_jpy_invested: number;
	crypto_deposit_count: number;
	crypto_deposit_estimated_jpy: number | undefined;
	crypto_withdrawal_count: number;
	account_return_pct: number | undefined;
	account_return_jpy: number | undefined;
	is_complete: boolean;
	analysis_basis: 'deposit_withdrawal' | 'trade_only';
}

export interface PeriodDWSummary {
	jpy_deposited: number;
	jpy_withdrawn: number;
	net_jpy: number;
	crypto_deposit_count: number;
	crypto_deposit_estimated_jpy: number | undefined;
	crypto_withdrawal_count: number;
	crypto_withdrawal_estimated_jpy: number | undefined;
	period_start: string;
	period_end: string;
}

// ── パフォーマンス ──

export interface PeriodPerformance {
	start_value_jpy: number;
	current_value_jpy: number;
	change_jpy: number;
	change_pct: number | undefined;
	net_flow_jpy: number;
	withdrawal_fee_jpy: number;
	adjusted_change_jpy: number;
	adjusted_change_pct: number | undefined;
	period_start: string;
	period_end: string;
	note: string;
}

export interface CandlePriceData {
	boundaryPrices: Map<string, { yearStart?: number; monthStart?: number; dayStart?: number }>;
	dailyPrices: Map<string, Map<number, number>>;
}

export interface EquityPoint {
	timestamp: string;
	value_jpy: number;
}

export interface PeriodNetFlowResult {
	/** 純入出金額（元本移動のみ。出金手数料は含まない） */
	net_flow_jpy: number;
	/** 期間中の出金手数料合計（JPY）。コストとして performance に残る */
	withdrawal_fee_jpy: number;
}

// ── 信用口座状態・建玉 ──

export interface MarginStatusData extends z.infer<typeof GetMarginStatusDataSchema> {}
export interface MarginPositionsData extends z.infer<typeof GetMarginPositionsDataSchema> {}

/**
 * 信用口座の状態と建玉サマリ。
 *
 * `get_margin_status` と `get_margin_positions` の結果を集約し、
 * 取得成否を独立フラグで保持する。片方失敗・両方失敗のいずれでも上位は
 * 原因切り分けが可能（PR #2 で導入した marginFetchFailed と同じ思想）。
 */
export interface MarginAccountInfo {
	/** 取得成功時の信用口座状態。失敗・未提供時は undefined */
	status: MarginStatusData | undefined;
	/** get_margin_status の取得失敗フラグ */
	statusFetchFailed: boolean;
	/** 取得成功時の信用建玉一覧 */
	positions: MarginPositionsData | undefined;
	/** get_margin_positions の取得失敗フラグ */
	positionsFetchFailed: boolean;
}

// ── テクニカル ──

export interface TechnicalSummary {
	pair: string;
	trend?: string;
	rsi_14?: number;
	sma_deviation_pct?: number;
	signal?: string;
}

// ── API ヘルパー ──

export async function tryGet<T>(
	client: BitbankPrivateClient,
	path: string,
	params?: Record<string, string>,
): Promise<FetchResult<T>> {
	try {
		const data = await client.get<T>(path, params);
		return { ok: true, data };
	} catch (err) {
		return { ok: false, error: getErrorMessage(err) };
	}
}
