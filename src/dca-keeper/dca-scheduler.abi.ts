// Minimal ABI for the on-chain DCAScheduler (sixx-vault/src/periphery/DCAScheduler.sol).
// Only the functions the keeper needs. Kept hand-written to avoid a build-time
// dependency on the Foundry artifacts; regenerate from out/DCAScheduler.sol/DCAScheduler.json
// if the contract surface changes.
export const DCA_SCHEDULER_ABI = [
  // reads
  'function nextPlanId() view returns (uint256)',
  'function isDue(uint256 planId) view returns (bool)',
  'function paused() view returns (bool)',
  'function plans(uint256) view returns (address owner, address asset, address vault, uint256 amountPerRun, uint256 interval, uint256 startTime, uint256 endTime, uint256 maxTotal, uint256 totalDeposited, uint256 totalPulled, uint256 nextRun, bool active)',
  // writes (keeper-only on-chain)
  'function execute(uint256 planId)',
  'function executeBatch(uint256[] planIds)',
  // events
  'event Executed(uint256 indexed planId, address indexed owner, uint256 pulled, uint256 deposited, uint256 fee, uint256 sharesToOwner, uint256 nextRun)',
  'event ExecutionSkipped(uint256 indexed planId, bytes reason)',
] as const;
