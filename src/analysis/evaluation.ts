import type { Color } from '../chess/ChessEngine';
import type { Evaluation, MateTransition } from './types';

/**
 * Evaluations are clamped to +/- this many centipawns before any swing is
 * computed. Without a clamp, a position that is already hopeless (-4000cp)
 * getting slightly more hopeless (-6000cp) would register as a larger
 * "swing" than the move that lost the game in the first place. Clamping
 * makes swing mean "how much did the practical outcome change", which is
 * what a significant-moment detector actually wants.
 *
 * A forced mate saturates to exactly this value, so the largest possible
 * swing is 2 * SWING_CLAMP_CP.
 */
export const SWING_CLAMP_CP = 1000;

/** Raw UCI score exactly as the engine reports it: relative to the SIDE TO MOVE. */
export type UciScore =
  | { readonly kind: 'cp'; readonly value: number }
  | { readonly kind: 'mate'; readonly value: number };

/**
 * Converts an engine score (side-to-move relative) into this application's
 * white-relative convention. This is the ONLY sign flip in the codebase —
 * see the convention block in types.ts.
 *
 * When Black is to move, the engine reporting "+3.0" means *Black* is three
 * pawns better, which is -3.0 white-relative. Likewise "mate in 2" for a
 * black-to-move position is mateIn = -2.
 */
export function fromUciScore(score: UciScore, sideToMove: Color): Evaluation {
  const sign = sideToMove === 'w' ? 1 : -1;
  if (score.kind === 'mate') {
    // `score mate 0` is UCI for "the side to move is checkmated right now" —
    // the game is already over rather than someone having a mate coming. It
    // must be handled separately because zero carries no sign: treating it as
    // a normal mate score would credit the mate to whichever side the sign
    // rule happens to pick, inverting the result of every game that ends in
    // checkmate.
    if (score.value === 0) {
      return { kind: 'terminal', result: sideToMove === 'w' ? 'black-wins' : 'white-wins' };
    }
    return { kind: 'mate', mateIn: score.value * sign };
  }
  return { kind: 'cp', cp: normalizeZero(score.value * sign) };
}

/**
 * Collapses JavaScript's negative zero to positive zero. Flipping the sign of
 * a dead-level 0 score yields -0, which is invisible in most arithmetic but
 * breaks Object.is/toEqual comparisons and would format as a spurious "-0.00".
 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/**
 * Projects any evaluation onto a single comparable centipawn axis, clamped to
 * +/- SWING_CLAMP_CP. Mate saturates the axis in the mating side's direction,
 * so "White has mate" and "White is +1000" compare equal here — the fact that
 * a mate exists is carried separately by MateTransition rather than by
 * inflating this number.
 */
export function toComparableCp(evaluation: Evaluation): number {
  if (evaluation.kind === 'terminal') {
    if (evaluation.result === 'draw') return 0;
    return evaluation.result === 'white-wins' ? SWING_CLAMP_CP : -SWING_CLAMP_CP;
  }
  if (evaluation.kind === 'mate') {
    return evaluation.mateIn >= 0 ? SWING_CLAMP_CP : -SWING_CLAMP_CP;
  }
  return Math.max(-SWING_CLAMP_CP, Math.min(SWING_CLAMP_CP, evaluation.cp));
}

/**
 * White-relative change across a ply: positive means the position moved in
 * White's favour, negative in Black's favour — regardless of who moved.
 */
export function evaluationSwingCp(before: Evaluation, after: Evaluation): number {
  return normalizeZero(toComparableCp(after) - toComparableCp(before));
}

/**
 * The same change seen by the player who actually moved. Negative always
 * means "the mover's own position got worse", for either colour, which is
 * what makes this directly comparable across both sides of the game.
 */
export function swingForMoverCp(before: Evaluation, after: Evaluation, mover: Color): number {
  const whiteRelative = evaluationSwingCp(before, after);
  return mover === 'w' ? whiteRelative : normalizeZero(-whiteRelative);
}

/**
 * Which side, if any, is delivering mate in this evaluation. A completed
 * checkmate counts as the winning side mating; a draw and an ordinary
 * centipawn score count as neither.
 */
function matingSide(evaluation: Evaluation): Color | null {
  if (evaluation.kind === 'terminal') {
    if (evaluation.result === 'white-wins') return 'w';
    if (evaluation.result === 'black-wins') return 'b';
    return null;
  }
  if (evaluation.kind !== 'mate') return null;
  return evaluation.mateIn >= 0 ? 'w' : 'b';
}

/** Classifies how the forced-mate picture changed across a ply. Purely factual. */
export function mateTransition(before: Evaluation, after: Evaluation): MateTransition {
  const mateBefore = matingSide(before);
  const mateAfter = matingSide(after);

  if (mateBefore === null && mateAfter === null) return 'none';
  if (mateBefore === null) return 'mate-appeared';
  if (mateAfter === null) return 'mate-disappeared';
  return mateBefore === mateAfter ? 'mate-sustained' : 'mate-flipped';
}

/**
 * Human-readable evaluation, always written from White's point of view so it
 * matches the stored convention: "+1.24", "-0.30", "#4" (White mates in 4),
 * "#-2" (Black mates in 2).
 */
export function formatEvaluation(evaluation: Evaluation): string {
  if (evaluation.kind === 'terminal') {
    if (evaluation.result === 'white-wins') return '1-0';
    if (evaluation.result === 'black-wins') return '0-1';
    return '½-½';
  }
  if (evaluation.kind === 'mate') {
    return `#${evaluation.mateIn}`;
  }
  const pawns = evaluation.cp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}

/** Human-readable swing in pawns, e.g. "-4.20". */
export function formatSwingCp(swingCp: number): string {
  const pawns = swingCp / 100;
  return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`;
}
