import type { AnalysisSettings, MultiPvResult, PlyAnalysis } from '../analysis/types';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { analysisCancelledError } from '../analysis/analysisErrors';
import type { UnderstandingEngineBudget } from './types';

const DECISIVE_MATE_TRANSITIONS = new Set(['mate-appeared', 'mate-flipped', 'mate-disappeared']);

/**
 * Deterministic selection of which plies receive follow-up engine work
 * (MultiPV), decided entirely from zero-cost signals already present in
 * GameAnalysis — before any engine call begins, so selection can never
 * depend on the order or outcome of the calls it's about to make. Ranked
 * by decisive mate transitions first, then |swingForMoverCp|, tie-broken
 * by ply ascending — the same tie-break rule candidates.ts already uses.
 */
export function selectFollowUpPlies(
  plies: readonly PlyAnalysis[],
  budget: UnderstandingEngineBudget
): readonly PlyAnalysis[] {
  const ranked = [...plies].sort((a, b) => {
    const aDecisive = DECISIVE_MATE_TRANSITIONS.has(a.mateTransition) ? 1 : 0;
    const bDecisive = DECISIVE_MATE_TRANSITIONS.has(b.mateTransition) ? 1 : 0;
    if (aDecisive !== bDecisive) return bDecisive - aDecisive;
    const swingDiff = Math.abs(b.swingForMoverCp) - Math.abs(a.swingForMoverCp);
    if (swingDiff !== 0) return swingDiff;
    return a.ply - b.ply;
  });
  return ranked.slice(0, budget.maxFollowUpPositions);
}

export interface FollowUpResult {
  readonly multiPvByPly: ReadonlyMap<number, MultiPvResult>;
}

/**
 * Spends the shared follow-up budget: MultiPV queries at the selected
 * plies' pre-move positions (fenBefore), one at a time, checking
 * cancellation between each — the same isCancelled polling pattern
 * analyzeGame.ts already uses, no new mechanism invented. A single
 * position's follow-up failing (timeout, protocol error) does not abort
 * the whole pass; that position's BestAlternativeRecord simply falls back
 * to bestMoveUniqueness: 'unknown' rather than asserting something the
 * data doesn't support.
 */
export async function runFollowUpQueries(
  plies: readonly PlyAnalysis[],
  engine: AnalysisEngine,
  budget: UnderstandingEngineBudget,
  isCancelled?: () => boolean
): Promise<Result<FollowUpResult, AppError>> {
  const selected = selectFollowUpPlies(plies, budget);
  const multiPvByPly = new Map<number, MultiPvResult>();
  const settings: AnalysisSettings = { depth: budget.multiPvDepth, maxTimeMsPerPosition: budget.multiPvMaxTimeMsPerPosition };

  for (const ply of selected) {
    if (isCancelled?.()) return err(analysisCancelledError());
    const result = await engine.evaluatePositionMultiPv(ply.fenBefore, settings, budget.multiPvLines);
    if (result.ok) {
      multiPvByPly.set(ply.ply, result.value);
    }
  }

  return ok({ multiPvByPly });
}
