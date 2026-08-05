/**
 * DCAKeeperService — 積立(DCA)のオフチェーン cron トリガー (実装スケッチ)
 *
 * 役割: 期日が到来した DCA プランを検出し、on-chain の DCAScheduler.executeBatch を
 *       「呼ぶだけ」。資金移動のルール・上限・宛先はすべてコントラクト側で強制される
 *       (非カストディ)。この keeper は資金を保持も移動もしない。keeper EOA が漏れても
 *       盗めるものは無い (execute はユーザー本人の vault ポジションにしか入金できない)。
 *
 * ⚠️ これはスケッチ。affliate-api は現状 NestJS scaffold 未作成のため build 検証は未実施。
 *    NestJS プロジェクト初期化後 (@nestjs/schedule, ethers を導入) にそのまま組み込める構成。
 *
 * 設計要点:
 *  - トリガー: 自社 cron (@nestjs/schedule)。Gelato は不採用 (確定)。将来差替可。
 *  - スケジュール: 毎月1日 00:05 UTC。ただし「間隔」自体はコントラクトの nextRun が真実。
 *    cron はあくまで「叩きに行く」タイミングで、二重入金はコントラクト側 nextRun で不可能 (冪等)。
 *  - 冪等性: 同一周期に複数回叩いても execute は "DCA: not due" で revert し skip されるため安全。
 *    さらに DB 側で execution 冪等キー (planId + periodBucket) を記録し二度打ちを避ける。
 *  - リトライ: RPC/nonce/一時失敗は指数バックオフで再試行。executeBatch は per-plan try/catch
 *    なので 1件の失敗が他を止めない。恒久失敗 (allowance 切れ等) はアラートのみ (ユーザー起因)。
 *  - 死活監視: 実行結果 (成功/skip 件数・gas・残高) をログ+メトリクスに出す。keeper EOA の
 *    ガス残高が閾値未満ならアラート。
 *  - バッチ分割: due プランが多い時は N 件ずつ分割 (gas 上限)。
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ethers } from 'ethers';
import { DCA_SCHEDULER_ABI } from './dca-scheduler.abi';

const BATCH_SIZE = 40; // executeBatch 1回あたりの上限 (gas 見合いで調整)
const SCAN_CONCURRENCY = 20; // isDue の並行読み取り数 (RPC のレート制限見合い)
const MAX_RETRIES = 3;
const KEEPER_MIN_GAS_WEI = ethers.parseEther('0.02'); // ガス残高アラート閾値 (例)

@Injectable()
export class DCAKeeperService {
  private readonly logger = new Logger(DCAKeeperService.name);
  private readonly provider: ethers.JsonRpcProvider;
  private readonly signer: ethers.Wallet;
  private readonly scheduler: ethers.Contract;
  /** 毎時 tick の再入防止（前回が終わる前に次が来たら飛ばす）。 */
  private running = false;

  constructor() {
    // ── 環境変数 (シークレット。専用 keeper EOA・用途分離。要 SHIN の鍵運用決定) ──
    const rpcUrl = requireEnv('DCA_RPC_URL');
    const schedulerAddr = requireEnv('DCA_SCHEDULER_ADDRESS');
    const keeperPk = requireEnv('DCA_KEEPER_PRIVATE_KEY'); // 専用 EOA。資金は奪えない設計。

    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = new ethers.Wallet(keeperPk, this.provider);
    this.scheduler = new ethers.Contract(schedulerAddr, DCA_SCHEDULER_ABI, this.signer);
  }

  /**
   * **毎時 05 分**に実行する。実際の周期はコントラクトの `nextRun` が支配し、ここでは
   * 「その時点で due な全プランを叩く」だけなので、叩く回数を増やしても二重入金は起きない
   * （`nextRun` 未到来は `DCA: not due` で revert → `executeBatch` が skip する）。
   *
   * ⚠️ **旧実装は毎月1日だけだった**（`'5 0 1 * *'`）。商品は**毎日・毎週・毎月**の3つを
   * 出しているので、月1回しか叩かないと**毎日/毎週のプランが月1回しか実行されない**。
   * 契約の `MIN_INTERVAL = 1 hours` に合わせて毎時にすると、どの頻度でも「期日の当日中」に
   * 実行される。ユーザーから見える遅延は最大1時間。
   *
   * 実行が重い場合に絞るのは cron の間隔ではなく `collectDuePlanIds`（DB 索引で候補を絞る）側。
   */
  @Cron('5 * * * *', { name: 'dca-hourly', timeZone: 'UTC' })
  async runHourly(): Promise<void> {
    if (this.running) {
      // 前の tick がまだ終わっていない（プラン数が多い / RPC が遅い）。重ねて走らせない。
      this.logger.warn('previous DCA tick still running — skipping this hour');
      return;
    }
    this.running = true;
    try {
      await this.tick();
    } finally {
      this.running = false;
    }
  }

  /** 冪等・再入不可の1サイクル。手動起動 (管理エンドポイント) からも呼べる。 */
  async tick(): Promise<{ executed: number; batches: number }> {
    if (await this.scheduler.paused()) {
      this.logger.warn('DCAScheduler is paused on-chain — skipping tick');
      return { executed: 0, batches: 0 };
    }
    await this.assertKeeperGas();

    const duePlanIds = await this.collectDuePlanIds();
    this.logger.log(`DCA tick: ${duePlanIds.length} due plan(s)`);
    if (duePlanIds.length === 0) return { executed: 0, batches: 0 };

    let batches = 0;
    for (let i = 0; i < duePlanIds.length; i += BATCH_SIZE) {
      const chunk = duePlanIds.slice(i, i + BATCH_SIZE);
      await this.sendBatchWithRetry(chunk);
      batches++;
    }
    return { executed: duePlanIds.length, batches };
  }

  /**
   * on-chain の isDue(planId) を真実として due プランを列挙する。
   * 実運用では DB (MySQL) に planId レンジ / owner を索引しておき isDue を絞り込む。
   * ここでは nextPlanId まで走査する素朴版 (スケッチ)。
   */
  private async collectDuePlanIds(): Promise<bigint[]> {
    const next: bigint = await this.scheduler.nextPlanId();
    const due: bigint[] = [];
    // 直列に await すると RPC の往復がプラン数ぶん積み上がり、毎時 tick では現実的でない。
    // ID をまとめて並べ、`SCAN_CONCURRENCY` 件ずつ並行に読む（読み取りのみ・順序は問わない）。
    const ids: bigint[] = [];
    for (let id = 1n; id < next; id++) ids.push(id);
    for (let i = 0; i < ids.length; i += SCAN_CONCURRENCY) {
      const chunk = ids.slice(i, i + SCAN_CONCURRENCY);
      const flags = await Promise.all(
        chunk.map(async (id) => {
          try {
            return (await this.scheduler.isDue(id)) as boolean;
          } catch (e) {
            // 1件の読み取り失敗で tick 全体を落とさない（次の周期で拾える）。
            this.logger.error(`isDue(${id}) failed: ${errMsg(e)}`);
            return false;
          }
        }),
      );
      chunk.forEach((id, k) => {
        if (flags[k]) due.push(id);
      });
    }
    return due;
  }

  private async sendBatchWithRetry(planIds: bigint[]): Promise<void> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // staticCall で事前検証してから送信 (revert 事前検知)。
        await this.scheduler.executeBatch.staticCall(planIds);
        const tx = await this.scheduler.executeBatch(planIds);
        const receipt = await tx.wait(1);
        this.logger.log(
          `executeBatch ok: ${planIds.length} plan(s), tx=${receipt?.hash}, gasUsed=${receipt?.gasUsed}`,
        );
        // TODO: receipt.logs を Executed/ExecutionSkipped で分類し DB へ記録 (冪等キー: planId+periodBucket)。
        return;
      } catch (e) {
        const backoffMs = 1000 * 2 ** (attempt - 1);
        this.logger.warn(
          `executeBatch attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg(e)} — retry in ${backoffMs}ms`,
        );
        if (attempt === MAX_RETRIES) {
          this.logger.error(`executeBatch permanently failed for ${planIds.length} plan(s) — ALERT`);
          // TODO: PagerDuty/Slack アラート。individual plan の恒久失敗はユーザー起因 (allowance 切れ) が多い。
          return;
        }
        await sleep(backoffMs);
      }
    }
  }

  private async assertKeeperGas(): Promise<void> {
    const bal = await this.provider.getBalance(this.signer.address);
    if (bal < KEEPER_MIN_GAS_WEI) {
      this.logger.error(
        `keeper ${this.signer.address} low gas: ${ethers.formatEther(bal)} ETH — ALERT (refill needed)`,
      );
      // TODO: アラート発火。処理は継続 (送信は失敗するが状態は壊れない)。
    }
  }
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`DCAKeeperService: missing env ${key}`);
  return v;
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
