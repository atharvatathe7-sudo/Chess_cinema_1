import { STANDARD_STARTING_PIECE_IDS } from '../pgn/assignPieceIdentities';
import { parsePieceId } from '../pgn/pieceId';
import type { PieceId } from '../pgn/types';
import type { MoveBeat, Scene, Timeline } from './types';

export interface TimelineViolation {
  code:
    | 'unknown-piece-id'
    | 'overlapping-lane'
    | 'move-after-capture'
    | 'bad-castling-rook';
  sceneId: string;
  pieceId: PieceId;
  message: string;
}

const KNOWN_PIECE_IDS = new Set<PieceId>(STANDARD_STARTING_PIECE_IDS);

function moveBeats(scene: Scene): MoveBeat[] {
  return scene.beats.filter((b): b is MoveBeat => b.kind === 'move');
}

function expectedRookId(kingPieceId: PieceId, side: 'king' | 'queen'): PieceId {
  const { color } = parsePieceId(kingPieceId);
  const rank = color === 'w' ? '1' : '8';
  const file = side === 'king' ? 'h' : 'a';
  return `${color}-r-${file}${rank}`;
}

/**
 * Validates the lane invariants documented in docs/architecture.md
 * (Correction 3). Pure, side-effect free — returns every violation
 * found rather than throwing on the first one, so a caller (tests, or
 * the store on a timeline mutation) can report everything wrong at once.
 */
export function validateTimeline(timeline: Timeline): TimelineViolation[] {
  const violations: TimelineViolation[] = [];

  for (const scene of timeline.scenes) {
    const beats = moveBeats(scene);
    const capturedBy = new Map<PieceId, number>(); // pieceId -> atMs of the beat that captured it
    const lastWindowEndByPiece = new Map<PieceId, number>();

    // Invariant 2 requires processing in chronological order.
    const sorted = [...beats].sort((a, b) => a.atMs - b.atMs);

    for (const beat of sorted) {
      const idsInThisBeat = [beat.pieceId, ...(beat.rookMove ? [beat.rookMove.pieceId] : [])];

      // Invariant 1: no orphan ids.
      for (const id of idsInThisBeat) {
        if (!KNOWN_PIECE_IDS.has(id)) {
          violations.push({
            code: 'unknown-piece-id',
            sceneId: scene.id,
            pieceId: id,
            message: `Beat at ${beat.atMs}ms references unknown PieceId "${id}".`
          });
        }
      }

      // Invariant 3: a captured piece cannot move again.
      if (capturedBy.has(beat.pieceId)) {
        violations.push({
          code: 'move-after-capture',
          sceneId: scene.id,
          pieceId: beat.pieceId,
          message: `PieceId "${beat.pieceId}" moves at ${beat.atMs}ms after being captured earlier in the scene.`
        });
      }

      // Invariant 2: no overlapping lane windows for the same piece
      // (checked for the mover and, separately, for a castling rook).
      for (const id of idsInThisBeat) {
        const windowEnd = beat.atMs + beat.durationMs;
        const priorEnd = lastWindowEndByPiece.get(id);
        if (priorEnd !== undefined && beat.atMs < priorEnd) {
          violations.push({
            code: 'overlapping-lane',
            sceneId: scene.id,
            pieceId: id,
            message: `PieceId "${id}" has overlapping move windows in scene "${scene.id}" (one ends at ${priorEnd}ms, another starts at ${beat.atMs}ms).`
          });
        }
        lastWindowEndByPiece.set(id, windowEnd);
      }

      // Invariant 4: castling rookMove must reference the correct starting rook.
      if (beat.rookMove) {
        const expected = expectedRookId(beat.pieceId, inferSide(beat));
        if (beat.rookMove.pieceId !== expected) {
          violations.push({
            code: 'bad-castling-rook',
            sceneId: scene.id,
            pieceId: beat.rookMove.pieceId,
            message: `Castling beat for "${beat.pieceId}" at ${beat.atMs}ms expected rook "${expected}" but got "${beat.rookMove.pieceId}".`
          });
        }
      }

      if (beat.capturedPieceId) {
        capturedBy.set(beat.capturedPieceId, beat.atMs);
      }
    }
  }

  return violations;
}

function inferSide(beat: MoveBeat): 'king' | 'queen' {
  const file = beat.to.charAt(0);
  return file === 'g' ? 'king' : 'queen';
}

export function assertValidTimeline(timeline: Timeline): void {
  const violations = validateTimeline(timeline);
  if (violations.length > 0) {
    const summary = violations.map((v) => v.message).join('\n');
    throw new Error(`Timeline failed invariant checks:\n${summary}`);
  }
}
