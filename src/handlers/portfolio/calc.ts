/**
 * portfolio/calc — 純粋な計算ロジック。
 *
 * 損益計算（移動平均法）、入出金サマリー、保有復元、
 * エクイティ時系列、期間ネットフロー、JST 期間境界を担当。
 * 全関数は I/O を行わない純粋関数。
 */

import { dayjs } from '../../../lib/datetime.js';
import type {
	DepositWithdrawalData,
	DepositWithdrawalSummary,
	EquityPoint,
	PeriodDWSummary,
	PeriodNetFlowResult,
	PeriodRealizedPnl,
	PnlResult,
	RawTrade,
	RawWithdrawal,
} from './types.js';

// ── 損益計算エンジン ──

// bitbank の現物手数料体系:
//   買い: 手数料は base 通貨で発生（feeBase > 0, feeQuote = 0）
//   売り: 手数料は quote 通貨で発生（feeQuote > 0, feeBase = 0）
// 両方が同時に非ゼロになるケースは API 仕様上想定されないが、
// 防御的にどちらも参照しても算術的に正しくなるロジックを採用する。

/**
 * 約定履歴と暗号資産出庫から通貨ごとの平均取得単価と実現損益を算出する。
 * 移動平均法（総平均法）を採用。両 side の手数料（fee_amount_base / fee_amount_quote）を考慮。
 *
 * 暗号資産出庫（crypto withdrawal）は「売却」ではなく原価の按分減少として扱う:
 *   - holdingQty と holdingCost を平均単価ベースで減らす
 *   - realized_pnl には計上しない
 * これにより、出庫後に残った少量保有の cost_basis が適正化され、
 * 評価損益が過大マイナスになる問題を防ぐ。
 */
export function calcPnl(trades: RawTrade[], asset: string, withdrawals?: RawWithdrawal[]): PnlResult {
	// この通貨に関する約定を古い順にソート
	const pair = `${asset}_jpy`;
	const relevantTrades = trades.filter((t) => t.pair === pair).sort((a, b) => a.executed_at - b.executed_at);

	// この通貨に関する完了済み暗号資産出庫
	const relevantWithdrawals = (withdrawals ?? []).filter((w) => w.asset === asset && w.status === 'DONE');

	if (relevantTrades.length === 0 && relevantWithdrawals.length === 0) {
		return { avg_buy_price: undefined, cost_basis: undefined, realized_pnl: 0, trade_count: 0 };
	}

	// 約定と出庫を時系列順に統合して処理
	type TradeEvent = { type: 'trade'; ts: number; trade: RawTrade };
	type WithdrawalEvent = { type: 'withdrawal'; ts: number; amount: number };
	type Event = TradeEvent | WithdrawalEvent;

	const events: Event[] = [
		...relevantTrades.map((t): TradeEvent => ({ type: 'trade', ts: t.executed_at, trade: t })),
		...relevantWithdrawals.map(
			(w): WithdrawalEvent => ({
				type: 'withdrawal',
				ts: w.requested_at,
				amount: Number(w.amount) + (Number(w.fee) || 0), // 出庫量 + 出庫手数料 = 口座から減った総量
			}),
		),
	].sort((a, b) => a.ts - b.ts);

	let holdingQty = 0;
	let holdingCost = 0; // 保有分の取得原価合計（手数料込み）
	let realizedPnl = 0;

	for (const event of events) {
		if (event.type === 'trade') {
			const t = event.trade;
			const qty = Number(t.amount);
			const price = Number(t.price);
			if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

			// 決済通貨（JPY）建ての手数料 / 基軸通貨建ての手数料
			const feeQuote = Number(t.fee_amount_quote) || 0;
			const feeBase = Number(t.fee_amount_base) || 0;

			if (t.side === 'buy') {
				// 買い: JPY 出 = qty * price + feeQuote、base 入 = qty - feeBase
				holdingCost += qty * price + feeQuote;
				holdingQty += qty - feeBase;
			} else {
				// sell: 移動平均法で原価を按分
				if (holdingQty > 0) {
					const avgCost = holdingCost / holdingQty;
					// 保有量を超える売りの場合、原価は保有分のみ按分（超過分は原価ゼロ扱い）
					const coveredQty = Math.min(qty, holdingQty);
					const sellCost = coveredQty * avgCost;
					const sellRevenue = qty * price - feeQuote; // 売却収入から手数料を差し引く
					realizedPnl += sellRevenue - sellCost;
					holdingCost -= sellCost;
					holdingQty -= coveredQty;
					// 誤差修正: 数量がゼロ近くなったらコストもリセット
					if (holdingQty < 1e-12) {
						holdingQty = 0;
						holdingCost = 0;
					}
				} else {
					// 保有ゼロ状態での売り（空売り等）: 実現損益のみ計上
					realizedPnl += qty * price - feeQuote;
				}
			}
		} else {
			// Crypto withdrawal: 原価を按分減少。realized_pnl には計上しない
			const wdQty = event.amount;
			if (holdingQty > 0 && wdQty > 0) {
				const avgCost = holdingCost / holdingQty;
				const removedQty = Math.min(wdQty, holdingQty);
				holdingCost -= removedQty * avgCost;
				holdingQty -= removedQty;
				if (holdingQty < 1e-12) {
					holdingQty = 0;
					holdingCost = 0;
				}
			}
		}
	}

	const avgBuyPrice = holdingQty > 0 ? holdingCost / holdingQty : undefined;
	const costBasis = holdingQty > 0 ? holdingCost : undefined;

	return {
		avg_buy_price: avgBuyPrice,
		cost_basis: costBasis,
		realized_pnl: Math.round(realizedPnl),
		trade_count: relevantTrades.length,
	};
}

