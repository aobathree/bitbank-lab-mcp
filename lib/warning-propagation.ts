/**
 * 上流ツールから受け取った meta.warning（取得層）と meta.warnings（計算層）を
 * 下流ツールの summary / content に伝播するためのユーティリティ。
 *
 * 詳細は `.claude/rules/tools.md` の「上流 warning の伝播（加工ツール）」を参照。
 */

export type UpstreamWarningMeta = {
	/** 取得層の不完全性。partial fetch / multi-day 失敗 等。 */
	warning?: string;
	/** 計算層の不完全性。指標バー数不足 等。 */
	warnings?: string[];
};

export type PrependWarningsOptions = {
	/**
	 * warning 行と本文の間のセパレータ。
	 * - '\n\n'（デフォルト）: 空行を挟む（handler 系）。
	 * - '\n': 1 行で詰める（ツール本体の summary / content 系）。
	 */
	separator?: '\n' | '\n\n';
};

/** 1 行に対して `⚠️` プレフィックスが無ければ付与する。 */
function ensureWarnPrefix(line: string): string {
	return line.startsWith('⚠️') ? line : `⚠️ ${line}`;
}

/**
 * meta.warning（取得層）と meta.warnings（計算層）を本文の前に別行で連結する。
 * 両方とも空なら body をそのまま返す。
 *
 * warning は単一行でも改行入りでも対応する（行ごとに `⚠️` プレフィックスを付与する）。
 */
export function prependWarnings(
	body: string,
	meta: UpstreamWarningMeta | null | undefined,
	options: PrependWarningsOptions = {},
): string {
	const separator = options.separator ?? '\n\n';
	const lines: string[] = [];
	if (meta?.warning) {
		for (const line of meta.warning.split('\n')) {
			if (!line) continue;
			lines.push(ensureWarnPrefix(line));
		}
	}
	if (Array.isArray(meta?.warnings)) {
		for (const w of meta.warnings) {
			if (!w) continue;
			lines.push(ensureWarnPrefix(w));
		}
	}
	if (lines.length === 0) return body;
	return `${lines.join('\n')}${separator}${body}`;
}

/**
 * 単一 meta から warning（string）と warnings（string[]）を安全に取り出す。
 * 取り出した結果はそのまま下流 meta にスプレッドで載せられる形にする。
 */
export function extractUpstreamWarning(meta: unknown): UpstreamWarningMeta {
	if (!meta || typeof meta !== 'object') return {};
	const obj = meta as { warning?: unknown; warnings?: unknown };
	const out: UpstreamWarningMeta = {};
	if (typeof obj.warning === 'string' && obj.warning.length > 0) {
		out.warning = obj.warning;
	}
	if (Array.isArray(obj.warnings)) {
		const arr = obj.warnings.filter((w): w is string => typeof w === 'string' && w.length > 0);
		if (arr.length > 0) out.warnings = arr;
	}
	return out;
}

/**
 * 複数上流から取得層 warning を集約し、`[source] message` プレフィックス付きで
 * 改行連結した文字列を返す。すべて空なら undefined。
 *
 * 入力の `warning` は単一行でも改行入りでも対応する（split('\n') 後に
 * 既存の `⚠️` プレフィックスをトリムしてから `[source] ` を付与する）。
 */
export function collectUpstreamWarnings(sources: Array<{ source: string; warning?: string }>): string | undefined {
	const lines: string[] = [];
	for (const { source, warning } of sources) {
		if (!warning) continue;
		for (const raw of warning.split('\n')) {
			const trimmed = raw.replace(/^⚠️\s*/, '').trim();
			if (trimmed) lines.push(`[${source}] ${trimmed}`);
		}
	}
	return lines.length > 0 ? lines.join('\n') : undefined;
}
