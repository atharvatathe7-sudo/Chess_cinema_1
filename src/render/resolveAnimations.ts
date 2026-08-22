import type { Color, PieceType } from '../chess/ChessEngine';
import type { PieceId } from '../pgn/types';
import type { MoveBeat } from '../timeline/types';
import { pieceAtSquare } from './fen';
import { easeOutCubic } from './coords';

export interface AnimatedPieceFrame {
  pieceId: PieceId;
  type: PieceType;
  color: Color;
  from: string;
  to: string;
  /** Eased 0..1 progress along the from->to path. */
  progress: number;
}

/**
 * Derives, purely from the active beats and the pre-move board (baseFen
 * — see resolvePosition), where every mid-flight piece is right now.
 * There is no stored "animation state" this reads instead: calling this
 * twice with the same arguments always returns the same result, and
 * nothing here remembers the previous call (docs/architecture.md
 * Correction 2).
 *
 * A castling beat yields two frames — the king and the rookMove — both
 * keyed by their own stable PieceId (Correction 3).
 */
export function resolveAnimations(
  baseFen: string,
  activeBeats: MoveBeat[],
  logicalTimeMs: number
): AnimatedPieceFrame[] {
  const frames: AnimatedPieceFrame[] = [];

  for (const beat of activeBeats) {
    const rawT = beat.durationMs === 0 ? 1 : (logicalTimeMs - beat.atMs) / beat.durationMs;
    const progress = easeOutCubic(rawT);

    const mover = pieceAtSquare(baseFen, beat.from);
    if (mover) {
      frames.push({ pieceId: beat.pieceId, type: mover.type, color: mover.color, from: beat.from, to: beat.to, progress });
    }

    if (beat.rookMove) {
      const rook = pieceAtSquare(baseFen, beat.rookMove.from);
      if (rook) {
        frames.push({
          pieceId: beat.rookMove.pieceId,
          type: rook.type,
          color: rook.color,
          from: beat.rookMove.from,
          to: beat.rookMove.to,
          progress
        });
      }
    }
  }

  return frames;
}