// ── 期間別実現損益（年初来 / 月初来） ──

/**
 * 指定期間内の実現損益を算出する。
 *
 * 移動平均法の avg_cost は全履歴から計算し（期間開始前の買いも含む）、
 * 期間内の売り約定のみ実現損益として集計する。
 */
export function calcPeriodRealizedPnl(
	trades: RawTrade[],
	sinceMs: number,
	periodStart: string,
	periodEnd: string,
): PeriodRealizedPnl {
	// 全通貨の約定を古い順にソート
	const sorted = [...trades].sort((a, b) => a.executed_at - b.executed_at);

	// 通貨ごとに移動平均法で avg_cost を追跡し、期間内の sell のみ realized に計上
	const holdings = new Map<string, { qty: number; cost: number }>();
	let periodRealized = 0;
	let periodSellCount = 0;

	for (const t of sorted) {
		const asset = t.pair.replace('_jpy', '');
		if (asset === 'jpy') continue;

		const qty = Number(t.amount);
		const price = Number(t.price);
		if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

		const feeQuote = Number(t.fee_amount_quote) || 0;
		const feeBase = Number(t.fee_amount_base) || 0;
		const h = holdings.get(asset) ?? { qty: 0, cost: 0 };

		if (t.side === 'buy') {
			// 買い: JPY 出 = qty * price + feeQuote、base 入 = qty - feeBase
			h.cost += qty * price + feeQuote;
			h.qty += qty - feeBase;
		} else {
			// sell
			let sellRealized = 0;
			if (h.qty > 0) {
				const avgCost = h.cost / h.qty;
				// 保有量を超える売りの場合、原価は保有分のみ按分
				const coveredQty = Math.min(qty, h.qty);
				const sellCost = coveredQty * avgCost;
				const sellRevenue = qty * price - feeQuote;
				sellRealized = sellRevenue - sellCost;
				h.cost -= sellCost;
				h.qty -= coveredQty;
				if (h.qty < 1e-12) {
					h.qty = 0;
					h.cost = 0;
				}
			} else {
				sellRealized = qty * price - feeQuote;
			}

			// 期間内の売りのみ集計
			if (t.executed_at >= sinceMs) {
				periodRealized += sellRealized;
				periodSellCount++;
			}
		}

		holdings.set(asset, h);
	}

	return {
		realized_pnl: Math.round(periodRealized),
		sell_count: periodSellCount,
		period_start: periodStart,
		period_end: periodEnd,
	};
}

// ── 入出金サマリー ──

/**
 * 入出金データから口座全体のリターンを算出する。
 *
 * - JPY 入金: 投資元本（入金）
 * - JPY 出金: 投資元本の回収（出金）
 * - 暗号資産入庫: 現在の市場価格で仮評価し、投入額に加算（入庫時点の価格は取得不可）
 * - 暗号資産出庫: 損益計算からは除外（他所への送金であり売却ではない）
 * - 純投入額 = JPY入金合計 - JPY出金合計 + 暗号資産入庫の推定JPY評価額
 * - 口座全体リターン = (現在評価額 - 純投入額) / 純投入額
 */
