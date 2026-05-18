import { z } from 'zod';
import {
	BaseMetaSchema,
	BasePairInputSchema,
	CandleSchema,
	CandleTypeEnum,
	FailResultSchema,
	toolResultSchema,
} from './base.js';

// === Ticker ===
export const TickerNormalizedSchema = z.object({
	pair: z.string(),
	last: z.number().nullable(),
	buy: z.number().nullable(),
	sell: z.number().nullable(),
	open: z.number().nullable(),
	high: z.number().nullable(),
	low: z.number().nullable(),
	volume: z.number().nullable(),
	timestamp: z.number().nullable(),
	isoTime: z.string().nullable(),
});

export const GetTickerDataSchemaOut = z.object({ raw: z.unknown(), normalized: TickerNormalizedSchema });
export const GetTickerMetaSchemaOut = BaseMetaSchema;
export const GetTickerOutputSchema = toolResultSchema(GetTickerDataSchemaOut, GetTickerMetaSchemaOut);
export const GetTickerInputSchema = BasePairInputSchema;

// === Depth (raw depth tuple, shared by /depth tool and orderbook raw mode) ===
export const DepthLevelTupleSchema = z.tuple([z.string(), z.string()]);

// === Orderbook ===
export const OrderbookLevelSchema = z.object({ price: z.number(), size: z.number() });
export const OrderbookLevelWithCumSchema = OrderbookLevelSchema.extend({ cumSize: z.number() });
export const OrderbookNormalizedSchema = z.object({
	pair: z.string(),
	bestBid: z.number().nullable(),
	bestAsk: z.number().nullable(),
	spread: z.number().nullable(),
	mid: z.number().nullable(),
	bids: z.array(OrderbookLevelWithCumSchema),
	asks: z.array(OrderbookLevelWithCumSchema),
	timestamp: z.number().nullable(),
	isoTime: z.string().nullable(),
});

const OrderbookPressureTagEnum = z.enum(['notice', 'warning', 'strong']);

// mode=summary
export const OrderbookSummaryDataSchema = z.object({
	mode: z.literal('summary'),
	normalized: OrderbookNormalizedSchema,
});

// mode=pressure
export const OrderbookPressureBandSchema = z.object({
	widthPct: z.number(),
	baseMid: z.number().nullable(),
	baseBidSize: z.number(),
	baseAskSize: z.number(),
	bidDelta: z.number(),
	askDelta: z.number(),
	netDelta: z.number(),
	netDeltaPct: z.number().nullable(),
	tag: OrderbookPressureTagEnum.nullable(),
});
export const OrderbookPressureDataSchema = z.object({
	mode: z.literal('pressure'),
	bands: z.array(OrderbookPressureBandSchema),
	aggregates: z.object({
		netDelta: z.number(),
		strongestTag: OrderbookPressureTagEnum.nullable(),
	}),
});

// mode=statistics
export const OrderbookStatisticsDataSchema = z.object({
	mode: z.literal('statistics'),
	basic: z.object({
		currentPrice: z.number().nullable(),
		bestBid: z.number().nullable(),
		bestAsk: z.number().nullable(),
		spread: z.number().nullable(),
		spreadPct: z.number().nullable(),
	}),
	ranges: z.array(
		z.object({
			pct: z.number(),
			bidVolume: z.number(),
			askVolume: z.number(),
			bidValue: z.number(),
			askValue: z.number(),
			// ask 板が枯れて bid だけ存在するとき実装は Infinity を返す（tools/get_orderbook.ts buildStatistics）。
			// Zod v4 の z.number() は Infinity を拒否するので、実態に合わせて literal(Infinity) を許容する。
			ratio: z.union([z.number(), z.literal(Number.POSITIVE_INFINITY)]),
			interpretation: z.string(),
		}),
	),
	liquidityZones: z.array(
		z.object({
			priceRange: z.string(),
			bidVolume: z.number(),
			askVolume: z.number(),
			dominance: z.enum(['bid', 'ask', 'balanced']),
			note: z.string().optional(),
		}),
	),
	largeOrders: z.object({
		bids: z.array(z.object({ price: z.number(), size: z.number(), distance: z.number().nullable() })),
		asks: z.array(z.object({ price: z.number(), size: z.number(), distance: z.number().nullable() })),
		threshold: z.number(),
	}),
	summary: z.object({
		overall: z.string(),
		strength: z.enum(['weak', 'moderate', 'strong']),
		liquidity: z.enum(['low', 'medium', 'high']),
		recommendation: z.string(),
	}),
});

