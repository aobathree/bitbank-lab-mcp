import { GetDepthOutputSchema } from '../src/schemas.js';
import { toNum } from './conversions.js';
import { estimateZones } from './depth-analysis.js';
import { formatSummary, formatTimestampJST } from './formatter.js';
import { BITBANK_API_BASE, DEFAULT_RETRIES, fetchJsonWithRateLimit } from './http.js';
import { isJpyPair, roundPrice } from './price.js';
import { fail, failFromError, failFromValidation, ok } from './result.js';
import { createMeta, ensurePair } from './validate.js';

export interface GetDepthOptions {
	timeoutMs?: number;
	maxLevels?: number;
}

export interface BuildDepthTextInput {
	timestamp: number;
	summary: string;
	bids: Array<[unknown, unknown]>;
	asks: Array<[unknown, unknown]>;
	mid: number | null;
}

/** テキスト組み立て（板データ表示）— テスト可能な純粋関数 */
export function buildDepthText(input: BuildDepthTextInput): string {
	const { timestamp, summary, bids, asks, mid } = input;
	const text = [
		`📸 ${formatTimestampJST(timestamp)}`,
		'',
		summary,
		`板の層数: 買い ${bids.length}層 / 売り ${asks.length}層`,
		mid ? `中値: ${mid.toLocaleString('ja-JP')}円` : '',
		'',
		`🟢 買い板 (全${bids.length}層):`,
		...bids.map(([p, s]: [unknown, unknown], i: number) => `  ${i + 1}. ${Number(p).toLocaleString('ja-JP')}円 ${s}`),
		'',
		`🔴 売り板 (全${asks.length}層):`,
		...asks.map(([p, s]: [unknown, unknown], i: number) => `  ${i + 1}. ${Number(p).toLocaleString('ja-JP')}円 ${s}`),
	]
		.filter(Boolean)
		.join('\n');

	return (
		text +
		`\n\n---\n📌 含まれるもの: 現時点の板（bid/ask全レベル）、壁ゾーン推定` +
		`\n📌 含まれないもの: 板の時系列変化、約定履歴、テクニカル指標、出来高フロー` +
		`\n📌 補完ツール: get_orderbook（分析モード付き板情報）, get_flow_metrics（出来高フロー）, get_transactions（約定履歴）`
	);
}

export default async function getDepth(pair: string, { timeoutMs = 3000, maxLevels = 200 }: GetDepthOptions = {}) {
	const chk = ensurePair(pair);
	if (!chk.ok) return failFromValidation(chk);

	const url = `${BITBANK_API_BASE}/${chk.pair}/depth`;
	try {
		const { data: json, rateLimit } = await fetchJsonWithRateLimit(url, { timeoutMs, retries: DEFAULT_RETRIES });
		const jsonObj = json as { success?: number; data?: Record<string, unknown> & { code?: number } };

		// 上流レスポンスの success フラグを明示的に検証する。
		// 公式 API は { success: 0|1, data: ... } 形式で、エラー時は success:0 を返す。
		// optional chaining のフォールバックに任せると空配列として握りつぶされ ok を返してしまう。
		if (jsonObj?.success !== 1) {
			const code = jsonObj?.data?.code;
			const codeStr = code != null ? `（code: ${code}）` : '';
			return GetDepthOutputSchema.parse(fail(`bitbank API がエラーを返却しました${codeStr}`, 'upstream'));
		}

		const d = jsonObj?.data ?? {};
		// 上流レスポンスに bids/asks が含まれない場合は upstream エラーとして明示分類する。
		// 空配列フォールバックで握りつぶすと downstream（prepare_depth_data, render_depth_svg）で
		// 「両側が必要」エラーになり、原因の特定が困難になる。get_orderbook と挙動を揃える。
		if (!Array.isArray(d.asks) || !Array.isArray(d.bids)) {
			return GetDepthOutputSchema.parse(fail('上流レスポンスに bids/asks が含まれていません', 'upstream'));
		}
		const asks = (d.asks as Array<[unknown, unknown]>).slice(0, maxLevels);
		const bids = (d.bids as Array<[unknown, unknown]>).slice(0, maxLevels);

		// 上流 timestamp は欠損したら Date.now() で偽装せず upstream fail に倒す。
		// 板スナップショットの timestamp は「上流が観測した時刻」が意味であり、
		// 受信時刻 (Date.now / fetchedAt) で代用すると古いデータをあたかも最新かのように
		// 見せてしまう。fetchedAt（受信時刻）は meta に別途含まれる。
		const tsNum = Number(d.timestamp ?? d.timestamp_ms);
		if (!Number.isFinite(tsNum) || tsNum <= 0) {
			return GetDepthOutputSchema.parse(fail('上流レスポンスに timestamp が含まれていません', 'upstream'));
		}

		// 簡易サマリ（最良気配と件数）。best 気配は finite な数値のみ採用する
		// （非数値の truthy 文字列が混じっても mid を NaN 化させず null に倒す）。
		const bestAsk = toNum(asks[0]?.[0]);
		const bestBid = toNum(bids[0]?.[0]);
		const mid = bestBid != null && bestAsk != null ? roundPrice((bestBid + bestAsk) / 2, isJpyPair(chk.pair)) : null;
		const summary = formatSummary({
			pair: chk.pair,
			latest: mid ?? undefined,
			extra: `levels: bids=${bids.length} asks=${asks.length}`,
		});

		const data = {
			asks,
			bids,
			asks_over: d.asks_over,
			asks_under: d.asks_under,
			bids_over: d.bids_over,
			bids_under: d.bids_under,
			ask_market: d.ask_market,
			bid_market: d.bid_market,
			timestamp: tsNum,
			sequenceId:
				d.sequenceId != null ? Number(d.sequenceId) : d.sequence_id != null ? Number(d.sequence_id) : undefined,
			overlays: {
				depth_zones: [
					...estimateZones(
						bids.slice(0, 50).map(([p, s]: [unknown, unknown]) => [Number(p), Number(s)] as [number, number]),
						'bid',
					),
					...estimateZones(
						asks.slice(0, 50).map(([p, s]: [unknown, unknown]) => [Number(p), Number(s)] as [number, number]),
						'ask',
					),
				],
			},
		};

		// タイムスタンプ付きテキスト出力（全板データを含める: LLM が structuredContent.data を読めない対策）
		const textWithBoundary = buildDepthText({ timestamp: data.timestamp, summary, bids, asks, mid });

		const meta = createMeta(chk.pair, rateLimit ? { rateLimit } : {});
		return GetDepthOutputSchema.parse(
			ok(textWithBoundary, data as Record<string, unknown>, meta as Record<string, unknown>),
		);
	} catch (err: unknown) {
		return failFromError(err, {
			schema: GetDepthOutputSchema,
			timeoutMs,
			defaultType: 'network',
			defaultMessage: 'ネットワークエラー',
		}) as ReturnType<typeof GetDepthOutputSchema.parse>;
	}
}
