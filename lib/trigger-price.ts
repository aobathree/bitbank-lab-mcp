/**
 * stop / stop_limit 注文のトリガー価格バリデーション。
 *
 * 現在価格（/ticker）と照らして、トリガー到達済み（=即時発動）になる注文を
 * 発注前に検出する。preview_order での事前チェックと、create_order での
 * 軽量な再チェック（market データの変化に追従）で共有する。
 *
 * /ticker 取得失敗時は null（違反なし）を返して上位の発注処理は継続させる。
 * 最終的に bitbank 本 API 側で同等の検証が行われるため、フォールバックでも
 * ガードは失われない。
 */

import { toNum } from './conversions.js';
import { formatPrice } from './formatter.js';
import { BITBANK_API_BASE, fetchJson } from './http.js';

export async function validateTriggerPrice(
	pair: string,
	side: 'buy' | 'sell',
	triggerPrice: number,
): Promise<string | null> {
	try {
		const url = `${BITBANK_API_BASE}/${pair}/ticker`;
		const json = (await fetchJson(url, { timeoutMs: 5000 })) as {
			success?: number;
			data?: { last?: string };
		};
		if (json?.success !== 1 || !json.data?.last) return null;
		const currentPrice = toNum(json.data.last);
		if (currentPrice == null) return null;

		if (side === 'sell' && triggerPrice >= currentPrice) {
			return [
				`stop sell のトリガー価格（${formatPrice(triggerPrice)}）が現在価格（${formatPrice(currentPrice)}）以上のため、即時発動してしまいます。`,
				'stop sell は「価格がトリガー以下に下落したとき」に発動します（損切り用）。',
				'R1 上抜けで利確したい場合は limit sell を使用してください。',
			].join('\n');
		}

		if (side === 'buy' && triggerPrice <= currentPrice) {
			return [
				`stop buy のトリガー価格（${formatPrice(triggerPrice)}）が現在価格（${formatPrice(currentPrice)}）以下のため、即時発動してしまいます。`,
				'stop buy は「価格がトリガー以上に上昇したとき」に発動します（ブレイクアウト買い用）。',
				'指定価格以下で買いたい場合は limit buy を使用してください。',
			].join('\n');
		}
	} catch {
		return null;
	}
	return null;
}
