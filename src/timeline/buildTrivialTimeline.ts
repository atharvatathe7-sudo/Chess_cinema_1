import type { GameRecord } from '../pgn/types';
import type { MoveBeat, Scene, Timeline } from './types';

/** Phase 1's only Timeline generator: one Scene, one MoveBeat per ply, a static camera. */
export const MOVE_DURATION_MS = 600;

/**
 * Builds the trivial Phase 1 Timeline: a single Scene spanning the whole
 * game, with sequential, non-overlapping MoveBeats (this is what makes
 * the "no two beats for the same piece overlap in time" invariant hold
 * trivially for this generator — see timeline/invariants.ts) and one
 * static full-board camera keyframe.
 *
 * Later, smarter generators (motif-aware, story-aware, cinematic) will
 * replace this function but return the same Timeline shape, so nothing
 * downstream (renderer, export) needs to change.
 */
export function buildTrivialTimeline(game: GameRecord): Timeline {
  const beats: MoveBeat[] = game.moves.map((m, index) => ({
    kind: 'move',
    san: m.san,
    pieceId: m.pieceId,
    from: m.from,
    to: m.to,
    atMs: index * MOVE_DURATION_MS,
    durationMs: MOVE_DURATION_MS,
    capturedPieceId: m.capturedPieceId,
    promotion: m.promotion,
    isEnPassant: m.isEnPassant,
    rookMove: m.rookMove,
    resultingPly: m.ply
  }));

  const durationMs = beats.length * MOVE_DURATION_MS;
  const startPosition = game.positions[0];
  if (!startPosition) {
    throw new Error('buildTrivialTimeline: GameRecord has no starting position');
  }

  const scene: Scene = {
    id: 'scene-0',
    startPositionFen: startPosition.fen,
    startPly: 0,
    beats,
    cameraPlan: {
      keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }]
    },
    durationMs
  };

  return { scenes: [scene] };
}
