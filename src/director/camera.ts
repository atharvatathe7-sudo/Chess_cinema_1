import type { GameRecord } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import type { StoryPlan } from '../story/types';
import { parseFenPlacement } from '../render/fen';
import type { CameraDirective } from './types';

/**
 * The one v1 camera rule: a single zoom, anchored only on the 'climax'
 * StoryBeat, if one exists. Deliberately not a generalized cinematic
 * camera framework — see the Phase 2.4 specification's camera model. No
 * independent camera decision is made for any other beat role or for any
 * ArchetypeSignal that doesn't overlap the climax beat.
 */
export function deriveCameraDirectives(
  game: GameRecord,
  understanding: GameUnderstanding,
  story: StoryPlan
): readonly CameraDirective[] {
  const climaxBeat = story.beats.find((b) => b.role === 'climax');
  if (!climaxBeat) return [];

  const climaxPly = climaxBeat.plies[0];
  if (climaxPly === undefined) return [];

  const move = game.moves.find((m) => m.ply === climaxPly);
  if (!move) return [];

  const squares = new Set<string>([move.from, move.to]);

  // Only for the case where the position right after this ply is actually
  // checkmate (forced-mate-delivery) does a "mated king square" mean
  // anything precise — 'mate-appeared' means mate is now forced but not
  // yet delivered, so there is no mated king to focus on yet.
  const turningPointId = climaxBeat.evidenceRefs.turningPointId;
  const tp = turningPointId ? understanding.turningPoints.find((t) => t.id === turningPointId) : undefined;
  if (tp?.kind === 'forced-mate-delivery') {
    const position = game.positions[climaxPly];
    if (position) {
      // The mated king belongs to the side to move in the resulting
      // position — i.e. the opposite of whoever just delivered the mate
      // (same convention analyzeGame.ts's terminalEvaluation already uses).
      const matedColor = oppositeColorOf(move.color);
      const board = parseFenPlacement(position.fen);
      for (const [square, piece] of board) {
        if (piece.type === 'k' && piece.color === matedColor) {
          squares.add(square);
          break;
        }
      }
    }
  }

  const uniqueSquares = [...squares];
  // Never a single-square-only focus (see spec) — in practice this never
  // happens, since a legal move's from/to are always distinct.
  if (uniqueSquares.length < 2) return [];

  return [
    {
      atPly: climaxPly,
      focus: 'square-pair',
      squares: uniqueSquares,
      evidenceRef: { kind: 'beat', id: climaxBeat.id }
    }
  ];
}

function oppositeColorOf(color: 'w' | 'b'): 'w' | 'b' {
  return color === 'w' ? 'b' : 'w';
}
