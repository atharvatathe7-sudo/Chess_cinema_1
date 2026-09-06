import type { Color } from '../chess/ChessEngine';
import { STANDARD_STARTING_PIECE_IDS } from '../pgn/assignPieceIdentities';
import { parsePieceId, pieceIdFor } from '../pgn/pieceId';
import type { GameRecord, PieceId } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import type { CameraDirective, CameraRole, TrackingDirective } from './types';

/**
 * Phase 18D Batch 1 — single-subject piece/king camera tracking.
 *
 * Turns already-verified chess/story facts into a bounded "follow this one
 * piece" directive, without inventing any new chess reasoning. Two subject
 * kinds only, both reliably resolvable from data that already exists:
 *
 *   checked/mated king   PlySignals.deliversCheck/deliversMate (already
 *                        computed by Phase 2.2) names the checked side; the
 *                        king's own PieceId is then just its known starting
 *                        square, resolved by pieceSquareAtPly like any other
 *                        piece.
 *   the span's own mover MoveRecord.pieceId, when — and only when — the
 *                        same piece made every move across the span.
 *
 * Deliberately NOT supported in Batch 1: a verified mechanism's attacker
 * when it didn't itself just move (e.g. a discovery's revealed attacker, or
 * an existing pin merely realized by an unrelated move). Resolving "which
 * piece currently occupies square S" in general requires replaying the
 * WHOLE board's occupancy, not just one piece's own move history — a
 * reusable primitive (occupancyAfterPly) the Phase 18D audit explicitly
 * deferred. Batch 1 does not build it, and so does not track that case.
 */

const STANDARD_STARTING_PIECE_ID_SET: ReadonlySet<PieceId> = new Set(STANDARD_STARTING_PIECE_IDS);

/**
 * The square a stable PieceId occupies immediately after `ply`, resolved by
 * replaying GameRecord.moves — never by scanning a FEN for identity (a FEN
 * alone cannot recover WHICH physical piece is on a square, only its
 * type/color; see pgn/types.ts's own PieceId doc comment, and the Phase 18D
 * audit's explicit "do not use FEN scanning to identify stable piece
 * identity"). This is the same occupancy bookkeeping
 * pgn/assignPieceIdentities.ts already performs once while assigning
 * identities, replayed here rather than retained, since the only other
 * consumer (this module) needs it for a handful of already-selected
 * subjects, not for every piece on every ply.
 *
 * Returns null once the piece has been captured at or before `ply`.
 * Promotion never affects this: a piece keeps its PieceId across promotion
 * (pgn/pieceId.ts), so its square resolves exactly as any other move.
 * Castling is resolved correctly for both the king (via the move's own
 * pieceId/to) and the paired rook (via the move's own rookMove).
 *
 * Throws for a pieceId that is not one of the 32 pieces a standard starting
 * position actually has — the same "reject an inconsistent identity"
 * convention assignPieceIdentities.ts itself uses, rather than silently
 * returning a starting square for a string that was never really assigned.
 */
export function pieceSquareAtPly(game: GameRecord, pieceId: PieceId, ply: number): string | null {
  if (!STANDARD_STARTING_PIECE_ID_SET.has(pieceId)) {
    throw new Error(`pieceSquareAtPly: "${pieceId}" is not a piece from a standard starting position`);
  }

  let square = parsePieceId(pieceId).startingSquare;
  for (const move of game.moves) {
    if (move.ply > ply) break;
    if (move.pieceId === pieceId) {
      square = move.to;
    } else if (move.rookMove?.pieceId === pieceId) {
      square = move.rookMove.to;
    } else if (move.capturedPieceId === pieceId) {
      return null;
    }
  }
  return square;
}

function kingPieceId(color: Color): PieceId {
  return pieceIdFor(color, 'k', color === 'w' ? 'e1' : 'e8');
}

/** Lower wins. Fixed table, never a per-game judgement — mirrors TACTICAL_PRIORITY's own shape in tacticalAnnotations.ts. */
const TRACKING_PRIORITY = {
  'king-safety': 0,
  move: 1
} as const;

function pliesOf(game: GameRecord, atPly: number, untilPly: number): readonly number[] {
  return game.moves.filter((m) => m.ply >= atPly && m.ply <= untilPly).map((m) => m.ply);
}

interface Candidate {
  readonly pieceId: PieceId;
  readonly anchorPly: number;
}