export function calcDepositWithdrawalSummary(
	dw: DepositWithdrawalData,
	totalJpyValue: number,
	prices: Map<string, number>,
): DepositWithdrawalSummary {
	// DONE ステータスの入金のみ集計（FOUND / CONFIRMED は未完了）
	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE');
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE');

	// JPY 入出金
	const jpyDeposits = completedDeposits.filter((d) => d.asset === 'jpy');
	const jpyWithdrawals = completedWithdrawals.filter((w) => w.asset === 'jpy');
	const totalJpyDeposited = jpyDeposits.reduce((sum, d) => sum + Number(d.amount), 0);
	const totalJpyWithdrawn = jpyWithdrawals.reduce((sum, w) => sum + Number(w.amount), 0);

	// 暗号資産入出庫
	const cryptoDeposits = completedDeposits.filter((d) => d.asset !== 'jpy');
	const cryptoWithdrawals = completedWithdrawals.filter((w) => w.asset !== 'jpy');

	// 暗号資産入庫の推定 JPY 評価（現在の市場価格で仮評価）
	// 注意: 入庫「時点」の価格は取得不可のため、現在価格での仮評価
	let cryptoDepositEstimatedJpy = 0;
	let hasEstimate = false;
	for (const d of cryptoDeposits) {
		const price = prices.get(d.asset);
		const amount = Number(d.amount);
		if (price && Number.isFinite(amount) && amount > 0) {
			cryptoDepositEstimatedJpy += amount * price;
			hasEstimate = true;
		}
	}

	const netJpyInvested = totalJpyDeposited - totalJpyWithdrawn + (hasEstimate ? cryptoDepositEstimatedJpy : 0);

	// 口座全体リターン
	let accountReturnPct: number | undefined;
	let accountReturnJpy: number | undefined;
	if (netJpyInvested > 0) {
		accountReturnJpy = Math.round(totalJpyValue - netJpyInvested);
		accountReturnPct = Math.round(((totalJpyValue - netJpyInvested) / netJpyInvested) * 10000) / 100;
	}

	return {
		total_jpy_deposited: Math.round(totalJpyDeposited),
		total_jpy_withdrawn: Math.round(totalJpyWithdrawn),
		net_jpy_invested: Math.round(netJpyInvested),
		crypto_deposit_count: cryptoDeposits.length,
		crypto_deposit_estimated_jpy: hasEstimate ? Math.round(cryptoDepositEstimatedJpy) : undefined,
		crypto_withdrawal_count: cryptoWithdrawals.length,
		account_return_pct: accountReturnPct,
		account_return_jpy: accountReturnJpy,
		is_complete: dw.isComplete,
		analysis_basis: 'deposit_withdrawal',
	};
}

/**
 * 期間内の入出金を集計する。年次・月次サマリー用。
 */
export function calcPeriodDWSummary(
	dw: DepositWithdrawalData,
	sinceMs: number,
	periodStartIso: string,
	periodEndIso: string,
	prices: Map<string, number>,
): PeriodDWSummary {
	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

	// JPY
	const jpyDep = completedDeposits.filter((d) => d.asset === 'jpy');
	const jpyWd = completedWithdrawals.filter((w) => w.asset === 'jpy');
	const jpyDeposited = jpyDep.reduce((s, d) => s + Number(d.amount), 0);
	const jpyWithdrawn = jpyWd.reduce((s, w) => s + Number(w.amount), 0);

	// Crypto deposits
	const cryptoDep = completedDeposits.filter((d) => d.asset !== 'jpy');
	let cryptoDepJpy = 0;
	let hasDepEstimate = false;
	for (const d of cryptoDep) {
		const price = prices.get(d.asset);
		const amount = Number(d.amount);
		if (price && Number.isFinite(amount) && amount > 0) {
			cryptoDepJpy += amount * price;
			hasDepEstimate = true;
		}
	}

	// Crypto withdrawals
	const cryptoWd = completedWithdrawals.filter((w) => w.asset !== 'jpy');
	let cryptoWdJpy = 0;
	let hasWdEstimate = false;
	for (const w of cryptoWd) {
		const price = prices.get(w.asset);
		const amount = Number(w.amount);
		if (price && Number.isFinite(amount) && amount > 0) {
			cryptoWdJpy += amount * price;
			hasWdEstimate = true;
		}
	}

	return {
		jpy_deposited: Math.round(jpyDeposited),
		jpy_withdrawn: Math.round(jpyWithdrawn),
		net_jpy: Math.round(jpyDeposited - jpyWithdrawn),
		crypto_deposit_count: cryptoDep.length,
		crypto_deposit_estimated_jpy: hasDepEstimate ? Math.round(cryptoDepJpy) : undefined,
		crypto_withdrawal_count: cryptoWd.length,
		crypto_withdrawal_estimated_jpy: hasWdEstimate ? Math.round(cryptoWdJpy) : undefined,
		period_start: periodStartIso,
		period_end: periodEndIso,
	};
}

