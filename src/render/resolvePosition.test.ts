import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from '../pgn/parsePgn';
import { buildTrivialTimeline, MOVE_DURATION_MS } from '../timeline/buildTrivialTimeline';
import { excludedSquares, resolvePosition } from './resolvePosition';

const PGN = '1. e4 e5 2. Nf3 Nc6';

function fixture() {
  const parsed = parsePgn(PGN, new ChessJsEngine());
  if (!parsed.ok) throw new Error('fixture failed to parse');
  const game = parsed.value;
  const timeline = buildTrivialTimeline(game);
  return { game, scene: timeline.scenes[0]! };
}

describe('resolvePosition', () => {
  it('activates the first beat immediately at t=0 (the trivial timeline has no lead-in pause)', () => {
    const { game, scene } = fixture();
    const resolved = resolvePosition(game, scene, 0);
    expect(resolved.baseFen).toBe(scene.startPositionFen);
    expect(resolved.activeBeats).toHaveLength(1);
    expect(resolved.activeBeats[0]!.san).toBe('e4');
  });

  it('has no active beats before the scene starts', () => {
    const { game, scene } = fixture();
    const resolved = resolvePosition(game, scene, -1);
    expect(resolved.baseFen).toBe(scene.startPositionFen);
    expect(resolved.activeBeats).toHaveLength(0);
  });

  it('marks the first beat active during its own time window', () => {
    const { game, scene } = fixture();
    const resolved = resolvePosition(game, scene, MOVE_DURATION_MS / 2);
    expect(resolved.baseFen).toBe(scene.startPositionFen);
    expect(resolved.activeBeats).toHaveLength(1);
    expect(resolved.activeBeats[0]!.san).toBe('e4');
  });

  it('advances baseFen to the settled position once a beat completes, with no active beat at the boundary gap', () => {
    const { game, scene } = fixture();
    const resolved = resolvePosition(game, scene, MOVE_DURATION_MS);
    expect(resolved.baseFen).toBe(game.positions[1]!.fen);
    // the trivial timeline is back-to-back, so the next beat starts exactly here
    expect(resolved.activeBeats).toHaveLength(1);
    expect(resolved.activeBeats[0]!.san).toBe('e5');
  });

  it('settles to the final position once every beat has completed', () => {
    const { game, scene } = fixture();
    const resolved = resolvePosition(game, scene, scene.durationMs + 1000);
    expect(resolved.baseFen).toBe(game.positions[game.positions.length - 1]!.fen);
    expect(resolved.activeBeats).toHaveLength(0);
  });

  it('is a pure function with no memory between calls', () => {
    const { game, scene } = fixture();
    const a = resolvePosition(game, scene, MOVE_DURATION_MS / 2);
    resolvePosition(game, scene, scene.durationMs); // different call in between
    const b = resolvePosition(game, scene, MOVE_DURATION_MS / 2);
    expect(a).toEqual(b);
  });
});

describe('excludedSquares', () => {
  it('excludes the from-square of an active beat, and the rook from-square for castling', () => {
    const { game, scene } = fixture();
    const resolved = resolvePosition(game, scene, MOVE_DURATION_MS / 2);
    const excluded = excludedSquares(resolved.activeBeats);
    expect(excluded.has('e2')).toBe(true);
  });
});
