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
| `dca-keeper.service.ts` | `@Cron` で毎月1日に due プランを集めて `executeBatch` を呼ぶ。冪等・リトライ・監視。 |
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
