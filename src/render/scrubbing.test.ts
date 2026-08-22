import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { assignPieceIdentities } from '../pgn/assignPieceIdentities';
import type { GameRecord } from '../pgn/types';
import { buildTrivialTimeline, MOVE_DURATION_MS } from '../timeline/buildTrivialTimeline';
import type { MoveBeat, Scene } from '../timeline/types';
import { excludedSquares, resolvePosition } from './resolvePosition';
import { resolveAnimations } from './resolveAnimations';
import { parseFenPlacement, pieceAtSquare } from './fen';

/**
 * Drives a real game through ChessJsEngine (every move individually
 * legality-checked, exactly like parsePgn does) rather than typing FEN
 * by hand, so these fixtures are guaranteed-legal.
 */
function driveGame(moves: Array<[string, string, ('q' | 'r' | 'b' | 'n')?]>): GameRecord {
  const engine = new ChessJsEngine();
  const results = moves.map(([from, to, promotion]) => {
    const r = engine.move(from, to, promotion);
    if (!r.ok) throw new Error(`illegal setup move ${from}-${to}: ${r.error.message}`);
    return r.value;
  });
  const moveRecords = assignPieceIdentities(results);
  const positions = [{ ply: 0, fen: results[0]!.before }];
  results.forEach((m, i) => positions.push({ ply: i + 1, fen: m.after }));
  return { headers: {}, positions, moves: moveRecords };
}

function sceneOf(game: GameRecord): Scene {
  return buildTrivialTimeline(game).scenes[0]!;
}

describe('scrubbing: forward correctness', () => {
  it('produces the correct position at each successive move boundary', () => {
    const game = driveGame([
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3']
    ]);
    const scene = sceneOf(game);

    expect(pieceAtSquare(resolvePosition(game, scene, 0).baseFen, 'e2')).toEqual({ type: 'p', color: 'w' });
    expect(pieceAtSquare(resolvePosition(game, scene, 600).baseFen, 'e4')).toEqual({ type: 'p', color: 'w' });
    expect(pieceAtSquare(resolvePosition(game, scene, 1200).baseFen, 'e5')).toEqual({ type: 'p', color: 'b' });
    expect(pieceAtSquare(resolvePosition(game, scene, 1800).baseFen, 'f3')).toEqual({ type: 'n', color: 'w' });
  });
});

describe('scrubbing: backward correctness', () => {
  it('scrubbing backward after scrubbing forward yields the same result as querying that time directly', () => {
    const game = driveGame([
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
      ['b8', 'c6']
    ]);
    const scene = sceneOf(game);
    const times = [0, 600, 1200, 1800, 2400];

    // Baseline: query every time once, in forward order.
    const forward = times.map((t) => resolvePosition(game, scene, t));

    // Now scrub backward from the end, interleaved with a jump to a much
    // later time in between, then compare against the forward baseline.
    resolvePosition(game, scene, 2400);
    const backward = [...times].reverse().map((t) => resolvePosition(game, scene, t));
    resolvePosition(game, scene, 0);
    const again = times.map((t) => resolvePosition(game, scene, t));

    times.forEach((t, i) => {
      expect(forward[i]).toEqual(again[i]);
      const backwardEntry = backward[times.length - 1 - i];
      expect(backwardEntry).toEqual(forward[i]);
    });
  });
});

