/**
 * bitbank エラーコード → ユーザー向けメッセージのマッピング。
 *
 * `src/private/client.ts` の classifyBitbankError と各 Private ツールが共通参照することで、
 * 同じエラーコードに対する LLM 向け文言を統一する。
 *
 * 認証エラー（20001–20005）/ レート制限（10009）/ メンテナンス（10007, 10008）は
 * client.ts 側の分類ロジックで個別に文言が決まるため、ここでは登録しない。
 *
 * @see https://github.com/bitbankinc/bitbank-api-docs/blob/master/errors.md
 */

const BITBANK_ERROR_MESSAGES: Record<number, string> = {
	50009: '指定された注文が見つかりません（3ヶ月以上前の注文は参照不可）',
};

/**
 * bitbank エラーコードに対応するユーザー向けメッセージを取得する。
 * 未登録のコードや非数値入力は undefined を返し、呼び出し側でフォールバックさせる。
 */
export function getBitbankErrorMessage(code: string | number): string | undefined {
	const numeric = typeof code === 'number' ? code : Number(code);
	if (!Number.isInteger(numeric)) return undefined;
	return BITBANK_ERROR_MESSAGES[numeric];
}
