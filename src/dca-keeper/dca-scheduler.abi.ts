// Minimal ABI for the on-chain DCAScheduler (sixx-vault/src/periphery/DCAScheduler.sol).
// Only the functions the keeper needs. Kept hand-written to avoid a build-time
// dependency on the Foundry artifacts; regenerate from out/DCAScheduler.sol/DCAScheduler.json
// if the contract surface changes.
export const DCA_SCHEDULER_ABI = [
  // reads
  'function nextPlanId() view returns (uint256)',
  'function isDue(uint256 planId) view returns (bool)',
  'function paused() view returns (bool)',
  // ⚠️ `plans` は contract 側で `internal`（public getter が 15 フィールドで
  //    "Stack too deep" になったため）。読み取りは `getPlan` に一本化されている。
  //    タプルは `DCAScheduler.Plan` と**順序まで一致**していること — ずれると silently
  //    誤デコードする。ADR-020（2026-08-04）で `uint32 failedPeriods,uint256
  //    lastCountedPeriod` → `uint256 failedSince` に変わった。
  //    ※ keeper 本体は使っていない（`isDue` / `executeBatch` のみ）。将来の利用時の罠を
  //      潰すために正しい形へ直してある。
  'function getPlan(uint256 planId) view returns (tuple(address owner,address asset,address vault,uint256 amountPerRun,uint256 interval,uint256 startTime,uint256 endTime,uint256 maxTotal,uint256 totalDeposited,uint256 totalPulled,uint256 nextRun,bool active,bool autoPaused,uint256 failedSince))',
  // writes (keeper-only on-chain)
  'function execute(uint256 planId)',
  'function executeBatch(uint256[] planIds)',
  // events
  'event Executed(uint256 indexed planId, address indexed owner, uint256 pulled, uint256 deposited, uint256 fee, uint256 sharesToOwner, uint256 nextRun)',
  'event ExecutionSkipped(uint256 indexed planId, bytes reason)',
] as const;