describe('scrubbing across a capture', () => {
  const game = driveGame([
    ['e2', 'e4'],
    ['d7', 'd5'],
    ['e4', 'd5']
  ]);
  const scene = sceneOf(game);
  const captureBeat = scene.beats[2] as MoveBeat;

  it('does not resurrect the captured piece once the capturing beat has settled, scrubbing forward then back and forward again', () => {
    const beforeSettle = resolvePosition(game, scene, captureBeat.atMs); // capture beat just started
    expect(pieceAtSquare(beforeSettle.baseFen, 'd5')).toEqual({ type: 'p', color: 'b' }); // black pawn still there pre-flight

    const settled = resolvePosition(game, scene, captureBeat.atMs + captureBeat.durationMs);
    expect(pieceAtSquare(settled.baseFen, 'd5')).toEqual({ type: 'p', color: 'w' }); // only the capturing pawn remains

    // Scrub back to before the capture...
    const backBefore = resolvePosition(game, scene, captureBeat.atMs);
    expect(pieceAtSquare(backBefore.baseFen, 'd5')).toEqual({ type: 'p', color: 'b' });

    // ...and forward again past it. The captured pawn must not have
    // "come back" incorrectly at the settled time.
    const forwardAgain = resolvePosition(game, scene, captureBeat.atMs + captureBeat.durationMs);
    expect(pieceAtSquare(forwardAgain.baseFen, 'd5')).toEqual({ type: 'p', color: 'w' });
  });
});

describe('scrubbing across promotion', () => {
  // 1. a4 b5 2. axb5 a6 3. bxa6 Nf6 4. a7 Ne4 5. axb8=Q (captures the untouched b8 knight)
  const game = driveGame([
    ['a2', 'a4'],
    ['b7', 'b5'],
    ['a4', 'b5'],
    ['a7', 'a6'],
    ['b5', 'a6'],
    ['g8', 'f6'],
    ['a6', 'a7'],
    ['f6', 'e4'],
    ['a7', 'b8', 'q']
  ]);
  const scene = sceneOf(game);
  const promotionBeat = scene.beats[8] as MoveBeat;

  it('renders a pawn while the promoting move is in flight and the promoted piece once settled — in both scrub directions', () => {
    const midFlight = resolvePosition(game, scene, promotionBeat.atMs + promotionBeat.durationMs / 2);
    expect(pieceAtSquare(midFlight.baseFen, 'a7')).toEqual({ type: 'p', color: 'w' });

    const settled = resolvePosition(game, scene, promotionBeat.atMs + promotionBeat.durationMs);
    expect(pieceAtSquare(settled.baseFen, 'b8')).toEqual({ type: 'q', color: 'w' });
    expect(pieceAtSquare(settled.baseFen, 'a7')).toBeNull();

    // Scrub back into the middle of the promoting move...
    const backToMid = resolvePosition(game, scene, promotionBeat.atMs + promotionBeat.durationMs / 2);
    expect(pieceAtSquare(backToMid.baseFen, 'a7')).toEqual({ type: 'p', color: 'w' });
    // the target knight is still visible mid-flight — it isn't removed
    // from the board until the capturing beat settles, same as any
    // other capture (see "scrubbing across a capture" above)
    expect(pieceAtSquare(backToMid.baseFen, 'b8')).toEqual({ type: 'n', color: 'b' });

    // ...and forward again: the queen renders correctly, not a pawn.
    const forwardAgain = resolvePosition(game, scene, promotionBeat.atMs + promotionBeat.durationMs);
    expect(pieceAtSquare(forwardAgain.baseFen, 'b8')).toEqual({ type: 'q', color: 'w' });
  });
});

