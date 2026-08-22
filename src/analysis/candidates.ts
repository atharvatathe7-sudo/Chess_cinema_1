import type { EvaluationSwingCandidate, MateTransition, PlyAnalysis } from './types';

/**
 * Detection and ranking of significant evaluation changes.
 *
 * DELIBERATELY LABEL-FREE. Phase 2.1 identifies *that* the evaluation moved
 * sharply and how much; it does not decide whether a move was a "blunder",
 * "mistake", "brilliancy" or anything else. Those words imply a
 * classification system with thresholds, position context and intent
 * detection that this phase does not have, so applying them here would be
 * asserting more than the data supports. The output is therefore called an
 * EvaluationSwingCandidate and it carries the raw engine numbers forward.
 *
 * Everything in this module is pure and deterministic: same PlyAnalysis[] in,
 * byte-identical candidate list out, every time, with no clock, no randomness
 * and no dependence on iteration order of anything unordered.
 */

export interface CandidateDetectionSettings {
  /**
   * Minimum mover-relative loss (in centipawns) for a ply to be considered a
   * candidate. 100cp = one pawn. A ply is a candidate if it loses at least
   * this much for the player who moved, or if it involves a mate transition
   * that changes who is winning.
   */
  readonly minSwingCp: number;
  /** Cap on how many candidates to return, after ranking. */
  readonly maxCandidates: number;
}

export const DEFAULT_CANDIDATE_SETTINGS: CandidateDetectionSettings = {
  minSwingCp: 100,
  maxCandidates: 20
};

/**
 * Extra ranking weight for mate transitions, in centipawn-equivalent units.
 * A mate changing hands is the single most dramatic thing that can happen to
 * an evaluation, and the clamped centipawn scale cannot express it (both
 * "mate for White" and "+10.00 for White" saturate at the same value), so it
 * is added explicitly rather than being invisible in the ordering.
 */
const MATE_TRANSITION_BONUS: Readonly<Record<MateTransition, number>> = {
  none: 0,
  'mate-sustained': 0,
  'mate-disappeared': 400,
  'mate-appeared': 600,
  'mate-flipped': 1200
};

/** True when a mate transition alone makes a ply noteworthy, regardless of centipawn swing. */
function isDecisiveMateTransition(transition: MateTransition): boolean {
  return transition === 'mate-appeared' || transition === 'mate-flipped' || transition === 'mate-disappeared';
}

/**
 * The deterministic significance score for a ply. Higher = more significant.
 *
 * Built only from objective engine-derived quantities:
 *   - how much the mover lost, on the clamped centipawn scale
 *   - whether a forced mate appeared, vanished, or changed hands
 *
 * No heuristics about piece sacrifices, no motif detection, no model calls.
 */
export function rankScoreFor(ply: PlyAnalysis): number {
  const lossForMover = Math.max(0, -ply.swingForMoverCp);
  return lossForMover + MATE_TRANSITION_BONUS[ply.mateTransition];
}

function toCandidate(ply: PlyAnalysis): EvaluationSwingCandidate {
  return {
    ply: ply.ply,
    moveNumber: ply.moveNumber,
    sideToMove: ply.sideToMove,
    movePlayedSan: ply.movePlayedSan,
    evaluationBefore: ply.evaluationBefore,
    evaluationAfter: ply.evaluationAfter,
    swingCp: ply.swingCp,
    swingForMoverCp: ply.swingForMoverCp,
    mateTransition: ply.mateTransition,
    rankScore: rankScoreFor(ply)
  };
}

/**
 * Selects the plies whose evaluation moved significantly against the player
 * who moved, ranked most-significant-first.
 *
 * Ties are broken by ply number ascending, so the ordering is total and
 * stable — two runs over the same analysis always produce the same list in
 * the same order, which is what makes this testable and reproducible.
 */
export function detectCandidates(
  plies: readonly PlyAnalysis[],
  settings: CandidateDetectionSettings = DEFAULT_CANDIDATE_SETTINGS
): EvaluationSwingCandidate[] {
  const significant = plies.filter((ply) => {
    const lossForMover = -ply.swingForMoverCp;
    return lossForMover >= settings.minSwingCp || isDecisiveMateTransition(ply.mateTransition);
  });

  const ranked = significant
    .map(toCandidate)
    .sort((a, b) => (b.rankScore - a.rankScore) || (a.ply - b.ply));

  return ranked.slice(0, settings.maxCandidates);
}
