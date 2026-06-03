/**
 * bitbank /spot/pairs 仕様の取得・キャッシュ・注文事前バリデーション。
 *
 * preview_order から呼ばれ、bitbank 側で 60003 / 60004 / 60005 / 60006 / 70004 等を
 * 返す前に、最小数量・桁数・取引停止フラグをローカルで検出するために使用する。
 *
 * 公式仕様: GET https://api.bitbank.cc/v1/spot/pairs (認証不要)
 *   - https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api.md
 */

import { TtlCache } from './cache.js';
import { toNum } from './conversions.js';
import { getErrorMessage, isAbortError } from './error.js';

/** /spot/pairs の URL（private API ホストだが認証不要） */
export const SPOT_PAIRS_URL = 'https://api.bitbank.cc/v1/spot/pairs';

/**
 * ペア仕様のキャッシュ TTL。デフォルト 1 時間（ペア仕様は頻繁には変わらない）。
 * BITBANK_SPOT_PAIRS_TTL_MS が空文字 / NaN / 0 以下の場合はデフォルトにフォールバックする
 * （誤って TTL=0 にしてキャッシュが恒久的に無効化されるのを防ぐため）。
 */
const DEFAULT_PAIRS_TTL_MS = 60 * 60 * 1000;
function resolvePairsTtlMs(): number {
	const raw = process.env.BITBANK_SPOT_PAIRS_TTL_MS;
	if (raw == null || raw.trim() === '') return DEFAULT_PAIRS_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PAIRS_TTL_MS;
}
const PAIRS_TTL_MS = resolvePairsTtlMs();
const FETCH_TIMEOUT_MS_DEFAULT = 5000;
const CACHE_KEY = 'spot_pairs';

/**
 * /spot/pairs レスポンスの 1 ペア分（正規化後）。
 * preview_order の事前バリデーションで使うフィールドのみ抽出している。
 */
export interface PairSpec {
	name: string;
	base_asset: string;
	quote_asset: string;
	/** 最小注文数量（base 通貨建て） */
	unit_amount: string;
	/** limit / stop_limit の最大注文数量 */
	limit_max_amount: string;
	/** market / stop の最大注文数量 */
	market_max_amount: string;
	/** 価格の小数桁数（最小値刻み = 10^-price_digits） */
	price_digits: number;
	/** 数量の小数桁数（最小単位 = 10^-amount_digits） */
	amount_digits: number;
	/** ペアが取引可能か */
	is_enabled: boolean;
	/** 新規注文停止フラグ */
	stop_order: boolean;
	/** 新規注文 + キャンセル停止フラグ */
	stop_order_and_cancel: boolean;
	/** market 注文停止 */
	stop_market_order: boolean;
	/** stop（成行トリガー）注文停止 */
	stop_stop_order: boolean;
	/** stop_limit 注文停止 */
	stop_stop_limit_order: boolean;
	/** 信用ロング新規建て停止 */
	stop_margin_long_order: boolean;
	/** 信用ショート新規建て停止 */
	stop_margin_short_order: boolean;
	/** buy 注文停止 */
	stop_buy_order: boolean;
	/** sell 注文停止 */
	stop_sell_order: boolean;

	// ── 取引手数料率（見積り用の単一ソース） ──
	// bitbank API は文字列で返す。string のまま保持し、欠損は null。
	// これらを直接 parse せず lib/fees.ts 経由で解決する（.claude/rules/fees.md）。
	/** taker 手数料率（quote 建て） */
	taker_fee_rate_quote: string | null;
	/** maker 手数料率（quote 建て。campaign で負のリベートになりうる） */
	maker_fee_rate_quote: string | null;
	/** taker 手数料率（base 建て） */
	taker_fee_rate_base: string | null;
	/** maker 手数料率（base 建て） */
	maker_fee_rate_base: string | null;
	/** 信用 新規建て maker 手数料率（quote 建て） */
	margin_open_maker_fee_rate_quote: string | null;
	/** 信用 新規建て taker 手数料率（quote 建て） */
	margin_open_taker_fee_rate_quote: string | null;
	/** 信用 決済 maker 手数料率（quote 建て） */
	margin_close_maker_fee_rate_quote: string | null;
	/** 信用 決済 taker 手数料率（quote 建て） */
	margin_close_taker_fee_rate_quote: string | null;
}

