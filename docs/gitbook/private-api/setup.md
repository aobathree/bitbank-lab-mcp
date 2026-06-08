---
description: API キーを設定して、資産確認・注文・ポートフォリオ分析を使えるようにする
---

# 概要とセットアップ

bitbank の Private API を使うと、自分の資産確認・注文操作・ポートフォリオ分析を AI から行えます。API キーの有無で、サーバーが公開する機能が自動的に切り替わります。

| 設定 | ツール数 | プロンプト数 | 使える機能 |
| --- | --- | --- | --- |
| キー未設定 | 32（Public のみ） | 8 | 価格取得・テクニカル分析・チャート生成・バックテスト |
| キー設定済み | 32 + 16 = **48** | 8 + 1 = **9** | 上記 + 資産確認・注文・ポートフォリオ分析 |

{% hint style="info" %}
キー未設定時、Private ツール・プロンプトは MCP クライアントに一切表示されません（エラーではなく、そもそも登録されません）。公開データの取得・分析だけなら設定不要です。
{% endhint %}

## 1. bitbank で API キーを発行

[bitbank 設定画面](https://app.bitbank.cc/account/api) で API キーを発行します。**必要最小限の権限のみ付与する**ことを強く推奨します（最小権限の原則）。

| やりたいこと | 必要な権限 |
| --- | --- |
| 資産確認・ポートフォリオ分析（読み取り専用） | **「参照」のみ** ← 最も安全、迷ったらこちら |
| 上記 + AI に発注・キャンセル操作も任せたい | 「参照」+「取引」 |

{% hint style="danger" %}
**「出金」権限は絶対に有効化しないでください。** 本 MCP サーバーは出金系ツールを実装していないため、この権限は一切不要です。漏洩時の資産流出を避けるためにも、必要最小限の権限のみを付与してください。
{% endhint %}

**IP 制限**: bitbank 側で API キーに IP 制限を設定できる場合は、自宅のグローバル IP などに制限することを推奨します。

## 2. API キーの渡し方

クライアントによって渡し方が異なります。

{% tabs %}
{% tab title="Claude Code / Gemini CLI" %}
Plugin install で導入した場合は、設定画面から `api_key` / `api_secret` を入力するだけです。

* **Claude Code**: `/plugin` の設定画面で入力 → OS のキーチェーンに保管
* **Gemini CLI**: `gemini-extension.json` の `settings` で対話的に入力 → `.env` に保管

詳細は [Plugin 導入](../getting-started/plugin-clients.md) を参照してください。
{% endtab %}

{% tab title="Claude Desktop（手動設定）" %}
`claude_desktop_config.json` の `env` ブロックに直接記入します。

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
{% endtab %}

{% tab title="Cursor / Codex（環境変数）" %}
シェルから環境変数を export してから起動します。`~/.zshrc` や `~/.bashrc` に書いておくと永続化されます。

```bash
export BITBANK_API_KEY="your_api_key"
export BITBANK_API_SECRET="your_api_secret"
```
{% endtab %}
{% endtabs %}

## 3. 有効化の確認

サーバー起動時のログに `Private API tools enabled` と表示されれば有効化されています。キー未設定時は `Private API tools disabled` と表示され、Private ツールはスキップされます。

{% hint style="warning" %}
`BITBANK_API_KEY` と `BITBANK_API_SECRET` の **両方** が設定されていないと Private ツールは有効になりません。片方だけでは表示されません。
{% endhint %}

## キー管理の責任範囲

| 責任 | 範囲 |
| --- | --- |
| MCP サーバー | API キーはメモリ上のみで保持。ログ・エラーメッセージへの漏洩を防止（テスト済み） |
| ユーザー | 環境変数の安全な管理。`.env` ファイルを使う場合は `.gitignore` に追加すること |
| bitbank | API キーの発行・無効化・IP 制限 |

## 次のステップ

* 取引がどう保護されているか → [取引の安全設計](safety.md)
* どんなツールが使えるか → [ツールと注文タイプ](tools.md)
