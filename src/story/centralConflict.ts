import type { GameAnalysis } from '../analysis/types';
import type { GameUnderstanding, TurningPoint } from '../understanding/types';
import type { GameOutcome } from './gameOutcome';
import { selectStoryCandidate } from './storyCandidates';
import type { CentralConflict, NoConflictReason, StorySettings } from './types';

/**
 * Deterministic EDITORIAL ranking — not objective chess truth. A different,
 * equally defensible rule (earliest decisive turning point, or raw
 * |swingCp| instead of composite significance.score) would select a
 * different spine from the same game. This is the one rule Phase 2.3 uses,
 * fixed by explicit product decision:
 *   1. significance.score descending
 *   2. |materialConsequence.netMaterialChange| descending
 *   3. ply ascending
 */
function rankTurningPoints(turningPoints: readonly TurningPoint[]): readonly TurningPoint[] {
  return [...turningPoints].sort((a, b) => {
    if (b.significance.score !== a.significance.score) return b.significance.score - a.significance.score;
    const aMat = Math.abs(a.causeConsequence.materialConsequence.netMaterialChange);
    const bMat = Math.abs(b.causeConsequence.materialConsequence.netMaterialChange);
    if (bMat !== aMat) return bMat - aMat;
    return a.ply - b.ply;
  });
}

/**
 * Phase 15 — selection is now the five-gate cascade in storyCandidates.ts,
 * not `rankTurningPoints[0]`. rankTurningPoints survives only to order the
 * SECONDARY conflicts, which is a presentation list rather than a claim
 * about what the game was about.
 *
 * GATE 0 (the GameOutcome) is resolved by buildStoryPlan and threaded in,
 * because every later gate consults it.
 */
export function selectCentralConflict(
  understanding: GameUnderstanding,
  analysis: GameAnalysis,
  outcome: GameOutcome,
  settings: StorySettings
): { readonly centralConflict: CentralConflict | null; readonly noConflictReason?: NoConflictReason } {
  const selection = selectStoryCandidate(understanding, analysis, outcome, settings);
  if (selection.kind === 'abstain') {
    return { centralConflict: null, noConflictReason: selection.reason };
  }

  const winner = selection.winner.turningPoint;

  // Retained from the original rule: a hard significance floor still applies
  // and is still configurable. It defaults to 0 (excluding nothing), and now
  // sits AFTER the gates rather than being the whole decision.
  if (winner.significance.score < settings.significanceFloorForConflict) {
    return { centralConflict: null, noConflictReason: 'below-significance-floor' };
  }

  const chain = selection.winner.chain;
  const causalChain = [...chain.antecedents, ...chain.consequents].sort((a, b) => a.ply - b.ply);
  const chainPlies = new Set<number>([winner.ply, ...causalChain.map((l) => l.ply)]);

  const secondaryConflicts = rankTurningPoints(understanding.turningPoints)
    .filter((tp) => tp.id !== winner.id && !chainPlies.has(tp.ply))
    .map((tp) => tp.id)
    .slice(0, settings.maxSecondaryConflicts);

  return {
    centralConflict: {
      primaryTurningPointId: winner.id,
      causalChain,
      secondaryConflicts,
      consequenceChain: chain,
      tier: selection.winner.tier
    },
    noConflictReason: undefined
  };
}