/** ペア名 → 仕様の Map（lowercase キー） */
export type PairsSpecMap = Map<string, PairSpec>;

const cache = new TtlCache<PairsSpecMap>({ ttlMs: PAIRS_TTL_MS, maxEntries: 1 });

/** テスト用: キャッシュをクリアする */
export function clearPairsSpecCache(): void {
	cache.clear();
}

interface RawPair {
	name?: string;
	base_asset?: string;
	quote_asset?: string;
	unit_amount?: string;
	limit_max_amount?: string;
	market_max_amount?: string;
	price_digits?: number;
	amount_digits?: number;
	is_enabled?: boolean;
	stop_order?: boolean;
	stop_order_and_cancel?: boolean;
	stop_market_order?: boolean;
	stop_stop_order?: boolean;
	stop_stop_limit_order?: boolean;
	stop_margin_long_order?: boolean;
	stop_margin_short_order?: boolean;
	stop_buy_order?: boolean;
	stop_sell_order?: boolean;
	taker_fee_rate_quote?: string | null;
	maker_fee_rate_quote?: string | null;
	taker_fee_rate_base?: string | null;
	maker_fee_rate_base?: string | null;
	margin_open_maker_fee_rate_quote?: string | null;
	margin_open_taker_fee_rate_quote?: string | null;
	margin_close_maker_fee_rate_quote?: string | null;
	margin_close_taker_fee_rate_quote?: string | null;
}

/** 手数料率フィールドの正規化（string はそのまま、欠損/非文字列は null）。 */
function feeRateOrNull(v: unknown): string | null {
	return typeof v === 'string' ? v : null;
}

function normalize(raw: RawPair): PairSpec | null {
	if (!raw?.name) return null;
	const priceDigits = Number(raw.price_digits);
	const amountDigits = Number(raw.amount_digits);
	return {
		name: String(raw.name).toLowerCase(),
		base_asset: String(raw.base_asset ?? ''),
		quote_asset: String(raw.quote_asset ?? ''),
		unit_amount: String(raw.unit_amount ?? '0'),
		limit_max_amount: String(raw.limit_max_amount ?? ''),
		market_max_amount: String(raw.market_max_amount ?? ''),
		price_digits: Number.isFinite(priceDigits) ? priceDigits : 0,
		amount_digits: Number.isFinite(amountDigits) ? amountDigits : 0,
		is_enabled: raw.is_enabled === true,
		stop_order: raw.stop_order === true,
		stop_order_and_cancel: raw.stop_order_and_cancel === true,
		stop_market_order: raw.stop_market_order === true,
		stop_stop_order: raw.stop_stop_order === true,
		stop_stop_limit_order: raw.stop_stop_limit_order === true,
		stop_margin_long_order: raw.stop_margin_long_order === true,
		stop_margin_short_order: raw.stop_margin_short_order === true,
		stop_buy_order: raw.stop_buy_order === true,
		stop_sell_order: raw.stop_sell_order === true,
		taker_fee_rate_quote: feeRateOrNull(raw.taker_fee_rate_quote),
		maker_fee_rate_quote: feeRateOrNull(raw.maker_fee_rate_quote),
		taker_fee_rate_base: feeRateOrNull(raw.taker_fee_rate_base),
		maker_fee_rate_base: feeRateOrNull(raw.maker_fee_rate_base),
		margin_open_maker_fee_rate_quote: feeRateOrNull(raw.margin_open_maker_fee_rate_quote),
		margin_open_taker_fee_rate_quote: feeRateOrNull(raw.margin_open_taker_fee_rate_quote),
		margin_close_maker_fee_rate_quote: feeRateOrNull(raw.margin_close_maker_fee_rate_quote),
		margin_close_taker_fee_rate_quote: feeRateOrNull(raw.margin_close_taker_fee_rate_quote),
	};
}

