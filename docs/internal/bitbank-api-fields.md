# bitbank Private REST API フィールド一覧（社内一次ソース）

bitbank Private API（`/v1/user/*`）レスポンスの実フィールドを、**公式 docs を ground truth**
として逐語転記し、コード（Raw 型・Zod スキーマ・フィクスチャ）との照合に使う社内一次ソース。

## なぜこの doc が必要か

- サンドボックスからは `api.bitbank.cc` / `github.com`（公式 docs）が **ネットワーク allowlist 外**で、
  P4「外部 API 契約整合」診断を verbatim 実行できない。本ミラーがあれば診断をオフラインで完結でき、
  結果が「要追加確認」に落ちない。
- 過去に `get_margin_status` が実在しないフィールド（`losscut_rate` 等）を参照し、本番で
  `undefined%` / `NaN円` を出すバグがあった。ユニットテストはフィクスチャがコードに合わせて
  作られていたため緑だった（自己整合テスト）。**フィールド一覧をコードと独立した一次ソースに
  固定**することで、この種のドリフトを照合で検知できるようにする。
- 同種の潜在リスクとして `get_my_assets` 系のフィクスチャ・型が実 API の 3 フィールド
  （`withdrawing_amount` / `network_list` / `collateral_ratio`）を欠いていた（本 doc 作成の契機）。

> 暦日・タイムゾーン仕様（Public `/candlestick`）の一次ソースは姉妹 doc
> [`bitbank-candle-tz.md`](./bitbank-candle-tz.md) を参照。

## 出典・照合条件

| 項目 | 値 |
|---|---|
| ground truth | 公式 `bitbankinc/bitbank-api-docs` `rest-api_JP.md`（英語版 `rest-api.md` で相互確認） |
| 取得方法 | 公式 docs を逐語転記（行番号は JP 版に対応） |
| 照合日 | 2026-06-08 (JST) |
| 照合方法 | P4「外部 API 契約整合」診断（docs のフィールド/パラメータを実コードに逐語照合） |
| 対象コード | `src/handlers/portfolio/types.ts`（Raw 型）, `src/private/schemas.ts`（Zod）, `tools/private/*.ts` |

確度の凡例: **verbatim** = JSON 例まで逐語確認 / **確認済** = フィールド存在をコードと突合済。

---

## `/v1/user/assets`（資産情報）

`assets[]` の各要素。**暗号資産と jpy で `withdrawal_fee` の構造が異なり、jpy は `network_list` を持たない。**

| フィールド | 型 | 備考 | 公式 docs 行 |
|---|---|---|---|
| `asset` | string | 通貨コード | |
| `free_amount` | string | 利用可能数量 | |
| `amount_precision` | number | 数量精度 | |
| `onhand_amount` | string | 保有数量（評価額計算はこれ × ticker） | |
| `locked_amount` | string | ロック中数量 | |
| `withdrawing_amount` | string | 出金処理中の数量 | `:204` |
| `withdrawal_fee` | `{min,max}`（暗号資産）<br>`{under,over,threshold}`（jpy） | 出金手数料。**カテゴリ C: パススルー**（`lib/fees.ts` を通さない） | `:205`（JSON 例 `:243-275`） |
| `stop_deposit` | boolean | 入金停止フラグ（全ネットワーク） | |
| `stop_withdrawal` | boolean | 出金停止フラグ（全ネットワーク） | |
| `network_list` | `Array<{asset, network, stop_deposit, stop_withdrawal, withdrawal_fee:string}>` または undefined | ネットワーク別の入出金設定。**jpy では undefined（フィールド自体が無い）** | `:208` |
| `collateral_ratio` | string | 代用掛け目（信用取引の担保評価率） | `:209` |

### 公式 JSON 例（verbatim, `:243-275`）

```json
{
  "success": 1,
  "data": {
    "assets": [
      {
        "asset": "string",
        "free_amount": "string",
        "amount_precision": 0,
        "onhand_amount": "string",
        "locked_amount": "string",
        "withdrawing_amount": "string",
        "withdrawal_fee": { "min": "string", "max": "string" },
        "stop_deposit": false,
        "stop_withdrawal": false,
        "network_list": [
          {
            "asset": "string",
            "network": "string",
            "stop_deposit": false,
            "stop_withdrawal": false,
            "withdrawal_fee": "string"
          }
        ],
        "collateral_ratio": "string"
      },
      {
        "asset": "jpy",
        "free_amount": "string",
        "amount_precision": 0,
        "onhand_amount": "string",
        "locked_amount": "string",
        "withdrawing_amount": "string",
        "withdrawal_fee": { "under": "string", "over": "string", "threshold": "string" },
        "stop_deposit": false,
        "stop_withdrawal": false,
        "collateral_ratio": "string"
      }
    ]
  }
}
```

### コード対応

- Raw 型（単一ソース）: `src/handlers/portfolio/types.ts` `RawAsset`
  （`tools/private/get_my_assets.ts` と `analyzeMyPortfolioHandler.ts` が共有）
