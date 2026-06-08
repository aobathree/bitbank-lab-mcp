---
description: 手数料の3カテゴリ分類と、見積り（estimate）と実績（actual）のソースの違い
---

# 手数料の考え方

bitbank の手数料は **3カテゴリ** に分かれ、それぞれ **見積り（estimate）** と **実績（actual）** でソースが異なります。混同すると誤った発注見積りの原因になるため、本サーバーは厳密に分けて扱います。

## 3カテゴリ（taxonomy）

| | カテゴリ | 見積り（estimate）のソース | 実績（actual）のソース |
| --- | --- | --- | --- |
| **A** | 取引手数料 maker/taker | `/spot/pairs` の `taker/maker_fee_rate_quote` | 約定履歴の実額（`fee_amount_*`） |
| **B** | 信用 手数料 / 利息 | `/spot/pairs` の `margin_{open,close}_{maker,taker}_fee_rate_quote` | 約定履歴の実額（`fee` / `interest`） |
| **C** | 入出金 / 出金手数料 | API 値パススルー（`withdrawal_fee` 等） | 同左 |

## 見積り（estimate）

* **A / B** は `preview_order` が `/spot/pairs` のレートから算出します。
* **信用（B）** は `position_side` から **新規(open) / 決済(close)** を判定し、対応する `margin_*` レートを使います。
* 信用レートが API 未提供（`null`）の場合は公称 taker で概算し、「信用手数料率が API 未提供のため概算」と明示します。誤った確定値は出しません。

{% hint style="info" %}
**利息（interest）は見積りには含めません**（決済時に確定するため）。利息の実績は `get_margin_trade_history` の `interest` を参照してください。
{% endhint %}

## 実績（actual）

* `get_my_trade_history` / `get_margin_trade_history` / `analyze_my_portfolio` が、約定履歴の実額（手数料・利息を別建て）で計上します。
* 実績は見積りレートで上書きされません。

## 入出金手数料（C）

API が返す値をそのまま出力します（A / B の見積りロジックは通しません）。

## 関連ページ

* 発注の流れと安全設計 → [取引の安全設計](safety.md)
* 対応ツール・注文タイプ → [ツールと注文タイプ](tools.md)