export interface FetchPairsSpecOptions {
	/** リクエストタイムアウト（ms）。デフォルト 5000ms */
	timeoutMs?: number;
}

/**
 * bitbank /spot/pairs を取得しキャッシュする。
 *
 * - キャッシュにあれば即返す（TTL: BITBANK_SPOT_PAIRS_TTL_MS、デフォルト 1h）
 * - 取得失敗時は throw する。呼び出し側は warning にフォールバックする想定。
 */
export async function fetchPairsSpec(opts: FetchPairsSpecOptions = {}): Promise<PairsSpecMap> {
	const cached = cache.get(CACHE_KEY);
	if (cached) return cached;

	const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS_DEFAULT;
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(SPOT_PAIRS_URL, { signal: ctrl.signal });
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
		const json = (await res.json()) as { success?: number; data?: { pairs?: unknown[] } };
		if (json?.success !== 1 || !Array.isArray(json.data?.pairs)) {
			throw new Error('上流レスポンスが不正です（success !== 1 または data.pairs が配列でない）');
		}
		const map: PairsSpecMap = new Map();
		for (const raw of json.data.pairs as RawPair[]) {
			const spec = normalize(raw);
			if (spec) map.set(spec.name, spec);
		}
		if (map.size === 0) throw new Error('ペア仕様が空です');
		cache.set(CACHE_KEY, map);
		return map;
	} catch (err) {
		if (isAbortError(err)) throw new Error(`/spot/pairs 取得タイムアウト (${timeoutMs}ms)`);
		throw new Error(`/spot/pairs 取得失敗: ${getErrorMessage(err)}`);
	} finally {
		clearTimeout(t);
	}
}

// ── 注文事前バリデーション ──

export interface OrderConstraintsInput {
	pair: string;
	type: 'limit' | 'market' | 'stop' | 'stop_limit';
	side: 'buy' | 'sell';
	amount: string;
	price?: string;
	trigger_price?: string;
	position_side?: 'long' | 'short';
}

export interface ConstraintViolation {
	/** 違反フィールド（エラー分類用） */
	field: 'pair' | 'amount' | 'price' | 'trigger_price' | 'type' | 'side';
	/** ユーザー向け日本語メッセージ */
	message: string;
}

/**
 * 値の有効小数桁数を返す（末尾ゼロは無視）。
 *
 * @example
 *  fractionalDigitCount("0.10")      // 1（"0.1" として扱う）
 *  fractionalDigitCount("0.00010")   // 4
 *  fractionalDigitCount("100")       // 0
 *  fractionalDigitCount("100.")      // 0
 *  fractionalDigitCount("100.0")     // 0
 */
export function fractionalDigitCount(s: string): number {
	if (typeof s !== 'string') return 0;
	const dot = s.indexOf('.');
	if (dot < 0) return 0;
	// 末尾ゼロを削除（"0.100" → "0.1", "100.000" → "100"）
	const stripped = s.replace(/0+$/, '').replace(/\.$/, '');
	const newDot = stripped.indexOf('.');
	if (newDot < 0) return 0;
	return stripped.length - newDot - 1;
}

/**
 * ペア仕様に照らして注文パラメータをバリデーションする。
 * 違反があれば最初の 1 件を返す（pair 存在 → 取引停止 → 数量 → 価格 の順）。
 * 違反なしは null を返す。spec=undefined はペア未対応扱い。
 */