describe('scrubbing across castling', () => {
  const game = driveGame([
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
    ['f1', 'c4'],
    ['f8', 'c5'],
    ['e1', 'g1'] // O-O
  ]);
  const scene = sceneOf(game);
  const castleBeat = scene.beats[6] as MoveBeat;

  it('renders both king and rook correctly before, during, and after castling, in both scrub directions', () => {
    expect(castleBeat.rookMove).toBeDefined();

    const before = resolvePosition(game, scene, castleBeat.atMs - 1);
    expect(pieceAtSquare(before.baseFen, 'e1')).toEqual({ type: 'k', color: 'w' });
    expect(pieceAtSquare(before.baseFen, 'h1')).toEqual({ type: 'r', color: 'w' });

    const midFlight = resolvePosition(game, scene, castleBeat.atMs + castleBeat.durationMs / 2);
    const excluded = excludedSquares(midFlight.activeBeats);
    expect(excluded.has('e1')).toBe(true); // king mid-flight, not double-drawn from baseFen
    expect(excluded.has('h1')).toBe(true); // rook mid-flight too
    const animated = resolveAnimations(midFlight.baseFen, midFlight.activeBeats, castleBeat.atMs + castleBeat.durationMs / 2);
    expect(animated.map((f) => f.pieceId).sort()).toEqual(['w-k-e1', 'w-r-h1'].sort());

    const settled = resolvePosition(game, scene, castleBeat.atMs + castleBeat.durationMs);
    expect(pieceAtSquare(settled.baseFen, 'g1')).toEqual({ type: 'k', color: 'w' });
    expect(pieceAtSquare(settled.baseFen, 'f1')).toEqual({ type: 'r', color: 'w' });
    expect(pieceAtSquare(settled.baseFen, 'e1')).toBeNull();
    expect(pieceAtSquare(settled.baseFen, 'h1')).toBeNull();

    // Scrub back before castling, then forward again.
    const backBefore = resolvePosition(game, scene, castleBeat.atMs - 1);
    expect(pieceAtSquare(backBefore.baseFen, 'e1')).toEqual({ type: 'k', color: 'w' });
    const forwardAgain = resolvePosition(game, scene, castleBeat.atMs + castleBeat.durationMs);
    expect(pieceAtSquare(forwardAgain.baseFen, 'g1')).toEqual({ type: 'k', color: 'w' });
    expect(pieceAtSquare(forwardAgain.baseFen, 'f1')).toEqual({ type: 'r', color: 'w' });
  });
});

describe('scrubbing does not create ghost pieces', () => {
  // A longer game with several captures, so there are plenty of
  // opportunities for a static+animated double-draw to slip through.
  const game = driveGame([
    ['e2', 'e4'],
    ['e7', 'e5'],
    ['g1', 'f3'],
    ['b8', 'c6'],
    ['f1', 'b5'],
    ['a7', 'a6'],
    ['b5', 'c6'], // capture
    ['d7', 'c6'], // recapture
    ['e1', 'g1'], // O-O
    ['f8', 'd6'],
    ['d2', 'd4'],
    ['e5', 'd4'] // capture
  ]);
  const scene = sceneOf(game);

  // Deliberately non-monotonic (mixes forward jumps, backward jumps,
  // and re-visits) — a stateful "hide this square" flag, like the
  // legacy app's animHideSquare, would desync under exactly this kind
  // of access pattern.
  const scrubOrder = [
    0, 3000, 1500, 600, 4200, 300, 3900, 1800, 900, 4800,
    2100, 1200, 0, 5100, 2700, 3300, 6600, 1500, 4500
  ];

  it('every square an active beat is moving out of is excluded from the static layer, at every sampled scrub position', () => {
    for (const t of scrubOrder) {
      const { baseFen, activeBeats } = resolvePosition(game, scene, t);
      const excluded = excludedSquares(activeBeats);
      for (const beat of activeBeats) {
        expect(excluded.has(beat.from), `t=${t} beat.from=${beat.from}`).toBe(true);
        if (beat.rookMove) {
          expect(excluded.has(beat.rookMove.from), `t=${t} rookMove.from=${beat.rookMove.from}`).toBe(true);
        }
      }
      // and every excluded square really did have a piece in the base layer
      // (an excluded square with nothing to exclude would indicate stale data)
      for (const sq of excluded) {
        expect(pieceAtSquare(baseFen, sq), `t=${t} excluded square ${sq} has no piece to exclude`).not.toBeNull();
      }
    }
  });

  it('the number of pieces drawn (static minus excluded, plus animated) always equals the base layer\'s own occupant count — no piece is ever drawn twice or dropped', () => {
    for (const t of scrubOrder) {
      const { baseFen, activeBeats } = resolvePosition(game, scene, t);
      const staticCount = parseFenPlacement(baseFen).size;
      const excludedCount = excludedSquares(activeBeats).size;
      const animated = resolveAnimations(baseFen, activeBeats, t);
      const drawnCount = (staticCount - excludedCount) + animated.length;
      expect(drawnCount, `t=${t}`).toBe(staticCount);
    }
  });
});