// mode=raw（bitbank /depth の生値 + 壁ゾーン推定 overlay）
// 公式 API は asks_over などを string で返すが、テスト fixture では number リテラルを渡すため両方を許容する。
export const OrderbookRawDataSchema = z.object({
	mode: z.literal('raw'),
	asks: z.array(DepthLevelTupleSchema),
	bids: z.array(DepthLevelTupleSchema),
	asks_over: z.union([z.string(), z.number()]).optional(),
	asks_under: z.union([z.string(), z.number()]).optional(),
	bids_over: z.union([z.string(), z.number()]).optional(),
	bids_under: z.union([z.string(), z.number()]).optional(),
	ask_market: z.union([z.string(), z.number()]).optional(),
	bid_market: z.union([z.string(), z.number()]).optional(),
	timestamp: z.number().int(),
	sequenceId: z.number().int().optional(),
	overlays: z
		.object({
			depth_zones: z.array(
				z.object({
					low: z.number(),
					high: z.number(),
					color: z.string().optional(),
					label: z.string().optional(),
				}),
			),
		})
		.optional(),
});

export const GetOrderbookDataSchemaOut = z.discriminatedUnion('mode', [
	OrderbookSummaryDataSchema,
	OrderbookPressureDataSchema,
	OrderbookStatisticsDataSchema,
	OrderbookRawDataSchema,
]);
export const GetOrderbookMetaSchemaOut = BaseMetaSchema.extend({
	mode: z.enum(['summary', 'pressure', 'statistics', 'raw']),
	topN: z.number(),
});
export const GetOrderbookOutputSchema = toolResultSchema(GetOrderbookDataSchemaOut, GetOrderbookMetaSchemaOut);

export const GetOrderbookInputSchema = BasePairInputSchema.extend({
	mode: z.enum(['summary', 'pressure', 'statistics', 'raw']).optional().default('summary'),
	/** summary mode: 上位N層 (1-200) */
	topN: z.number().int().min(1).max(200).optional().default(10),
	/** pressure mode: 帯域幅 (例: [0.001, 0.005, 0.01]) */
	bandsPct: z.array(z.number().positive()).optional().default([0.001, 0.005, 0.01]),
	/** statistics mode: 範囲% (例: [0.5, 1.0, 2.0]) */
	ranges: z.array(z.number().positive()).optional().default([0.5, 1.0, 2.0]),
	/** statistics mode: 価格ゾーン分割数 */
	priceZones: z.number().int().min(2).max(50).optional().default(10),
});

// === Candles ===
export const KeyPointSchema = z.object({
	index: z.number(),
	date: z.string().nullable(),
	close: z.number(),
	changePct: z.number().nullable().optional(),
});

export const KeyPointsSchema = z.object({
	today: KeyPointSchema.nullable(),
	sevenDaysAgo: KeyPointSchema.nullable(),
	thirtyDaysAgo: KeyPointSchema.nullable(),
	ninetyDaysAgo: KeyPointSchema.nullable(),
});

export const VolumeStatsSchema = z.object({
	recent7DaysAvg: z.number(),
	previous7DaysAvg: z.number(),
	last30DaysAvg: z.number().nullable(),
	changePct: z.number(),
	judgment: z.string(),
});

export const GetCandlesDataSchemaOut = z.object({
	raw: z.unknown(),
	normalized: z.array(CandleSchema),
	keyPoints: KeyPointsSchema.optional(),
	volumeStats: VolumeStatsSchema.nullable().optional(),
});
export const GetCandlesMetaSchemaOut = BaseMetaSchema.extend({
	type: CandleTypeEnum,
	count: z.number(),
});
export const GetCandlesOutputSchema = toolResultSchema(GetCandlesDataSchemaOut, GetCandlesMetaSchemaOut);

