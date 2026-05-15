import { ChaseStage, type OrganisationConfig } from '@prisma/client';

/**
 * The four WD thresholds and the AWAITING_* stage each one promotes a
 * charge into. Order matters — callers scan from most-severe down to
 * find the highest threshold currently crossed.
 */
export const CHASE_THRESHOLDS = [
  { stage: ChaseStage.AWAITING_WD14, sentStage: ChaseStage.WD14_NOTIFIED, configKey: 'chaseDayExecNotify' as const },
  { stage: ChaseStage.AWAITING_WD8, sentStage: ChaseStage.WD8_SENT, configKey: 'chaseDayThird' as const },
  { stage: ChaseStage.AWAITING_WD5, sentStage: ChaseStage.WD5_SENT, configKey: 'chaseDaySecond' as const },
  { stage: ChaseStage.AWAITING_WD3, sentStage: ChaseStage.WD3_SENT, configKey: 'chaseDayFirst' as const },
] as const;

export type ChaseThreshold = (typeof CHASE_THRESHOLDS)[number];

export const STAGE_SEVERITY: Record<ChaseStage, number> = {
  [ChaseStage.NOT_DUE]: 0,
  [ChaseStage.AWAITING_WD3]: 1,
  [ChaseStage.WD3_SENT]: 2,
  [ChaseStage.AWAITING_WD5]: 3,
  [ChaseStage.WD5_SENT]: 4,
  [ChaseStage.AWAITING_WD8]: 5,
  [ChaseStage.WD8_SENT]: 6,
  [ChaseStage.AWAITING_WD14]: 7,
  [ChaseStage.WD14_NOTIFIED]: 8,
  [ChaseStage.RESOLVED]: -1,
};

/** Pick out just the four WD threshold values from an OrganisationConfig. */
export function thresholdsFromConfig(
  config: Pick<
    OrganisationConfig,
    'chaseDayFirst' | 'chaseDaySecond' | 'chaseDayThird' | 'chaseDayExecNotify'
  >,
): Record<ChaseThreshold['configKey'], number> {
  return {
    chaseDayFirst: config.chaseDayFirst,
    chaseDaySecond: config.chaseDaySecond,
    chaseDayThird: config.chaseDayThird,
    chaseDayExecNotify: config.chaseDayExecNotify,
  };
}

/**
 * Stages the charge has already crossed at this WD count, ordered low-to-high
 * (AWAITING_WD3 first). Used by the chase tick to know which entries to
 * create. Returns up to 4 stages.
 */
export function stagesCrossed(
  workingDaysOverdue: number,
  thresholds: Record<ChaseThreshold['configKey'], number>,
): ChaseStage[] {
  // Walk low-to-high so the order matches the natural cadence
  return [...CHASE_THRESHOLDS]
    .reverse()
    .filter((t) => workingDaysOverdue >= thresholds[t.configKey])
    .map((t) => t.stage);
}
