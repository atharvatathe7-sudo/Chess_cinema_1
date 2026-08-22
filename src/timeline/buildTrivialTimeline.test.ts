import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from '../pgn/parsePgn';
import { buildTrivialTimeline, MOVE_DURATION_MS } from './buildTrivialTimeline';
import { validateTimeline } from './invariants';

const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

function parsedGame() {
  const result = parsePgn(PGN, new ChessJsEngine());
  if (!result.ok) throw new Error('fixture PGN failed to parse');
  return result.value;
}

describe('buildTrivialTimeline', () => {
  it('produces exactly one Scene with one sequential, non-overlapping beat per ply', () => {
    const game = parsedGame();
    const timeline = buildTrivialTimeline(game);

    expect(timeline.scenes).toHaveLength(1);
    const scene = timeline.scenes[0]!;
    expect(scene.beats).toHaveLength(game.moves.length);

    scene.beats.forEach((beat, i) => {
      expect(beat.kind).toBe('move');
      expect(beat.atMs).toBe(i * MOVE_DURATION_MS);
    });
    expect(scene.durationMs).toBe(game.moves.length * MOVE_DURATION_MS);
  });

  it('always produces a Timeline that satisfies the lane invariants', () => {
    const timeline = buildTrivialTimeline(parsedGame());
    expect(validateTimeline(timeline)).toEqual([]);
  });

  it('carries pieceId, rookMove, and capture data through from the GameRecord', () => {
    const game = parsedGame();
    const timeline = buildTrivialTimeline(game);
    const scene = timeline.scenes[0]!;
    const castlingBeat = scene.beats.find((b) => b.kind === 'move' && b.rookMove);
    expect(castlingBeat).toBeDefined();
  });
});
