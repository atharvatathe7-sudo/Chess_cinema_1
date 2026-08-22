import { Chess } from 'chess.js';
import type { Color } from '../chess/ChessEngine';
import type { Evaluation, PlyAnalysis } from '../analysis/types';
import { DEFAULT_CANDIDATE_SETTINGS } from '../analysis/candidates';
import type { MoveQualityClass } from './types';
import { boardFromFen, coordsOf, staticExchangeEvaluation, type Board } from './geometry';

/**
 * Axis 1 — engine-relative move quality. See the MOVE-QUALITY SCOPE note in
 * types.ts: this module never reads significance, motif, or narrative data,
 * and nothing downstream may derive significance from its output.
 */

/** Separate from UnderstandingSettings.equivalenceEpsilonCp on purpose — tuning one must never move the other. */
const QUALITY_OPTIMAL_EPSILON_CP = 10;

function mateDistanceRegressed(before: Evaluation, after: Evaluation, mover: Color): boolean {
  if (before.kind !== 'mate' || after.kind !== 'mate') return false;
  const moverMatesBefore = mover === 'w' ? before.mateIn > 0 : before.mateIn < 0;
  const moverMatesAfter = mover === 'w' ? after.mateIn > 0 : after.mateIn < 0;
  if (!moverMatesBefore || !moverMatesAfter) return false;
  return Math.abs(after.mateIn) > Math.abs(before.mateIn);
}

/**
 * Strict, total decision tree — exactly one output per ply. mistake/blunder
 * thresholds reuse candidates.ts's own minSwingCp rather than a second,
 * possibly-conflicting constant, so this can never disagree with Phase
 * 2.1's own GameAnalysis.candidates about the mistake/blunder boundary.
 */
export function qualityClassFor(ply: PlyAnalysis): MoveQualityClass {
  if (ply.mateTransition === 'mate-flipped') return 'blunder';
  if (ply.mateTransition === 'mate-disappeared') return 'blunder';
  if (
    ply.mateTransition === 'mate-sustained' &&
    mateDistanceRegressed(ply.evaluationBefore, ply.evaluationAfter, ply.sideToMove)
  ) {
    return 'missed-win';
  }

  const minSwingCp = DEFAULT_CANDIDATE_SETTINGS.minSwingCp;
  if (ply.swingForMoverCp >= -QUALITY_OPTIMAL_EPSILON_CP) return 'optimal';
  if (ply.swingForMoverCp > -minSwingCp) return 'inaccuracy';
  if (ply.swingForMoverCp > -3 * minSwingCp) return 'mistake';
  return 'blunder';
}

/**
 * A sound sacrifice: the mover's own move lands a piece where the opponent
 * can win material by capturing it (SEE > 0 for the opponent on the
 * destination square) — a real offer — yet the engine does not judge the
 * move as a mistake or worse. An unsound "sacrifice" that is simply a
 * blunder is not reported as isSacrifice; it is reported as its qualityClass.
 */
export function isSacrifice(boardAfter: Board, moveToSquare: string, moverColor: Color, swingForMoverCp: number): boolean {
  const opponent: Color = moverColor === 'w' ? 'b' : 'w';
  const seeForOpponent = staticExchangeEvaluation(boardAfter, coordsOf(moveToSquare), opponent);
  const materialOffered = seeForOpponent > 0;
  return materialOffered && swingForMoverCp > -DEFAULT_CANDIDATE_SETTINGS.minSwingCp;
}

export interface BaseSignals {
  readonly matchesEngineBest: boolean;
  readonly isSacrifice: boolean;
  readonly deliversCheck: boolean;
  readonly deliversMate: boolean;
}

/** Everything PlySignals needs except motifIds/forcedSequenceId/isTurningPoint, which other modules own. */
export function computeBaseSignals(ply: PlyAnalysis): BaseSignals {
  const boardAfter = boardFromFen(ply.fenAfter);
  const afterChess = new Chess(ply.fenAfter);
  return {
    matchesEngineBest: ply.bestMove !== null && ply.movePlayedUci === ply.bestMove,
    isSacrifice: isSacrifice(boardAfter, ply.movePlayedUci.slice(2, 4), ply.sideToMove, ply.swingForMoverCp),
    deliversCheck: afterChess.isCheck(),
    deliversMate: afterChess.isCheckmate()
  };
}
