import { ESTIMATOR_ROUNDING_TOLERANCE_TOKENS, MIN_COMPACTION_SAVING_RATIO } from "../constants.ts";
import type { CompactionWindowPlan } from "../app/run-context.ts";

export interface CompactionYieldEstimate {
  plannedAfterTokens: number;
  plannedSavedTokens: number;
  plannedYield: number;
  estimatedAfterTokens: number;
  estimatedSavedTokens: number;
  estimatedYield: number;
  retainedTailTokens: number;
  summaryTokens: number;
  summaryBudgetTokens: number;
  targetAfterTokens: number;
  relaxedSoftBoundaries: CompactionWindowPlan["relaxedSoftBoundaries"];
  hardBoundaryAdjusted: boolean;
}

/** Content-free failure raised before any compaction side effect. */
export class YieldGateError extends Error implements CompactionYieldEstimate {
  readonly name = "YieldGateError";

  constructor(public readonly reason: "target-miss" | "insufficient-saving", estimate: CompactionYieldEstimate) {
    super(reason === "target-miss"
      ? "Final summary estimate misses the planned compaction target"
      : "Final summary estimate does not meet the minimum saving policy");
    Object.assign(this, estimate);
  }

  plannedAfterTokens!: number;
  plannedSavedTokens!: number;
  plannedYield!: number;
  estimatedAfterTokens!: number;
  estimatedSavedTokens!: number;
  estimatedYield!: number;
  retainedTailTokens!: number;
  summaryTokens!: number;
  summaryBudgetTokens!: number;
  targetAfterTokens!: number;
  relaxedSoftBoundaries!: CompactionWindowPlan["relaxedSoftBoundaries"];
  hardBoundaryAdjusted!: boolean;
}

/** Pure estimate builder — no gate logic, safe to call from force-apply paths. */
export function estimateCompactionYield(
  totalTokens: number,
  summaryTokens: number,
  plan: CompactionWindowPlan,
): CompactionYieldEstimate {
  const estimatedAfterTokens = plan.fixedContextTokens + plan.retainedTokens + summaryTokens;
  const estimatedSavedTokens = Math.max(0, totalTokens - estimatedAfterTokens);
  const estimatedYield = totalTokens > 0 ? estimatedSavedTokens / totalTokens : 0;
  return {
    plannedAfterTokens: plan.projectedAfterTokens,
    plannedSavedTokens: plan.projectedSavedTokens,
    plannedYield: plan.projectedYield,
    estimatedAfterTokens,
    estimatedSavedTokens,
    estimatedYield,
    retainedTailTokens: plan.retainedTokens,
    summaryTokens,
    summaryBudgetTokens: plan.summaryBudgetTokens,
    targetAfterTokens: plan.targetAfterTokens,
    relaxedSoftBoundaries: plan.relaxedSoftBoundaries,
    hardBoundaryAdjusted: plan.hardBoundaryAdjusted,
  };
}

/** Single source of truth for the yield thresholds; returns the failure reason or null. */
export function yieldGateFailureReason(estimate: CompactionYieldEstimate): YieldGateError["reason"] | null {
  if (estimate.estimatedAfterTokens > estimate.targetAfterTokens + ESTIMATOR_ROUNDING_TOLERANCE_TOKENS) {
    return "target-miss";
  }
  if (estimate.estimatedYield < MIN_COMPACTION_SAVING_RATIO) {
    return "insufficient-saving";
  }
  return null;
}

export function verifyCompactionYield(
  totalTokens: number,
  summaryTokens: number,
  plan: CompactionWindowPlan,
): CompactionYieldEstimate {
  const estimate = estimateCompactionYield(totalTokens, summaryTokens, plan);
  const reason = yieldGateFailureReason(estimate);
  if (reason) throw new YieldGateError(reason, estimate);
  return estimate;
}
