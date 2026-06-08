---
description: Cursor / Windsurf など汎用 MCP クライアントに手動で登録する手順
---

# その他の MCP クライアント

Plugin install を使わず、設定ファイルに手動で追記して登録する方法です。

## Cursor（`.cursor/mcp.json`）

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

API キーが不要な場合は `env` ブロックごと削除して構いません。

## Claude Code（CLI から登録する場合）

[Plugin 導入](plugin-clients.md) を推奨しますが、CLI から手動登録する場合は次のコマンドを使います。

```bash
claude mcp add --transport stdio bitbank-lab -- npx -y bitbank-lab-mcp
```

## Windsurf / その他の汎用 MCP クライアント

Cursor と同じ JSON 形式で登録できます。クライアント固有の設定ファイルのパスについては、各クライアントのドキュメントを参照してください。

```json
{
  "mcpServers": {
    "bitbank-lab": {
      "command": "npx",
      "args": ["-y", "bitbank-lab-mcp"]
    }
  }
}
```

{% hint style="info" %}
MCP Inspector で動作確認したい場合は次のコマンドで起動できます。

```bash
npx @modelcontextprotocol/inspector -- npx -y bitbank-lab-mcp
```
{% endhint %}
