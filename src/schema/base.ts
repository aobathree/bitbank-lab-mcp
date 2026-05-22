import { z } from 'zod';

export const CandleTypeEnum = z.enum([
	'1min',
	'5min',
	'15min',
	'30min',
	'1hour',
	'4hour',
	'8hour',
	'12hour',
	'1day',
	'1week',
	'1month',
]);

// ── Shared base schemas ──

/** レートリミット情報スキーマ（レスポンスヘッダから抽出、ヘッダ未提供時は省略） */
export const RateLimitSchema = z
	.object({
		remaining: z.number().describe('残りリクエスト数'),
		limit: z.number().describe('期間あたりの上限数'),
		reset: z.number().describe('リセット時刻（Unix epoch 秒）'),
	})
	.optional();

/** pair + fetchedAt: 全 Meta スキーマの共通ベース */
export const BaseMetaSchema = z.object({
	pair: z.string(),
	fetchedAt: z.string(),
	rateLimit: RateLimitSchema,
});

/** pair デフォルト入力: z.string().optional().default('btc_jpy') */
export const BasePairInputSchema = z.object({ pair: z.string().optional().default('btc_jpy') });

/** 全ツール共通のエラー分岐 */
export const FailResultSchema = z.object({
	ok: z.literal(false),
	summary: z.string(),
	data: z.object({}).passthrough(),
	meta: z.object({ errorType: z.string() }).passthrough(),
});

/** ok/fail Result union を生成するヘルパー */
export function toolResultSchema<D extends z.ZodTypeAny, M extends z.ZodTypeAny>(data: D, meta: M) {
	return z.union([z.object({ ok: z.literal(true), summary: z.string(), data, meta }), FailResultSchema]);
}

export const TrendLabelEnum = z.enum([
	'strong_uptrend',
	'uptrend',
	'strong_downtrend',
	'downtrend',
	'overbought',
	'oversold',
	'sideways',
	'insufficient_data',
]);

// === Shared output schemas (partial) ===
export const NumericSeriesSchema = z
	.array(z.union([z.number(), z.null()]))
	.transform((arr) => arr.map((v) => (v == null ? null : Number(Number(v).toFixed(2)))));

/**
 * ローソク足スキーマ
 * volume: base 通貨建ての合算取引量（買い+売り区別なし）。
 *   例: btc_jpy → BTC 単位、eth_jpy → ETH 単位。
 *   bitbank /candlestick API の OHLCV[4] をそのまま使用。
 *   公式アプリの Volume バー（買い/売り色分け）とは集計方法が異なる。
 */
export const CandleSchema = z.object({
	open: z.number(),
	high: z.number(),
	low: z.number(),
	close: z.number(),
	volume: z.number().optional(),
	isoTime: z
		.string()
		.nullable()
		.optional()
		.describe('UTC ISO 文字列（例: 2026-02-20T00:00:00.000Z）。tz 引数の影響を受けない。'),
	isoTimeLocal: z
		.string()
		.nullable()
		.optional()
		.describe('tz 引数のローカル時刻文字列（既定 Asia/Tokyo、例: 2026-02-20T09:00:00）。'),
	time: z.union([z.string(), z.number()]).optional(),
	timestamp: z.number().optional(),
});
