# Private API ガイド

bitbank の Private API を使って、自分の資産確認・注文操作・ポートフォリオ分析を行うためのガイドです。

## セットアップ

### 1. bitbank で API キーを発行

[bitbank 設定画面](https://app.bitbank.cc/account/api) で API キーを発行してください。**必要最小限の権限のみ付与する**ことを強く推奨します（最小権限の原則）。

| やりたいこと | 必要な権限 |
|---|---|
| 資産確認・ポートフォリオ分析（読み取り専用） | **「参照」のみ** ← 最も安全、迷ったらこちら |
| 上記 + AI に発注・キャンセル操作も任せたい | 「参照」+「取引」 |

- ⚠️ **「出金」権限は絶対に有効化しないでください**。本 MCP サーバーは出金系ツールを実装していないため、この権限を付ける必要は一切ありません。漏洩時の資産流出を避けるためです。
- **IP 制限**: bitbank 側で API キーに IP 制限を設定できる場合は、可能な限り設定を推奨します。

### 2. API キーの渡し方

クライアントによって渡し方が異なります。

#### Claude Code（Plugin install 推奨）

`/plugin install` で導入した場合は、`/plugin` の設定画面から `api_key` / `api_secret` を入力するだけで OK です。OS のキーチェーンに保管されます（手動で env を書く必要はありません）。

#### Gemini CLI（Plugin install 推奨）

`gemini-extension.json` の `settings` で対話的に入力すれば `.env` ファイルに保管されます。

#### Claude Desktop（手動設定）

`claude_desktop_config.json` の `env` ブロックに直接記入します:

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"],
      "env": {
        "BITBANK_API_KEY": "your_api_key",
        "BITBANK_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

設定後、Claude Desktop を `Cmd+Q`（Windows は完全終了）で再起動してください。

#### Cursor / Codex（シェル環境変数）

シェルから環境変数を export してから起動します。`~/.zshrc` や `~/.bashrc` に書いておくと永続化されます。

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```

#### 開発時（CLI から直接起動）

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
npx -y bitbank-lab-mcp
```

### 3. 確認

サーバー起動時のログに `Private API tools enabled` と表示されれば有効化されています。
キー未設定時は `Private API tools disabled` と表示され、Private ツールはスキップされます。

## キー管理の責任範囲

| 責任 | 範囲 |
|---|---|
| MCP サーバー | API キーはメモリ上のみで保持。ログ・エラーメッセージへの漏洩を防止（テスト済み） |
| ユーザー | 環境変数の安全な管理。`.env` ファイルを使う場合は `.gitignore` に追加すること |
| bitbank | API キーの発行・無効化・IP 制限 |

## 安全設計

### 入力バリデーション

- Zod スキーマによるパラメータの型・範囲チェック
- 注文タイプ別の必須パラメータ検証（limit → price 必須 等）
- stop 注文のトリガー価格妥当性チェック（即時発動の防止）

### 確認フロー（HITL: Human-in-the-Loop）

取引操作（発注・キャンセル）は **2ステップ確認** が必須です:

```
1. preview_order      → 注文内容を表示 + 確認トークン発行
2. create_order       → 確認トークンを検証 → 実行
```

- 確認トークンは HMAC-SHA256 で生成（`BITBANK_API_SECRET` を鍵に使用）
- 有効期限: 60秒（`ORDER_CONFIRM_TTL_MS` で変更可能）
- パラメータ改ざんを検知（トークン生成時と実行時のパラメータが一致しない場合は拒否）
- キャンセルにも同様の確認フローを適用（`preview_cancel_order` / `preview_cancel_orders`）

### 監査ログ

- 取引操作は専用カテゴリ `trade_action` でログに記録
- チェーンハッシュ（SHA-256）でログの改ざんを検知可能
- `scripts/verify_log_integrity.ts` でチェーンハッシュの整合性を検証

### エラーハンドリング（クレデンシャル漏洩防止）

- 認証エラー（20001〜20005）は静的メッセージを返し、レスポンスボディをエコーしない
- Private API クライアント（`src/private/client.ts`）は `PrivateApiError` に分類し、bitbank の JSON 本文をそのままユーザー向けメッセージに載せない設計（認証・レート制限・HTTP 401/403 は固定文言）
- 予期しない例外のメッセージは `fail()` / `failFromError()` 経由で `Error.message` 等に依存するが、**現状コードベースでは「200 文字への一律切り詰め」は実装していない**（将来追加する場合は `lib/error.ts` または `failFromError` 側の集約が望ましい）
- HTTP 401/403 でも API キーを露出しない
- ログへのクレデンシャル混入防止テスト済み

## 対応ツール一覧

### 参照系（「参照」権限のみで使える、副作用なし）

| ツール | 説明 |
|---|---|
| `get_my_assets` | 保有資産一覧（JPY 評価額付き） |
| `get_my_trade_history` | 約定履歴（全ペア or 指定ペア） |
| `get_my_orders` | 注文一覧（アクティブ注文） |
| `get_order` | 注文照会（単一） |
| `get_orders_info` | 注文照会（複数） |
| `analyze_my_portfolio` | ポートフォリオ損益分析 |
| `get_my_deposit_withdrawal` | 入出金履歴 |
| `get_margin_status` | 信用取引ステータス（保証金・ロスカット率・新規建て可能額） |
| `get_margin_positions` | 信用建玉一覧（追証・不足金アラート付き） |
| `get_margin_trade_history` | 信用約定履歴（新規建て・決済、実現損益・利息を含む） |

### 取引系（「取引」権限が必要、2ステップ確認必須）

| ステップ 1 (Preview) | ステップ 2 (Execute) | 説明 |
|---|---|---|
| `preview_order` | `create_order` | 注文の発注（現物・信用） |
| `preview_cancel_order` | `cancel_order` | 注文キャンセル（単一） |
| `preview_cancel_orders` | `cancel_orders` | 注文キャンセル（一括、最大30件） |

### 信用取引について

`preview_order` / `create_order` に `position_side`（`long` / `short`）を指定すると信用注文として扱われます。

| 操作 | side | position_side |
|---|---|---|
| ロング新規建て | `buy` | `long` |
| ロング決済 | `sell` | `long` |
| ショート新規建て | `sell` | `short` |
| ショート決済 | `buy` | `short` |

**注意事項**:
- 信用取引には bitbank での申込・審査が必要です（未審査の場合はエラーコード 50058）
- 損失が保証金を超える可能性があります
- 利息・手数料は決済時に徴収されます
- 建玉管理は平均法（加重平均）で行われます

## 制限事項

- bitbank API のレート制限に従う（429 エラー時は自動リトライ）
- 注文の最小/最大数量は bitbank の仕様に準拠
- 信用取引のリアルタイム通知（ストリーム）は未対応

## トラブルシューティング

**Q. Private ツールが表示されない**
→ `BITBANK_API_KEY` と `BITBANK_API_SECRET` の両方が設定されているか確認。片方だけでは有効化されません。

**Q. 認証エラーが出る**
→ bitbank 設定画面で以下を確認してください:
- API キーの**有効期限**が切れていないか
- **権限**が用途に足りているか — 参照系ツール（`get_my_assets` 等）には「参照」、取引系ツール（`create_order` 等）には「参照」+「取引」が必要
- **IP 制限**を設定している場合、現在の IP からアクセスできるか

**Q. 確認トークンの有効期限が切れる**
→ デフォルト 60 秒です。`ORDER_CONFIRM_TTL_MS` 環境変数で調整できます（ミリ秒単位）。