export function validateOrderConstraints(
	spec: PairSpec | undefined,
	input: OrderConstraintsInput,
): ConstraintViolation | null {
	if (!spec) {
		return {
			field: 'pair',
			message: `未対応のペア '${input.pair}'。bitbank の /spot/pairs に存在しません`,
		};
	}

	if (!spec.is_enabled) {
		return {
			field: 'pair',
			message: `ペア '${spec.name}' は現在取引停止中です（is_enabled=false）`,
		};
	}

	if (spec.stop_order_and_cancel) {
		return {
			field: 'pair',
			message: `ペア '${spec.name}' は現在新規注文・キャンセルともに停止中です（stop_order_and_cancel）`,
		};
	}
	if (spec.stop_order) {
		return {
			field: 'pair',
			message: `ペア '${spec.name}' は現在新規注文を停止しています（stop_order）`,
		};
	}

	// type ごとの停止フラグ
	if (input.type === 'market' && spec.stop_market_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 market 注文を停止しています` };
	}
	if (input.type === 'stop' && spec.stop_stop_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 stop 注文を停止しています` };
	}
	if (input.type === 'stop_limit' && spec.stop_stop_limit_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 stop_limit 注文を停止しています` };
	}

	// side ごとの停止フラグ
	if (input.side === 'buy' && spec.stop_buy_order) {
		return { field: 'side', message: `ペア '${spec.name}' は現在 buy 注文を停止しています` };
	}
	if (input.side === 'sell' && spec.stop_sell_order) {
		return { field: 'side', message: `ペア '${spec.name}' は現在 sell 注文を停止しています` };
	}

	// 信用新規建ての停止
	if (input.position_side === 'long' && input.side === 'buy' && spec.stop_margin_long_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 信用ロング新規建て を停止しています` };
	}
	if (input.position_side === 'short' && input.side === 'sell' && spec.stop_margin_short_order) {
		return { field: 'type', message: `ペア '${spec.name}' は現在 信用ショート新規建て を停止しています` };
	}

	const baseLabel = spec.base_asset ? spec.base_asset.toUpperCase() : '';

	// 最小数量
	const amountNum = toNum(input.amount);
	const minNum = toNum(spec.unit_amount);
	if (amountNum != null && minNum != null && amountNum < minNum) {
		return {
			field: 'amount',
			message: `amount は最小注文数量 ${spec.unit_amount} ${baseLabel} 以上を指定してください（指定値: ${input.amount}）`,
		};
	}

	// 最大数量（type に応じて limit_max_amount / market_max_amount を使い分け）
	const isLimitFamily = input.type === 'limit' || input.type === 'stop_limit';
	const maxStr = isLimitFamily ? spec.limit_max_amount : spec.market_max_amount;
	const maxNum = toNum(maxStr);
	if (amountNum != null && maxNum != null && maxNum > 0 && amountNum > maxNum) {
		const limitLabel = isLimitFamily ? 'limit / stop_limit' : 'market / stop';
		return {
			field: 'amount',
			message: `amount は最大注文数量 ${maxStr} ${baseLabel} 以下を指定してください（${limitLabel} の上限。指定値: ${input.amount}）`,
		};
	}

	// 数量の精度（小数桁数）
	const amountFrac = fractionalDigitCount(input.amount);
	if (amountFrac > spec.amount_digits) {
		return {
			field: 'amount',
			message: `amount の小数桁数 (${amountFrac}) が許容上限 (${spec.amount_digits}) を超えています（最小単位: 10^-${spec.amount_digits} ${baseLabel}）`,
		};
	}

	// 価格の精度
	if (input.price != null && input.price !== '') {
		const priceFrac = fractionalDigitCount(input.price);
		if (priceFrac > spec.price_digits) {
			return {
				field: 'price',
				message: `price の小数桁数 (${priceFrac}) が許容上限 (${spec.price_digits}) を超えています（最小値刻み: 10^-${spec.price_digits}）`,
			};
		}
	}

	// trigger_price の精度
	if (input.trigger_price != null && input.trigger_price !== '') {
		const tpFrac = fractionalDigitCount(input.trigger_price);
		if (tpFrac > spec.price_digits) {
			return {
				field: 'trigger_price',
				message: `trigger_price の小数桁数 (${tpFrac}) が許容上限 (${spec.price_digits}) を超えています（最小値刻み: 10^-${spec.price_digits}）`,
			};
		}
	}

	return null;
}
