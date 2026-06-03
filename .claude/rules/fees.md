# 手数料の取り扱いポリシー

bitbank の手数料は 3 カテゴリに分かれる。混同するとハルシネーション・誤発注見積りの原因になる。

## taxonomy（3 カテゴリ）

| | カテゴリ | 見積り（estimate）のソース | 実績（actual）のソース |
|---|---|---|---|
| **A** | 取引手数料 maker/taker | `GET /v1/spot/pairs` の `taker_fee_rate_quote` / `maker_fee_rate_quote` | `trade_history` の実額（`fee_amount_*`） |
| **B** | 信用 手数料 / 利息 | pairs の `margin_{open,close}_{maker,taker}_fee_rate_quote` | `trade_history` の実額（`fee` / `interest`） |
| **C** | 入出金 / 出金手数料 | API 値パススルー（`withdrawal_fee` 等） | 同左 |

## ルール

- **A / B の見積りは必ず `lib/fees.ts` 経由**で解決する。
  - 率の解決: `resolveFeeRate(spec, role, override?)`
  - 注文 1 件の見積り: `estimateOrderFee(spec, order)`
  - role 判定: `feeRole(type, postOnly?)`
- **C はパススルー**。API が返す値をそのまま出力する。A と混同して `lib/fees.ts` に通さない。
- **実績側は変更しない**。`portfolio/calc.ts` / `get_my_trade_history` 等は既に実額で正しい。

## 禁止事項（banned-patterns で機械検出）

`.claude/hooks/post-ts-lint.sh` の Phase 4 が以下を検出する（除外: `lib/fees.ts` / `tests/` / 行末 `// allow-fee`）。

- 取引手数料定数 `0.0012` のハードコード。フォールバックは `DEFAULT_TAKER_FALLBACK` を使う。
- `*_fee_rate_quote` を `Number()` / `parseFloat()` で直接 parse、または `||` で処理する記述。
  - **必ず `??`（null 合体）を使う**。`||` は campaign の `0` を fallback に化けさせる。
  - **クランプ禁止**（`Math.max(0, …)`）。負の maker リベートをそのまま扱う。