export const GetCandlesInputSchema = z.object({
	pair: z.string(),
	type: CandleTypeEnum,
	date: z
		.string()
		.optional()
		.describe(
			"YYYYMMDD format (e.g., 20251022). Fetches the {limit} most recent candles up to and including this date. For '1month' type use YYYY format. If omitted, returns latest candles.",
		),
	limit: z.number().int().min(1).max(1000).optional().default(200),
	view: z.enum(['full', 'items']).optional().default('full'),
	tz: z
		.string()
		.optional()
		.default('Asia/Tokyo')
		.describe('タイムゾーン（デフォルト: Asia/Tokyo）。各ローソク足に isoTimeLocal フィールドを追加。空文字でUTCのみ'),
});

// === Transactions ===
export const TransactionItemSchema = z.object({
	// 公式 API のレスポンスでは必須。normalized では上流欠損や互換ソース対応のため optional。
	transaction_id: z.number().int().optional(),
	price: z.number(),
	amount: z.number(),
	side: z.enum(['buy', 'sell']),
	timestampMs: z.number().int(),
	isoTime: z.string(),
});

export const GetTransactionsDataSchemaOut = z.object({ raw: z.unknown(), normalized: z.array(TransactionItemSchema) });
export const GetTransactionsMetaSchemaOut = BaseMetaSchema.extend({
	count: z.number().int(),
	source: z.enum(['latest', 'by_date']),
});
export const GetTransactionsOutputSchema = toolResultSchema(GetTransactionsDataSchemaOut, GetTransactionsMetaSchemaOut);

export const GetTransactionsInputSchema = BasePairInputSchema.extend({
	limit: z.number().int().min(1).max(1000).optional().default(100),
	date: z
		.string()
		.regex(/^\d{8}$/)
		.optional()
		.describe('YYYYMMDD; omit for latest'),
	minAmount: z.number().positive().optional(),
	maxAmount: z.number().positive().optional(),
	minPrice: z.number().positive().optional(),
	maxPrice: z.number().positive().optional(),
	view: z.enum(['summary', 'items']).optional().default('summary'),
});

// === Depth (raw depth for analysis/visualization) ===
export const GetDepthDataSchemaOut = z.object({
	asks: z.array(DepthLevelTupleSchema),
	bids: z.array(DepthLevelTupleSchema),
	asks_over: z.string().optional(),
	asks_under: z.string().optional(),
	bids_over: z.string().optional(),
	bids_under: z.string().optional(),
	ask_market: z.string().optional(),
	bid_market: z.string().optional(),
	timestamp: z.number().int(),
	sequenceId: z.number().int().optional(),
	overlays: z
		.object({
			depth_zones: z.array(
				z.object({ low: z.number(), high: z.number(), color: z.string().optional(), label: z.string().optional() }),
			),
		})
		.optional(),
});
export const GetDepthMetaSchemaOut = BaseMetaSchema;
export const GetDepthOutputSchema = toolResultSchema(GetDepthDataSchemaOut, GetDepthMetaSchemaOut);

// === Flow Metrics (derived from recent transactions) ===
export const FlowBucketSchema = z.object({
	timestampMs: z.number().int(),
	isoTime: z.string(),
	isoTimeJST: z.string().optional(),
	displayTime: z.string().optional(),
	buyVolume: z.number(),
	sellVolume: z.number(),
	totalVolume: z.number(),
	cvd: z.number(),
	zscore: z.number().nullable().optional(),
	spike: z.enum(['notice', 'warning', 'strong']).nullable().optional(),
});