- 出力スキーマ: `src/private/schemas.ts` `GetMyAssetsDataSchema` / `AssetItemSchema`
- フィクスチャ: `tests/fixtures/private-api.ts` `rawAssetsResponse`
- **出力には現状 `asset` / `amount` / `available_amount` / `locked_amount` / `jpy_value` / `allocation_pct`
  のみを露出**（評価額は `onhand_amount` × ticker で算出済みで正しい）。`withdrawing_amount` /
  `network_list` / `collateral_ratio` は Raw 型・フィクスチャでは保持するが出力には含めない。
  信用担保評価のユースケースが生じた場合は `collateral_ratio` を `GetMyAssetsOutputSchema` に追加して露出する。

---

## `/v1/user/margin/status`（信用取引ステータス）

確度: **高**（コード一致確認済）。`src/private/schemas.ts` `GetMarginStatusDataSchema` と逐語一致。

`status`, `total_margin_balance`, `total_margin_balance_percentage`, `margin_position_profit_loss`,
`unrealized_cost`, `total_margin_position_product`, `open_margin_position_product`,
`open_margin_order_product`, `total_position_maintenance_margin`,
`total_long_position_maintenance_margin`, `total_short_position_maintenance_margin`,
`total_open_order_maintenance_margin`, `total_long_open_order_maintenance_margin`,
`total_short_open_order_maintenance_margin`, `margin_call_percentage`, `losscut_percentage`,
`buy_credit`, `sell_credit`, `available_balances[{pair, long, short}]`。

- **`losscut_rate` 等の幻フィールドは存在しない**（過去バグの再発防止チェックポイント）。
  強制決済率は `losscut_percentage`、保証金率は `total_margin_balance_percentage`。
- `*_percentage` 系は建玉なし時に `null`（schema は `.nullable()`）。

## `/v1/user/margin/positions`（信用建玉）

確度: **全フィールド存在確認済**。`GetMarginPositionsDataSchema` と一致。

- `notice` `{what, occurred_at, amount, due_date_at}` または null
- `payables` `{amount}`
- `positions[]` `{pair, position_side, open_amount, product, average_price, unrealized_fee_amount, unrealized_interest_amount}`
- `losscut_threshold` `{individual, company}`

## `/v1/user/spot/active_orders`（アクティブ注文）

確度: **全フィールド存在確認済**。

`orders[]` `{order_id, pair, side, position_side?, type, start_amount, remaining_amount,
executed_amount, price, post_only, user_cancelable, average_price, ordered_at, expire_at,
triggered_at, trigger_price, status}`。

## `/v1/user/spot/order`（注文照会・単一）

確度: **確認済**。`active_orders` と同じ注文オブジェクト ＋ `canceled_at`。

## `/v1/user/spot/trade_history`（約定履歴）

確度: **verbatim**（`:939-990`）。`GetMyTradeHistoryDataSchema` / `RawTrade` / `RawMarginTrade` と一致。

`trades[]` `{trade_id, pair, order_id, side, position_side（信用のみ）, type, amount, price,
maker_taker, fee_amount_base, fee_amount_quote, fee_occurred_amount_quote,
profit_loss（信用のみ）, interest（信用のみ）, executed_at}`。

- 現物約定では `position_side` / `profit_loss` / `interest` は通常 undefined。
- 実績手数料・利息はここ（`fee_occurred_amount_quote` + `interest`）が正。見積りは `lib/fees.ts`。

## `/v1/user/deposit_history`（入金履歴）

確度: **params verbatim**（`:1010-1013`）。

- パラメータ: `asset`, `count`（≤100）, `since`（ms）, `end`（ms）
- `deposits[]` `{uuid, asset, network?, amount, txid?, status, found_at, confirmed_at}`

## `/v1/user/withdrawal_history`（出金履歴）

確度: **params + 禁止項目 verbatim**（`:1497-1521`）。

- パラメータ: `asset`, `count`, `since`, `end`
- `withdrawals[]` `{uuid, asset, amount, fee?, network?, txid?, label?, address?, bank_name?,
  （法定のみ）account_uuid / branch_name / account_type / account_number / account_owner,
  status, requested_at}`

---

## 機密フィールドの取り扱い（出力から除外必須）

実 API は出金履歴で以下を返すが、**ツール出力に含めてはならない**（`.claude/rules/sensitive-data.md`）。
現状の `get_my_deposit_withdrawal` は出力マッピングに含めず正しく除外している。**回帰させないこと。**

- `account_number`（銀行口座番号）
- `account_owner`（口座名義）
- `branch_name`（支店名）
- `account_type`（口座種別）
- `account_uuid`（口座 UUID）

`/v1/user/assets` の 3 フィールド（`withdrawing_amount` / `network_list` / `collateral_ratio`）は
**公開資産メタデータであり機密ではない**。上記の禁止フィールドとは無関係で、出力に含めても問題ない
（本タスクでは最小対応として Raw 型・フィクスチャの同期に留め、出力露出は見送り）。

## 関連

- 公式 docs: <https://github.com/bitbankinc/bitbank-api-docs/blob/master/rest-api_JP.md>（英語版 `rest-api.md`）
- 姉妹 doc（暦日・TZ 実測）: [`bitbank-candle-tz.md`](./bitbank-candle-tz.md)
- Raw 型: `src/handlers/portfolio/types.ts`
- Zod スキーマ（単一ソース）: `src/private/schemas.ts`
- フィクスチャ: `tests/fixtures/private-api.ts`
- 手数料カテゴリ（A/B 見積り=`lib/fees.ts`, C=パススルー）: `.claude/rules/fees.md`