// ── JST 期間境界 ──

/**
 * JST 基準の年初来・月初来の境界タイムスタンプを返す。
 */
export function getJstPeriodBoundaries() {
	const nowJst = dayjs().tz('Asia/Tokyo');
	const yearStart = nowJst.startOf('year');
	const monthStart = nowJst.startOf('month');
	const dayStart = nowJst.startOf('day');
	return {
		yearStartMs: yearStart.valueOf(),
		yearStartIso: yearStart.format('YYYY-MM-DDTHH:mm:ssZ'),
		monthStartMs: monthStart.valueOf(),
		monthStartIso: monthStart.format('YYYY-MM-DDTHH:mm:ssZ'),
		dayStartMs: dayStart.valueOf(),
		dayStartIso: dayStart.format('YYYY-MM-DDTHH:mm:ssZ'),
		nowIso: nowJst.format('YYYY-MM-DDTHH:mm:ssZ'),
	};
}

// ── 保有復元・エクイティ ──

/**
 * 現在の保有情報から取引・入出金を逆順に辿り、指定日時の保有状態を復元する。
 */
export function reconstructHoldingsAtDate(
	currentHoldings: Array<{ asset: string; amount: string }>,
	trades: RawTrade[],
	sinceMs: number,
	dw: DepositWithdrawalData | null,
): Map<string, number> {
	const holdings = new Map<string, number>();
	for (const h of currentHoldings) {
		const amount = Number(h.amount);
		if (Number.isFinite(amount) && amount > 0) {
			holdings.set(h.asset, amount);
		}
	}

	// Reverse trades since sinceMs (newest first)
	const recentTrades = trades.filter((t) => t.executed_at >= sinceMs).sort((a, b) => b.executed_at - a.executed_at);

	for (const t of recentTrades) {
		const asset = t.pair.replace('_jpy', '');
		const qty = Number(t.amount);
		const price = Number(t.price);
		const feeQuote = Number(t.fee_amount_quote) || 0;
		const feeBase = Number(t.fee_amount_base) || 0;
		if (!Number.isFinite(qty) || !Number.isFinite(price)) continue;

		const current = holdings.get(asset) ?? 0;
		const currentJpy = holdings.get('jpy') ?? 0;

		if (t.side === 'buy') {
			// Reverse buy: 買いで実際に増えた base 量は qty - feeBase。それを巻き戻す。
			const newAmount = current - (qty - feeBase);
			if (newAmount < 1e-12) {
				holdings.delete(asset);
			} else {
				holdings.set(asset, newAmount);
			}
			holdings.set('jpy', currentJpy + qty * price + feeQuote);
		} else {
			// Reverse sell: add back crypto, remove JPY received
			holdings.set(asset, current + qty);
			holdings.set('jpy', currentJpy - qty * price + feeQuote);
		}
	}

	// Reverse deposits/withdrawals since sinceMs
	if (dw) {
		const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
		const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

		for (const d of completedDeposits) {
			const current = holdings.get(d.asset) ?? 0;
			const newAmount = current - Number(d.amount);
			if (newAmount < 1e-12) {
				holdings.delete(d.asset);
			} else {
				holdings.set(d.asset, newAmount);
			}
		}

		for (const w of completedWithdrawals) {
			const current = holdings.get(w.asset) ?? 0;
			const fee = Number(w.fee) || 0;
			holdings.set(w.asset, current + Number(w.amount) + fee);
		}
	}

	// Clean up negative/zero holdings
	for (const [asset, amount] of holdings) {
		if (amount < 1e-12) holdings.delete(asset);
	}

	return holdings;
}

