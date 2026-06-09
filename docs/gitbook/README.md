---
description: bitbank の市場データと取引機能を生成AIから扱う — MCPサーバーと CLI のドキュメント
---

※bitbank 非公式です

# はじめに

このドキュメントは、bitbank（暗号資産取引所）の市場データと取引機能を生成AIから扱うための **2つの姉妹プロジェクト** を扱います。どちらも bitbank の公開 API を基盤としていますが、アプローチが真逆です。

* **MCP サーバー（bitbank-lab-mcp）** — Claude Desktop / Cursor / Codex / Gemini CLI などの生成AIクライアントから使う MCPサーバー。
* **CLI（bitbank-cli-skills）** — コマンドラインから bitbank API を高速に扱うスキル集。

[![npm](https://img.shields.io/npm/v/bitbank-lab-mcp.svg)](https://www.npmjs.com/package/bitbank-lab-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://github.com/tjackiet/bitbank-genesis-mcp-server/blob/main/LICENSE)

{% hint style="info" %}
両プロジェクトとも bitbank の**公開 API** を基盤としています。API 自体の仕様（エンドポイント・パラメータ・レート制限など）は [bitbank API ドキュメント](https://github.com/bitbankinc/bitbank-api-docs) を参照してください。
{% endhint %}

## MCP サーバーと CLI — どちらが自分に向いている？

同じ bitbank API に対して、2つは **真逆のアプローチ** をとります。

|  | MCP サーバー | CLI |
| --- | --- | --- |
| 計算する場所 | **サーバー側で計算済みの結論**を LLM に渡す | **生データを高速取得**し、LLM 自身に計算させる |
| 向いている人 | すぐに使えるテクニカル分析・可視化が欲しい | 指標のパラメータやロジックを完全にカスタマイズしたい |
| ハルシネーション | 計算をサーバーが担うため起きにくい | LLM の計算精度に依存する |
| 主な使い方 | AIクライアントに自然文で質問 | コマンド／スキルを組み合わせて操作 |

{% hint style="success" %}
迷ったら **MCP サーバー** から始めるのがおすすめです。インストール不要で、設定ファイルに数行追記するだけで動きます。
{% endhint %}

## できること（MCP サーバー）

bitbank の公開APIから取得した価格・板情報・約定履歴・ローソク足データを使い、AIが以下を実行できます。

* **市場データの取得** — リアルタイム価格 / 板情報 / 約定履歴 / ローソク足（1分足〜月足）
* **テクニカル分析** — SMA / RSI / ボリンジャーバンド / 一目均衡表 / MACD
* **フロー分析** — 買い/売りの勢い / CVD / スパイク検出
* **総合シグナル判定** — 複数指標を統合した強弱スコア
* **チャート可視化** — Claude.ai の Visualizer 用整形データ / SVG・PNG出力
* **資産確認・発注** — API キーを設定した場合のみ（preview → 確認 → 実行の2段階フロー）

生データを渡すだけのMCPサーバーとは異なり、本サーバーは **指標計算・統合・整形までサーバー側で完了** したデータをLLMに渡します。LLMが自力で計算する必要がないため、ハルシネーション（計算ミス）を防ぎ、分析品質が安定します。

## このドキュメントの読み方

{% hint style="info" %}
**対象読者**: bitbank で取引したことはあるが、AI連携・MCP は初めて、というレベルの方を想定しています。
{% endhint %}

* **MCP サーバーを使う** → [クイックスタート（5分）](getting-started/quickstart.md) から読み進めてください。Claude Desktop で bitbank のデータをAIに分析させるところまで5分程度で到達できます。各クライアント別の詳しい設定は [セットアップ詳細](getting-started/setup.md) にまとめています。
* **CLI を使う** → [CLI のはじめに](cli/README.md) から読み進めてください。コマンドラインから bitbank API を高速に扱い、計算は LLM 自身に任せたい方向けです。

## 注意事項

{% hint style="warning" %}
本ドキュメントが扱うツールが提供するデータをAIエージェントが処理した結果は、必ずしも正確性・完全性を保証するものではありません。提供される情報は情報提供のみを目的としており、投資助言・代理業に該当するものではありません。投資判断はご自身の責任で行ってください。
{% endhint %}
