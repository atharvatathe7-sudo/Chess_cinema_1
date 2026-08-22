import type { GameRecord } from '../pgn/types';
import type { MoveBeat, Scene } from '../timeline/types';

export interface ResolvedPosition {
  /** FEN of the board with every fully-settled piece — excludes anything mid-flight. */
  baseFen: string;
  /** Beats whose time window contains logicalTimeMs (usually 0 or 1 for Phase 1's trivial timeline). */
  activeBeats: MoveBeat[];
}

/**
 * The single source of truth for "what does the board look like at time
 * T" — derived purely from Scene.beats and GameRecord.positions, per
 * docs/architecture.md Correction 2. No animation/position state is
 * read from anywhere else.
 */
export function resolvePosition(game: GameRecord, scene: Scene, logicalTimeMs: number): ResolvedPosition {
  const moveBeats = scene.beats.filter((b): b is MoveBeat => b.kind === 'move');
  const sorted = [...moveBeats].sort((a, b) => a.atMs - b.atMs);

  let baseFen = scene.startPositionFen;
  const activeBeats: MoveBeat[] = [];

  for (const beat of sorted) {
    const windowEnd = beat.atMs + beat.durationMs;
    if (windowEnd <= logicalTimeMs) {
      const snapshot = game.positions[beat.resultingPly];
      if (!snapshot) {
        throw new Error(`resolvePosition: GameRecord has no position snapshot for ply ${beat.resultingPly}`);
      }
      baseFen = snapshot.fen;
    } else if (beat.atMs <= logicalTimeMs) {
      activeBeats.push(beat);
    }
  }

  return { baseFen, activeBeats };
}

/** Squares that must be excluded from static piece drawing because an animation owns them this frame. */
export function excludedSquares(activeBeats: MoveBeat[]): Set<string> {
  const squares = new Set<string>();
  for (const beat of activeBeats) {
    squares.add(beat.from);
    if (beat.rookMove) squares.add(beat.rookMove.from);
  }
  return squares;
}
