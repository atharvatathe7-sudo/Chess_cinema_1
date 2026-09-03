import type { Color, PieceType } from '../chess/ChessEngine';
import type { PlyAnalysis } from '../analysis/types';
import type { Evidence } from './types';
import { attackSquaresFrom, attackersOf, boardFromFen, coordsOf, squareName, staticExchangeEvaluation, type Board } from './geometry';

/**
 * Phase 16 (MUST HAVE 8) — the minimum reliable defender-removal primitive.
 *
 * The claim this exists to support is the STRONGER FACT on the claim ladder:
 *
 *   FACT           "Black lost a piece."
 *   STRONGER FACT  "Black's defender of e5 was removed, and e5 is now
 *                   winnable."                                  <- this module
 *   CAUSAL CLAIM   "Removing that defender allowed e5 to become decisive."
 *                                    <- NOT this module; that needs the chain
 *                                       AND the claim ladder to permit it.
 *
 * Deliberately NOT "a piece was captured". A capture is not a defender loss:
 * the captured piece may have been defending nothing, or the target it
 * defended may still be defended enough afterwards. Both of those produce a
 * capture and no record here.
 *
 * A record is emitted only when all five of MUST HAVE 8's requirements are
 * established from the board itself:
 *
 *   relevant target        a friendly, non-king piece the departing piece was
 *                          actually defending in the position BEFORE the move
 *   relevant defender      the piece that occupied a square this move vacated
 *   defender state before  attackersOf(before, target, defendingSide)
 *   defender state after   attackersOf(after,  target, defendingSide)
 *   meaningful loss        the count dropped AND the target went from "not
 *                          profitably takeable" to "profitably takeable",
 *                          measured by SEE
 *
 * The SEE gate is what makes this reliable rather than merely arithmetic. A
 * defender count falling from 3 to 2 on an over-defended piece changes
 * nothing, and produces no record; a count falling from 1 to 0 on a piece the
 * opponent can now simply win does, and is exactly the fact worth reporting.
 *
 * Everything is pure board geometry over the ply's own fenBefore/fenAfter,
 * reusing attackersOf / attackSquaresFrom / staticExchangeEvaluation. No
 * engine call, no evaluation input, no new tactical engine.
 *
 * Known, deliberate conservatism (under-detection, never over-claim):
 *   - castling vacates the rook's square too; only the king's origin square is
 *     considered, so a rook that stops defending something by castling is not
 *     reported.
 *   - en passant removes a pawn that is not standing on the move's destination
 *     square, so that capture is not treated as removing a defender.
 *   Both cases silently produce no record rather than a guessed one.
 */

export interface DefenderLossRecord {
  readonly ply: number;
  /** The square the departing defender occupied before this move. */
  readonly defenderSquare: string;
  readonly defenderType: PieceType;
  /** The side whose defensive coverage was reduced. */
  readonly defendingSide: Color;
  /** The square whose defence collapsed. */
  readonly targetSquare: string;
  readonly targetType: PieceType;
  readonly defendersBefore: number;
  readonly defendersAfter: number;
  /** SEE on targetSquare for the side attacking it, before and after this move. */
  readonly seeBefore: number;
  readonly seeAfter: number;
  readonly evidence: Evidence;
}

function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w';
}

function pieceAt(board: Board, square: string): { type: PieceType; color: Color } | null {
  const { r, f } = coordsOf(square);
  const cell = board[r]?.[f];
  return cell ? { type: cell.type, color: cell.color } : null;
}

/**
 * Squares this move emptied of the piece that stood there: always the origin
 * square, plus the destination when it held a piece that this move captured.
 */
function vacatedSquares(boardBefore: Board, from: string, to: string): string[] {
  const squares = [from];
  if (pieceAt(boardBefore, to)) squares.push(to);
  return squares;
}

/**
 * Defender-loss records for one ply. Pure and deterministic given the ply's
 * own FENs; returns an empty array whenever nothing clears the SEE gate.
 */
export function detectDefenderLoss(ply: PlyAnalysis): DefenderLossRecord[] {
  let boardBefore: Board;
  let boardAfter: Board;
  try {
    boardBefore = boardFromFen(ply.fenBefore);
    boardAfter = boardFromFen(ply.fenAfter);
  } catch {
    // An unreadable position is a missing measurement, not an error condition
    // — the same discipline story/gameOutcome.ts's safeMaterialBalance uses.
    return [];
  }

  const from = ply.movePlayedUci.slice(0, 2);
  const to = ply.movePlayedUci.slice(2, 4);
  if (from.length !== 2 || to.length !== 2) return [];

  const records: DefenderLossRecord[] = [];
  const seen = new Set<string>();

  for (const defenderSquare of vacatedSquares(boardBefore, from, to)) {
    const defender = pieceAt(boardBefore, defenderSquare);
    if (!defender) continue;
    const defendingSide = defender.color;
    const attackingSide = opposite(defendingSide);
    const { r, f } = coordsOf(defenderSquare);

    for (const sq of attackSquaresFrom(boardBefore, r, f)) {
      const targetSquare = squareName(sq.f, sq.r);
      const occupantBefore = boardBefore[sq.r]?.[sq.f];
      // It only DEFENDED a square that held one of its own pieces. A king is
      // never "defended" in the exchange sense, so it is not a target here.
      if (!occupantBefore || occupantBefore.color !== defendingSide || occupantBefore.type === 'k') continue;

      // The target must still be the same piece afterwards, or there is no
      // continuing target whose defence could be said to have collapsed.
      const occupantAfter = boardAfter[sq.r]?.[sq.f];
      if (!occupantAfter || occupantAfter.color !== defendingSide || occupantAfter.type !== occupantBefore.type) continue;

      const defendersBefore = attackersOf(boardBefore, sq, defendingSide).length;
      const defendersAfter = attackersOf(boardAfter, sq, defendingSide).length;
      if (defendersAfter >= defendersBefore) continue;

      // The meaningful-loss test. Losing one of several adequate defenders
      // changes nothing; this asks whether the target actually became
      // profitably takeable, which is the only version of the fact worth
      // asserting downstream.
      const seeBefore = staticExchangeEvaluation(boardBefore, sq, attackingSide);
      const seeAfter = staticExchangeEvaluation(boardAfter, sq, attackingSide);
      if (seeBefore > 0 || seeAfter <= 0) continue;

      const key = `${defenderSquare}>${targetSquare}`;
      if (seen.has(key)) continue;
      seen.add(key);

      records.push({
        ply: ply.ply,
        defenderSquare,
        defenderType: defender.type,
        defendingSide,
        targetSquare,
        targetType: occupantBefore.type,
        defendersBefore,
        defendersAfter,
        seeBefore,
        seeAfter,
        evidence: {
          basis: 'chess-rule',
          sourcePlies: [ply.ply],
          note: `${defenderSquare} (${defender.type}) left; ${targetSquare} defenders ${defendersBefore}->${defendersAfter}, SEE ${seeBefore}->${seeAfter}`
        }
      });
    }
  }

  return records.sort((a, b) => (a.defenderSquare < b.defenderSquare ? -1 : a.defenderSquare > b.defenderSquare ? 1 : a.targetSquare < b.targetSquare ? -1 : 1));
}
