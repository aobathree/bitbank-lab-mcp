/**
 * get_orders_info — 複数注文の詳細を一括取得する Private API ツール。
 *
 * bitbank Private API `POST /v1/user/spot/orders_info` を呼び出し、
 * 指定した複数の注文IDの詳細情報を返す。
 *
 * ※ 約定・キャンセルから3ヶ月以上経過した注文は結果に含まれない（エラーにはならない）。
 */

import { nowIso, toIsoMs } from '../../lib/datetime.js';
import { formatPair, formatPrice } from '../../lib/formatter.js';
import { fail, ok, toStructured } from '../../lib/result.js';
import { getDefaultClient, PrivateApiError } from '../../src/private/client.js';
import type { OrderResponse } from '../../src/private/schemas.js';
import { GetOrdersInfoInputSchema, GetOrdersInfoOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

export default async function getOrdersInfo(args: { pair: string; order_ids: number[] }) {
	const { pair, order_ids } = args;
	const client = getDefaultClient();

	try {
		const rawData = await client.post<{ orders: OrderResponse[] }>('/v1/user/spot/orders_info', {
			pair,
			order_ids,
		});

		const timestamp = nowIso();
		const orders = rawData.orders;
		const isJpy = pair.includes('jpy');

		const lines: string[] = [];
		lines.push(`注文情報: ${formatPair(pair)} ${orders.length}件`);

		if (orders.length > 0) {
			lines.push('');
			for (const o of orders) {
				const sideLabel = o.side === 'buy' ? '買' : '売';
				const posLabel = o.position_side === 'long' ? 'long ' : o.position_side === 'short' ? 'short ' : '';
				const price = o.price ? (isJpy ? formatPrice(Number(o.price)) : o.price) : '成行';
				const amount = o.start_amount ?? o.executed_amount;
				lines.push(
					`#${o.order_id} ${posLabel}${sideLabel}${o.type} ${amount} @ ${price} [${o.status}] (${toIsoMs(o.ordered_at) ?? String(o.ordered_at)})`,
				);
			}
		}

		if (orders.length < order_ids.length) {
			lines.push('');
			lines.push(`※ ${order_ids.length - orders.length}件は3ヶ月以上前の注文のため取得できませんでした`);
		}

		const summary = lines.join('\n');

		return GetOrdersInfoOutputSchema.parse(
			ok(
				summary,
				{ orders, timestamp },
				{
					fetchedAt: timestamp,
					orderCount: orders.length,
					pair,
					...(client.lastRateLimit ? { rateLimit: client.lastRateLimit } : {}),
				},
			),
		);
	} catch (err) {
		if (err instanceof PrivateApiError) {
			return GetOrdersInfoOutputSchema.parse(fail(err.message, err.errorType));
		}
		return GetOrdersInfoOutputSchema.parse(
			fail(err instanceof Error ? err.message : '注文情報取得中に予期しないエラーが発生しました', 'upstream_error'),
		);
	}
}

export const toolDef: ToolDefinition = {
	name: 'get_orders_info',
	description:
		'[Orders Info / Bulk Order Status] 複数の注文IDの詳細情報を一括取得。ステータス・約定状況を一度に確認できる。Private API。',
	inputSchema: GetOrdersInfoInputSchema,
	handler: async (args) => {
		const result = await getOrdersInfo(args as { pair: string; order_ids: number[] });
		if (!result.ok) return result;
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
