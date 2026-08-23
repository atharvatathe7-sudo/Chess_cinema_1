import type { BestAlternativeRecord, GameUnderstanding, SignificanceRecord } from '../understanding/types';
import type { ExplanationKind, ExplanationOpportunity } from './types';

/**
 * Respects BestAlternativeRecord.bestMoveUniqueness exactly:
 *   - 'shared' NEVER presents the top move as uniquely correct.
 *   - 'unknown' NEVER has uniqueness inferred either way.
 * A "unique, played, not under pressure" case (a routine strong move where
 * the engine happens to be confident about a single best line, but nothing
 * about the situation was forced) is not a distinctive explanation
 * opportunity — returning null here rather than forcing it into one of the
 * four kinds is more honest than mislabeling it.
 */
function kindFor(ba: BestAlternativeRecord, significance: SignificanceRecord): ExplanationKind | null {
  if (ba.bestMoveUniqueness === 'unique' && !ba.playedMoveWasTopMove) {
    return 'clear-best-move';
  }
  if (ba.bestMoveUniqueness === 'unique' && ba.playedMoveWasTopMove) {
    return significance.reasons.includes('only-move-under-pressure') ? 'only-good-move' : null;
  }
  if (ba.bestMoveUniqueness === 'shared') {
    return 'multiple-equivalent-options';
  }
  // 'unknown' — the ply fell outside the shared follow-up budget.
  return 'insufficient-data';
}

export function buildExplanationOpportunities(understanding: GameUnderstanding): readonly ExplanationOpportunity[] {
  const opportunities: ExplanationOpportunity[] = [];

  for (const tp of understanding.turningPoints) {
    const kind = kindFor(tp.causeConsequence.bestAlternative, tp.significance);
    if (kind === null) continue;
    opportunities.push({ ply: tp.ply, kind, causeConsequenceId: tp.causeConsequence.id });
  }

  return opportunities.sort((a, b) => a.ply - b.ply);
}
