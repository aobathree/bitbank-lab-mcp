---
globs: tools/**/*.ts, src/handlers/**/*.ts, src/tool-registry.ts, src/private/**/*.ts
---

# MCP ツール追加・修正

ツールは `toolDef` エクスポート → `src/tool-registry.ts` が集約 → `src/server.ts` が自動登録。
**server.ts を直接編集する必要はない。**

> 手数料を扱うツールは `.claude/rules/fees.md`（A/B 見積り=`lib/fees.ts` 経由必須、C=パススルー）に従う。

## content テキストにデータを含める（重要）

LLM は `structuredContent` を参照できない。`content[0].text` だけが LLM に見える。
`ok(summary, data, meta)` をそのまま返すと `toToolResult`（`src/server.ts`）が `summary` 一行だけを `content` に入れるため、LLM はデータを一切受け取れずハルシネーションを起こす。

**対策**: handler で `content` テキストにデータを明示的に含める。

```ts
// NG: LLM には summary しか見えない
handler: async (args) => myTool(args),

// OK: content にデータを含める（get_candles, prepare_chart_data 等と同じパターン）
handler: async (args) => {
  const result = await myTool(args);
  if (!result.ok) return result;
  const text = `${result.summary}\n${JSON.stringify(result.data, null, 2)}`;
  return {
    content: [{ type: 'text', text }],
    structuredContent: result as unknown as Record<string, unknown>,
  };
},
```

新規ツール作成・既存ツール修正時は、LLM が受け取る `content` テキストに十分な情報が含まれているか必ず確認する。

## 上流 warning の伝播（加工ツール）

`get_candles` → `analyze_indicators` → `prepare_chart_data` のように上流ツールの結果を加工する
ツールでは、上流 `meta.warning` / `meta.warnings` を必ず content / summary 先頭に連結する。
これを落とすと LLM がデータ不完全性に気づけずハルシネーションを起こす。

実装は **`lib/warning-propagation.ts`**（`prependWarnings`, `extractUpstreamWarning`, `collectUpstreamWarnings`）を使う。
横展開の確認は `tests/warning-propagation.test.ts` および加工ツールの handler テストを参照。

- **`meta.warning`（string）**: 取得層の不完全性（partial fetch / multi-day 失敗 等）。
- **`meta.warnings`（string[]）**: 計算層の不完全性（指標バー数不足 等）。
- 2 系統は混ぜず、別フィールドかつ別行で出す。

```ts
import { extractUpstreamWarning, prependWarnings } from '../lib/warning-propagation.js';

const upstream = extractUpstreamWarning(res.meta);
const summary = prependWarnings(baseSummary, upstream, { separator: '\n' });
```

### キャッシュ層を持つツールの注意

`analyze_indicators` のように結果をキャッシュするツールは、**上流 warning も cache entry に保存する。**
落とすと 2 回目以降のキャッシュヒットで warning が消える（partial fetch 状態を引きずる）。

### handler 側のチェックリスト

- [ ] `handler` で `res.summary` を差し替える場合、default view でも LLM 必須フィールド
      （window / 期間 / warning / warnings）を落とさない。
- [ ] `content[0].text` の先頭に warning 行が含まれているか目視確認。
- [ ] `JSON.stringify(data)` を含める場合は **JSON より前** に warning 行を出す。
- [ ] 加工ツールの場合、`view=items` 等の代替ビューでも warning 行が消えないようにする。

## Public ツール

認証不要。誰でも利用可能。

### 新規追加

1. `tools/<name>.ts` に `export const toolDef: ToolDefinition = { name, description, inputSchema, handler }`
   - ハンドラが100行超なら `src/handlers/<name>Handler.ts` に分離
2. `src/tool-registry.ts` の `allToolDefs` 配列に追加
3. `npm run gen:types && npm run typecheck`

### 既存修正

`tools/<name>.ts` か `src/handlers/<name>Handler.ts` の `toolDef` を編集するだけ。

## Private ツール

bitbank API キー（`BITBANK_API_KEY` + `BITBANK_API_SECRET`）が設定されている場合のみ有効化される。

### 仕組み

- `src/private/config.ts` の `isPrivateApiEnabled()` で環境変数の有無を判定
- `src/tool-registry.ts` が条件付きで `tools/private/*.ts` を動的 import し `allToolDefs` に追加
- キー未設定時はスキップされ、ログに `Private API tools disabled` と記録される

### 新規追加

1. `tools/private/<name>.ts` に `export const toolDef` を定義
   - ハンドラが100行超なら `src/handlers/<name>Handler.ts` に分離
   - HTTP 呼び出しは `src/private/client.ts` の `BitbankPrivateClient` を使う
2. 入出力スキーマは `src/private/schemas.ts` に追加
3. `src/tool-registry.ts` の `isPrivateApiEnabled()` ブロック内で動的 import → `allToolDefs.push`
4. `npm run gen:types && npm run typecheck`

### 既存修正

`tools/private/<name>.ts` か `src/handlers/<name>Handler.ts` の `toolDef` を編集するだけ。