/**
 * The checked/mated king across this span, when — and only when — exactly
 * one side is ever the one delivered check/mate within it. A span where
 * both colors are checked at different points (rare, and not a clean single
 * "king hunt") is deliberately left ambiguous rather than guessed.
 */
function kingCandidate(game: GameRecord, understanding: GameUnderstanding, plies: readonly number[]): Candidate | null {
  const checkedColors = new Set<Color>();
  let anchorPly: number | null = null;

  for (const ply of plies) {
    const semantics = understanding.plies.find((p) => p.ply === ply);
    if (!semantics || (!semantics.signals.deliversCheck && !semantics.signals.deliversMate)) continue;
    const move = game.moves.find((m) => m.ply === ply);
    if (!move) continue;
    checkedColors.add(move.color === 'w' ? 'b' : 'w');
    if (anchorPly === null) anchorPly = ply;
  }

  if (checkedColors.size !== 1 || anchorPly === null) return null;
  const [color] = [...checkedColors];
  const pieceId = kingPieceId(color!);
  if (pieceSquareAtPly(game, pieceId, plies[0]!) === null) return null;
  return { pieceId, anchorPly };
}

/**
 * The single piece that made every move in this span, when — and only when
 * — the same PieceId moved on every one of its plies. A span whose mover
 * changes ply to ply has no single honest subject to follow — never switch
 * subjects mid-shot — and is left untracked (the same rule Batch 2 applies
 * to a ForcedSequence's own alternating responder, generalized here to any
 * span).
 *
 * In practice this means a multi-ply span can essentially never satisfy
 * this candidate: chess alternates sides every ply, so any span longer than
 * one ply necessarily contains at least two different movers. That is
 * correct, not a gap — a genuinely continuous multi-ply subject in real
 * chess is the king-safety case above (the SAME king keeps needing to be
 * shown even though a different attacking piece, and the king's own escape,
 * move each ply), which is exactly why it is tried first.
 */
function moverCandidate(game: GameRecord, plies: readonly number[]): Candidate | null {
  const movers = new Set<PieceId>();
  for (const ply of plies) {
    const move = game.moves.find((m) => m.ply === ply);
    if (move) movers.add(move.pieceId);
  }
  if (movers.size !== 1) return null;
  const [pieceId] = [...movers];
  if (pieceSquareAtPly(game, pieceId!, plies[0]!) === null) return null;
  return { pieceId: pieceId!, anchorPly: plies[0]! };
}

/**
 * Phase 18D Batch 1 — at most one TrackingDirective per CameraDirective, and
 * only for 'critical'/'consequence' roles: never 'establish' (no single
 * subject was asked for there) and never 'payoff' (tracking must never
 * contest the terminal camera's own authority over the final beat — see
 * lowerToTimeline.ts's buildCameraPlan, which additionally never lets a
 * tracked span extend past its own directive's natural hold-end by
 * construction).
 *
 * Subject priority: checked/mated king first, then the span's own single
 * mover (TRACKING_PRIORITY). Produces nothing for a directive where neither
 * resolves reliably — "no tracking is preferable to incorrect tracking".
 * Pure and synchronous; no engine call, no new detector.
 */
export function deriveTrackingDirectives(
  game: GameRecord,
  understanding: GameUnderstanding,
  cameraDirectives: readonly CameraDirective[]
): readonly TrackingDirective[] {
  const trackableRoles: ReadonlySet<CameraRole> = new Set(['critical', 'consequence']);
  const out: TrackingDirective[] = [];

  for (const directive of cameraDirectives) {
    if (!trackableRoles.has(directive.role)) continue;

    const plies = pliesOf(game, directive.atPly, directive.untilPly);
    if (plies.length === 0) continue;

    const king = kingCandidate(game, understanding, plies);
    const chosen: (Candidate & { kind: 'king-safety' | 'move' }) | null = king
      ? { ...king, kind: 'king-safety' }
      : (() => {
          const mover = moverCandidate(game, plies);
          return mover ? { ...mover, kind: 'move' as const } : null;
        })();
    if (!chosen) continue;

    out.push({
      fromPly: directive.atPly,
      toPly: directive.untilPly,
      subject: { kind: 'piece', pieceId: chosen.pieceId },
      role: directive.role,
      priority: TRACKING_PRIORITY[chosen.kind],
      evidenceRef: { kind: chosen.kind, ply: chosen.anchorPly }
    });
  }

  return out;
}