/**
 * 復元された保有情報と価格マップから口座評価額を算出する。
 */
export function calcPortfolioValue(holdings: Map<string, number>, priceMap: Map<string, number>): number {
	let total = 0;
	for (const [asset, amount] of holdings) {
		if (asset === 'jpy') {
			total += amount;
		} else {
			const price = priceMap.get(asset);
			if (price) {
				total += amount * price;
			}
		}
	}
	return total;
}

/**
 * 指定日付群について保有状態を復元し、各時点の JPY 建て総資産額を算出する。
 * 最終点として現在のリアルタイム評価額を追加する。
 */
export function buildEquitySeries(
	dates: ReturnType<typeof dayjs>[],
	currentHoldings: Array<{ asset: string; amount: string }>,
	allTrades: RawTrade[],
	dwData: DepositWithdrawalData | null,
	dailyPrices: Map<string, Map<number, number>>,
	currentValueJpy: number,
	currentIso: string,
): EquityPoint[] {
	const series: EquityPoint[] = [];

	for (const date of dates) {
		const dateMs = date.valueOf();
		const holdings = reconstructHoldingsAtDate(currentHoldings, allTrades, dateMs, dwData);

		// Build price map for this date from daily candle opens
		const priceMap = new Map<string, number>();
		for (const [asset, priceByDate] of dailyPrices) {
			const price = priceByDate.get(dateMs);
			if (price != null) {
				priceMap.set(asset, price);
			}
		}

		const value = Math.round(calcPortfolioValue(holdings, priceMap));
		series.push({
			timestamp: date.format('YYYY-MM-DDTHH:mm:ssZ'),
			value_jpy: value,
		});
	}

	// Final point: current real-time value
	series.push({
		timestamp: currentIso,
		value_jpy: currentValueJpy,
	});

	return series;
}

// ── 期間ネットフロー ──

/**
 * 期間中の純入出金額と出金手数料を分離して算出する。
 *
 * - net_flow_jpy: 元本の移動のみ（出金手数料を含まない）。
 *   正値 = 純入金（口座に資金流入）、負値 = 純出金。
 * - withdrawal_fee_jpy: 出金時に失った手数料の合計。
 *   adjusted_change から net_flow を引いた結果にこのコストが残る。
 *
 * 暗号資産の入出庫は現在価格で仮評価。
 */
export function calcPeriodNetFlow(
	dw: DepositWithdrawalData | null,
	sinceMs: number,
	prices: Map<string, number>,
): PeriodNetFlowResult {
	if (!dw) return { net_flow_jpy: 0, withdrawal_fee_jpy: 0 };

	const completedDeposits = dw.deposits.filter((d) => d.status === 'DONE' && d.confirmed_at >= sinceMs);
	const completedWithdrawals = dw.withdrawals.filter((w) => w.status === 'DONE' && w.requested_at >= sinceMs);

	let netFlow = 0;
	let withdrawalFee = 0;

	// Deposits (inflow)
	for (const d of completedDeposits) {
		if (d.asset === 'jpy') {
			netFlow += Number(d.amount);
		} else {
			const price = prices.get(d.asset);
			const amount = Number(d.amount);
			if (price && Number.isFinite(amount) && amount > 0) {
				netFlow += amount * price;
			}
		}
	}

	// Withdrawals — 元本（外部フロー）と手数料（コスト）を分離
	for (const w of completedWithdrawals) {
		const fee = Number(w.fee) || 0;
		if (w.asset === 'jpy') {
			netFlow -= Number(w.amount);
			withdrawalFee += fee;
		} else {
			const price = prices.get(w.asset);
			const amount = Number(w.amount);
			if (price && Number.isFinite(amount) && amount > 0) {
				netFlow -= amount * price;
				if (fee > 0) {
					withdrawalFee += fee * price;
				}
			}
		}
	}

	return {
		net_flow_jpy: Math.round(netFlow),
		withdrawal_fee_jpy: Math.round(withdrawalFee),
	};
}
