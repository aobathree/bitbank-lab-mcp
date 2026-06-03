/**
 * resolve_fee.ts - バックテスト手数料（taker レート）の動的解決。
 *
 * バックテストの片道手数料は従来ハードコードの 12bp（公称 taker）だったが、
 * 実測（taker 0.10% 等）とズレるため、未指定時は /spot/pairs の taker_fee_rate_quote を
 * lib/fees.ts 経由で解決し bp 換算して使う（カテゴリ A: 取引手数料、.claude/rules/fees.md）。
 *
 * 重要:
 *   - fee_bp が明示指定された場合は override 最優先で尊重する（pairs を引かない）。
 *   - 取得失敗 / ペア未発見 → 公称 12bp フォールバック。ネットワーク依存で機能を止めない。
 *   - 現行エンジンは t+1 open 執行 = taker 相当のため taker レートのみ動的化する。
 *
 * TODO(maker/taker 切替): 指値（limit）戦略では maker レートを使うべきだが、
 *   エンジンの執行モデルが taker 固定のため本タスクでは未対応。将来エンジンが
 *   maker 約定を表現できるようになったら feeRole / maker レートへ切り替える。
 */

import { getErrorMessage } from '../../../lib/error.js';
import { DEFAULT_TAKER_FALLBACK, resolveFeeRate } from '../../../lib/fees.js';
import { fetchPairsSpec } from '../../../lib/pairs.js';

/** 手数料率 → basis points への換算係数（率 × 10000 = bp）。 */
const BP_PER_RATE = 10000;

/**
 * pairs が引けないときの公称 taker 手数料（bp）。lib/fees.ts の率定数から導出する。
 * 浮動小数の桁あふれ（率 × 10000 が 11.9999… になる）を避けるため小数 4 桁で丸める。
 */
export const DEFAULT_FEE_BP = Number((DEFAULT_TAKER_FALLBACK * BP_PER_RATE).toFixed(4));

/**
 * 解決した手数料の由来。
 * - `explicit`: ユーザーが fee_bp を明示指定（override 最優先）。
 * - `dynamic`:  /spot/pairs の taker レートから解決。
 * - `fallback`: 取得失敗 / ペア未発見のため公称 12bp に落ちた。
 */
export type FeeSource = 'explicit' | 'dynamic' | 'fallback';

export interface ResolvedFee {
	/** 片道手数料（bp）。 */
	fee_bp: number;
	source: FeeSource;
	/** fallback 時のみ。content / summary 先頭に伝播する warning 文言。 */
	warning?: string;
}

/**
 * バックテストの片道手数料（bp）を解決する。
 *
 * @param pair          対象ペア（例: btc_jpy）。
 * @param explicitFeeBp ユーザー明示指定の fee_bp。指定があれば override 最優先で尊重する。
 *   未指定（undefined）のときのみ /spot/pairs から taker レートを解決する。
 */
export async function resolveBacktestFeeBp(pair: string, explicitFeeBp?: number): Promise<ResolvedFee> {
	// override 最優先。0 / 任意値もそのまま尊重する（既存バックテストの再現性のため）。
	if (explicitFeeBp != null) {
		return { fee_bp: explicitFeeBp, source: 'explicit' };
	}

	try {
		const pairsMap = await fetchPairsSpec();
		const spec = pairsMap.get(pair.toLowerCase());
		if (!spec) {
			return {
				fee_bp: DEFAULT_FEE_BP,
				source: 'fallback',
				warning: `手数料: ペア '${pair}' が /spot/pairs に見つからないため公称 ${DEFAULT_FEE_BP} bp で概算します。`,
			};
		}
		// taker レートを解決（spec の taker_fee_rate_quote 欠損時は lib/fees.ts が公称率に落とす）。
		const rate = resolveFeeRate(spec, 'taker');
		return { fee_bp: rate * BP_PER_RATE, source: 'dynamic' };
	} catch (err) {
		return {
			fee_bp: DEFAULT_FEE_BP,
			source: 'fallback',
			warning: `手数料: /spot/pairs 取得失敗のため公称 ${DEFAULT_FEE_BP} bp で概算します: ${getErrorMessage(err)}`,
		};
	}
}
