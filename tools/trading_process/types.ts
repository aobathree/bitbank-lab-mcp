/**
 * trading_process/types.ts - バックテスト用型定義
 *
 * 【重要な定義】
 * - エクイティ: 複利で計算。初期値1.0（=100%）、表示用は (equity - 1) * 100
 * - ドローダウン: エクイティベースの割合。0以上の下落幅[%]
 * - 総損益: 複利計算 Π(1 + return) - 1
 */

export type Timeframe = '1D' | '1H' | '4H';
export type Period = '1M' | '3M' | '6M' | '1Y' | '2Y' | '3Y';

/**
 * バックテスト対象期間の指定方法
 * - period: 直近 N 本（'1M' / '3M' / ... / '3Y'）
 * - absolute: ISO 8601 (YYYY-MM-DD) の start / end で明示指定。
 *   start / end は **JST (Asia/Tokyo) の 0:00 / 23:59:59.999** として解釈される。
 *   bitbank の日足が JST 0:00 区切りのため、実行環境の TZ には依存しない。
 */
export type BacktestRange = { type: 'period'; value: Period } | { type: 'absolute'; start: string; end: string };

export interface BacktestInput {
	pair: string;
	timeframe: Timeframe;
	period: Period;
	sma_short: number;
	sma_long: number;
	fee_bp: number;
	execution: 't+1_open';
}

export interface Candle {
	time: string;
	open: number;
	high: number;
	low: number;
	close: number;
	volume?: number;
}

export interface Trade {
	entry_time: string;
	entry_price: number;
	exit_time: string;
	exit_price: number;
	/** 損益率[%]。例: -10.59。丸めなしの生値。表示時は呼び出し側で丸める */
	pnl_pct: number;
	/** 手数料率[%]。丸めなしの生値。表示時は呼び出し側で丸める */
	fee_pct: number;
	/** 計算用 純リターン乗数。例: 0.9388 = -6.12%。equity *= net_return で複利計算。丸めなしの生値 */
	net_return: number;
}

export interface EquityPoint {
	time: string;
	/** 表示用 累積損益[%] = (equity - 1) * 100。含み損益込み */
	equity_pct: number;
	/** 確定損益[%]。トレード決済時のみ更新される */
	confirmed_pct: number;
}

export interface DrawdownPoint {
	time: string;
	/** 0以上。ピークからの下落幅[%]。例: 18.31 (表示時に -18.31% とする) */
	drawdown_pct: number;
}

export interface BacktestSummary {
	/** 複利計算による総損益[%]。Π(1 + return) - 1 */
	total_pnl_pct: number;
	trade_count: number;
	win_rate: number;
	/** 0以上。最大ドローダウン[%]。表示時に -XX% とする */
	max_drawdown_pct: number;
}

export interface BacktestResult {
	input: BacktestInput;
	summary: BacktestSummary;
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
}

export interface BacktestChartData {
	candles: Candle[];
	smaShort: number[];
	smaLong: number[];
	trades: Trade[];
	equity_curve: EquityPoint[];
	drawdown_curve: DrawdownPoint[];
	input: BacktestInput;
	summary?: BacktestSummary;
}
