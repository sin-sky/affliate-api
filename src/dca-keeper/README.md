# DCA Keeper (積立トリガー) — 設計 + 実装スケッチ

> ⚠️ 現状 `affliate-api` は NestJS scaffold 未作成 (空リポ)。本ディレクトリは **build 検証未実施の
> 実装スケッチ**。NestJS プロジェクト初期化後にそのまま組み込める構成にしてある。実 broadcast は人間。

## これは何か

on-chain の `DCAScheduler`(sixx-vault/src/periphery/DCAScheduler.sol)を期日ごとに叩く
オフチェーン cron。**資金は一切保持・移動しない**。「execute を呼ぶだけ」で、金額・上限・宛先・周期
の強制はすべてコントラクト側。keeper EOA が漏洩しても盗めるものは無い(execute はユーザー本人の
vault ポジションにしか入金できない=非カストディ)。

## 構成

| ファイル | 役割 |
|---|---|
| `dca-keeper.service.ts` | `@Cron` で**毎時**（05分）due プランを集めて `executeBatch` を呼ぶ。冪等・リトライ・監視。 |
| `dca-keeper.module.ts` | NestJS module。`ScheduleModule.forRoot()` と併せて `AppModule` に import。 |
| `dca-scheduler.abi.ts` | keeper が使う最小 ABI(手書き)。 |

## 導入手順(NestJS scaffold 後)

```bash
npm i @nestjs/schedule ethers
# app.module.ts: imports に ScheduleModule.forRoot() と DCAKeeperModule を追加
```

環境変数(シークレット):

```
DCA_RPC_URL=...
DCA_SCHEDULER_ADDRESS=0x...        # SHIN が deploy 後に確定
DCA_KEEPER_PRIVATE_KEY=0x...       # 専用 keeper EOA(用途分離)。要 SHIN の鍵運用決定。
```

## 冪等性・安全性の担保

1. **二重入金不可**: 同一周期に複数回叩いても、コントロールの `nextRun` により2回目以降は
   `"DCA: not due"` で revert → `executeBatch` の per-plan try/catch が skip。DB 側にも
   冪等キー(`planId + periodBucket`)を記録して二度打ちを避ける。
2. **1件失敗が全体を止めない**: `executeBatch` は各プランを個別 try/catch。allowance 切れ等の
   恒久失敗(ユーザー起因)はアラートのみ。
3. **リトライ**: RPC/nonce の一時失敗は指数バックオフ。送信前に `staticCall` で revert 事前検知。
4. **死活監視**: 実行件数・gas・keeper EOA ガス残高をログ/メトリクス。残高低下でアラート。
5. **pause 連動**: コントラクトが pause 中なら tick を skip。

## 残ゲート(要 SHIN)

- **keeper EOA の鍵管理**: 専用 EOA・シークレット管理・用途分離(既定)。最終方針は SHIN。
- **DCAScheduler の deploy アドレス**: broadcast は人間。deploy 後 `DCA_SCHEDULER_ADDRESS` を設定。
- **`setKeeper(cronEOA, true)`**: governance(Safe/Timelock)が実行してはじめて keeper が有効。
- **push 方針**: 空リポへの初回 commit。push は SHIN 承認後(本スケッチはローカル commit のみ)。

## ⚠️ 既知の穴（2026-08-05 点検）

1. **BTC 積立（現物経路）には keeper が無い。** 本 keeper が知っているのは `DCAScheduler`
   （金庫経路＝ETH/BNB）だけで、`DCASpotAccumulator`（BTC 現物買付）を叩く実装は**存在しない**。
   このままでは BTC 積立は登録できても**一度も実行されない**。あちらの `execute(planId, minOut)`
   は keeper 側で `minOut` を用意する必要があり（オラクル値 × 許容スリッページ）、
   本 keeper の「呼ぶだけ」より一段複雑。**独立タスク**。
2. **叩く頻度が毎月1日だけだった**（2026-08-05 に毎時へ修正）。商品は毎日・毎週・毎月の3つを
   出しているので、月1回では毎日/毎週のプランが月1回しか実行されない。**再発防止の検査は無い**
   ＝商品の頻度を増やすときは cron を見ること。
3. **死活監視が無い。** `logger` に出しているだけで、tick が止まっても誰も気づかない。
   ADR-020 の自動一時停止は「引き落とせない状態が続いた時間」で測るので、**keeper が止まると
   ユーザーのプランは止まらないまま実行されない**（画面上は healthy に見える）。
4. **build 検証が一度も通っていない**（NestJS scaffold 未作成）。型は目視のみ。