export const GetFlowMetricsDataSchemaOut = z.object({
	source: z.literal('transactions'),
	params: z.object({ bucketMs: z.number().int().min(1000) }),
	aggregates: z.object({
		totalTrades: z.number().int(),
		buyTrades: z.number().int(),
		sellTrades: z.number().int(),
		buyVolume: z.number(),
		sellVolume: z.number(),
		netVolume: z.number(),
		aggressorRatio: z.number().min(0).max(1),
		finalCvd: z.number(),
	}),
	series: z.object({ buckets: z.array(FlowBucketSchema) }),
});

export const GetFlowMetricsMetaSchemaOut = BaseMetaSchema.extend({
	count: z.number().int(),
	bucketMs: z.number().int(),
	timezone: z.string().optional(),
	timezoneOffset: z.string().optional(),
	serverTime: z.string().optional(),
	hours: z.number().optional(),
	mode: z.enum(['time_range']).optional(),
	actualRange: z
		.object({
			start: z.string(),
			end: z.string(),
			durationMinutes: z.number().int(),
		})
		.optional(),
	warning: z.string().optional(),
});

export const GetFlowMetricsOutputSchema = toolResultSchema(GetFlowMetricsDataSchemaOut, GetFlowMetricsMetaSchemaOut);

export const GetFlowMetricsInputSchema = BasePairInputSchema.extend({
	limit: z
		.number()
		.int()
		.min(1)
		.max(2000)
		.optional()
		.default(100)
		.describe('取得する約定件数（バケット数ではない）。hours 指定時は無視されます'),
	hours: z
		.number()
		.min(0.1)
		.max(24)
		.optional()
		.describe(
			'指定した時間数分の約定を取得して分析（例: 8 → 直近8時間）。limit より優先。複数日にまたがる場合も自動で取得します',
		),
	date: z
		.string()
		.regex(/^\d{8}$/)
		.optional()
		.describe('YYYYMMDD; omit for latest'),
	bucketMs: z
		.number()
		.int()
		.min(1000)
		.max(3600_000)
		.optional()
		.default(60_000)
		.describe('バケットの時間幅（ミリ秒）。デフォルト60000=1分間隔'),
	view: z
		.enum(['summary', 'compact', 'buckets', 'full'])
		.optional()
		.default('summary')
		.describe(
			'summary: 集計値のみ (buckets 省略) / compact: 非ゼロバケットのみ / buckets: 直近 N バケット / full: 全バケット',
		),
	bucketsN: z.number().int().min(1).max(100).optional().default(10),
	tz: z.string().optional().default('Asia/Tokyo'),
});

// === /tickers_jpy (public REST) ===
export const TickerJpyItemSchema = z.object({
	pair: z.string(),
	sell: z.string().nullable(),
	buy: z.string().nullable(),
	high: z.string(),
	low: z.string(),
	open: z.string(),
	last: z.string(),
	vol: z.string(),
	timestamp: z.number(),
	// 追加: 24h変化率（%）。open/last から算出
	change24h: z.number().nullable().optional(),
	change24hPct: z.number().nullable().optional(),
});
export const GetTickersJpyOutputSchema = z.union([
	z.object({
		ok: z.literal(true),
		summary: z.string(),
		data: z.array(TickerJpyItemSchema),
		meta: z.object({ cache: z.object({ hit: z.boolean(), key: z.string() }).optional(), ts: z.string() }).passthrough(),
	}),
	FailResultSchema,
]);

// === Market Summary (tickers + volatility snapshot) ===
export const MarketSummaryItemSchema = z.object({
	pair: z.string(),
	last: z.number().nullable(),
	change24hPct: z.number().nullable().optional(),
	vol24h: z.number().nullable().optional(),
	rv_std_ann: z.number().nullable().optional(),
	vol_bucket: z.enum(['low', 'mid', 'high']).nullable().optional(),
	tags: z.array(z.string()).optional(),
});

export const MarketSummaryRanksSchema = z.object({
	topGainers: z.array(z.object({ pair: z.string(), change24hPct: z.number().nullable() })).optional(),
	topLosers: z.array(z.object({ pair: z.string(), change24hPct: z.number().nullable() })).optional(),
	topVolatility: z.array(z.object({ pair: z.string(), rv_std_ann: z.number().nullable() })).optional(),
});
