/**
 * preview_cancel_order — 注文キャンセルのプレビューと確認トークン発行。
 *
 * キャンセル対象の注文情報を表示し、cancel_order に渡す確認トークンを発行する。
 * 実際のキャンセルは行わない。
 */

import { formatPair } from '../../lib/formatter.js';
import { ok, toStructured } from '../../lib/result.js';
import { generateToken } from '../../src/private/confirmation.js';
import { PreviewCancelOrderInputSchema, PreviewCancelOrderOutputSchema } from '../../src/private/schemas.js';
import type { ToolDefinition } from '../../src/tool-definition.js';

export default function previewCancelOrder(args: { pair: string; order_id: number }) {
	const { pair, order_id } = args;

	const tokenParams = { pair, order_id };
	const { token, expiresAt } = generateToken('cancel_order', tokenParams);

	const lines: string[] = [];
	lines.push(`📋 キャンセルプレビュー: ${formatPair(pair)}`);
	lines.push(`  注文ID: ${order_id}`);
	lines.push('');
	lines.push('⚠️ キャンセルを実行するには、返却された confirmation_token を cancel_order に渡してください。');

	const summary = lines.join('\n');

	return PreviewCancelOrderOutputSchema.parse(
		ok(
			summary,
			{ confirmation_token: token, expires_at: expiresAt, preview: { pair, order_id } },
			{ action: 'cancel_order' as const },
		),
	);
}

export const toolDef: ToolDefinition = {
	name: 'preview_cancel_order',
	description: [
		'[Preview Cancel Order] 注文キャンセルのプレビューと確認トークン発行。実際のキャンセルは行わない。Private API。',
		'cancel_order を実行するには、まずこのツールで確認トークンを取得する必要がある。',
	].join(' '),
	inputSchema: PreviewCancelOrderInputSchema,
	// MCP Apps (SEP-1865): 対応ホストでは iframe 内にキャンセル確認 UI を表示する。
	// 非対応ホストでは無視され、従来のテキスト確認フローがそのまま動作する（Progressive Enhancement）。
	_meta: {
		ui: {
			resourceUri: 'ui://cancel/confirm.html',
		},
	},
	handler: async (args) => {
		const result = previewCancelOrder(args as { pair: string; order_id: number });
		const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
		return {
			content: [{ type: 'text', text }],
			structuredContent: toStructured(result),
		};
	},
};
