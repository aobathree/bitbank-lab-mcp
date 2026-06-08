---
description: bitbank の市場データと取引機能を生成AIから扱うためのMCPサーバー
---

※bitbank 非公式です

# はじめに

**bitbank-lab-mcp** は、bitbank（暗号資産取引所）の市場データと取引機能を、Claude Desktop / Cursor / Codex / Gemini CLI などの生成AIクライアントから扱えるようにする MCPサーバー です。

[![npm](https://img.shields.io/npm/v/bitbank-lab-mcp.svg)](https://www.npmjs.com/package/bitbank-lab-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/tjackiet/bitbank-genesis-mcp-server/blob/main/LICENSE)

## できること

bitbank の公開APIから取得した価格・板情報・約定履歴・ローソク足データを使い、AIが以下を実行できます。

* **市場データの取得** — リアルタイム価格 / 板情報 / 約定履歴 / ローソク足（1分足〜月足）
* **テクニカル分析** — SMA / RSI / ボリンジャーバンド / 一目均衡表 / MACD
* **フロー分析** — 買い/売りの勢い / CVD / スパイク検出
* **総合シグナル判定** — 複数指標を統合した強弱スコア
* **チャート可視化** — Claude.ai の Visualizer 用整形データ / SVG・PNG出力
* **資産確認・発注** — API キーを設定した場合のみ（preview → 確認 → 実行の2段階フロー）

## どこが違うのか

生データを渡すだけのMCPサーバーとは異なり、本サーバーは **指標計算・統合・整形までサーバー側で完了** したデータをLLMに渡します。LLMが自力で計算する必要がないため、ハルシネーション（計算ミス）を防ぎ、分析品質が安定します。

各ツールの説明文に「いつ使うべきか」「他ツールとの使い分け」を明示しているため、AIが自律的に適切なツールを選択できます。

## このドキュメントの読み方

{% hint style="info" %}
**対象読者**: bitbank で取引したことはあるが、AI連携・MCP は初めて、というレベルの方を想定しています。
{% endhint %}

まずは [クイックスタート（5分）](getting-started/quickstart.md) を順に読み進めてください。Claude Desktop で bitbank のデータをAIに分析させるところまで、5分程度で到達できます。各クライアント別の詳しい設定は [セットアップ詳細](getting-started/setup.md) にまとめています。

## 注意事項

{% hint style="warning" %}
本MCPサーバーが提供するデータをAIエージェントが処理した結果は、必ずしも正確性・完全性を保証するものではありません。提供される情報は情報提供のみを目的としており、投資助言・代理業に該当するものではありません。投資判断はご自身の責任で行ってください。
{% endhint %}
