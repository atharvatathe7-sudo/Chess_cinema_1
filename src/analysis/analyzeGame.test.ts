import { describe, expect, it, vi } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from '../pgn/parsePgn';
import type { GameRecord } from '../pgn/types';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import type { AnalysisEngine } from './AnalysisEngine';
import { analyzeGame } from './analyzeGame';
import { analysisCancelledError, engineProtocolError } from './analysisErrors';
import type { AnalysisSettings, Evaluation, MultiPvResult, PositionEvaluation } from './types';

/**
 * A deterministic stand-in for Stockfish. These tests are about the analysis
 * PIPELINE — position pairing, sign handling, swing derivation, cancellation,
 * terminal positions — none of which should depend on what a real engine
 * happens to think about a position. Fixing the evaluations here keeps these
 * tests stable across engine versions; the real engine is exercised
 * separately by the Chromium integration test.
 */
class ScriptedEngine implements AnalysisEngine {
  public evaluatedFens: string[] = [];
  private index = 0;

  constructor(private readonly script: (Evaluation | 'no-score')[]) {}

  async init(): Promise<Result<void, AppError>> {
    return ok(undefined);
  }

  async evaluatePosition(fen: string, _settings: AnalysisSettings): Promise<Result<PositionEvaluation, AppError>> {
    this.evaluatedFens.push(fen);
    const entry = this.script[this.index] ?? { kind: 'cp', cp: 0 };
    this.index++;
    if (entry === 'no-score') {
      return err(engineProtocolError(`no evaluation returned for position: ${fen}`));
    }
    return ok({
      evaluation: entry,
      bestMove: 'e2e4',
      principalVariation: ['e2e4', 'e7e5'],
      depth: 12
    });
  }

  // Not exercised by these pipeline tests — Phase 2.2's own tests cover it.
  async evaluatePositionMultiPv(): Promise<Result<MultiPvResult, AppError>> {
    return ok({ lines: [] });
  }

  cancel(): void {}
  dispose(): void {}
}

const cp = (value: number): Evaluation => ({ kind: 'cp', cp: value });
const mate = (mateIn: number): Evaluation => ({ kind: 'mate', mateIn });

function gameFrom(pgn: string): GameRecord {
  const parsed = parsePgn(pgn, new ChessJsEngine());
  if (!parsed.ok) throw new Error(`fixture PGN failed to parse: ${parsed.error.message}`);
  return parsed.value;
}

/** A minimal, deterministic fixture: 1. e4 e5 2. Nf3 Nc6 — 4 plies, 5 positions. */
const FIXTURE_PGN = '1. e4 e5 2. Nf3 Nc6';

describe('analyzeGame — pipeline shape', () => {
  it('evaluates every position exactly once (plies + 1)', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(20), cp(30), cp(15), cp(25), cp(10)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());

    expect(result.ok).toBe(true);
    expect(game.moves).toHaveLength(4);
    expect(game.positions).toHaveLength(5);
    expect(engine.evaluatedFens).toHaveLength(5);
    // no position searched twice
    expect(new Set(engine.evaluatedFens).size).toBe(5);
  });

  it('pairs each ply with the evaluations bracketing it', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), cp(100), cp(200), cp(300), cp(400)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());
    if (!result.ok) throw new Error('expected success');

    const plies = result.value.plies;
    expect(plies).toHaveLength(4);
    expect(plies[0]!.evaluationBefore).toEqual(cp(0));
    expect(plies[0]!.evaluationAfter).toEqual(cp(100));
    expect(plies[3]!.evaluationBefore).toEqual(cp(300));
    expect(plies[3]!.evaluationAfter).toEqual(cp(400));
  });

  it('records ply metadata: move number, side to move, SAN, UCI, and both FENs', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), cp(0), cp(0), cp(0), cp(0)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());
    if (!result.ok) throw new Error('expected success');

    const [first, second, third] = result.value.plies;
    expect(first).toMatchObject({ ply: 1, moveNumber: 1, sideToMove: 'w', movePlayedSan: 'e4', movePlayedUci: 'e2e4' });
    expect(second).toMatchObject({ ply: 2, moveNumber: 1, sideToMove: 'b', movePlayedSan: 'e5' });
    expect(third).toMatchObject({ ply: 3, moveNumber: 2, sideToMove: 'w', movePlayedSan: 'Nf3' });
    expect(first!.fenBefore).toBe(game.positions[0]!.fen);
    expect(first!.fenAfter).toBe(game.positions[1]!.fen);
  });

  it('carries best move, principal variation, and depth through from the engine', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), cp(0), cp(0), cp(0), cp(0)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());
    if (!result.ok) throw new Error('expected success');

    expect(result.value.plies[0]!.bestMove).toBe('e2e4');
    expect(result.value.plies[0]!.principalVariation).toEqual(['e2e4', 'e7e5']);
    expect(result.value.plies[0]!.depth).toBe(12);
  });
});

describe('analyzeGame — swing derivation and perspective', () => {
  it('derives white-relative and mover-relative swings correctly for both colours', async () => {
    const game = gameFrom(FIXTURE_PGN);
    // positions:  0:+0.20  1:-0.30  2:+0.50  3:+0.50  4:+0.50
    const engine = new ScriptedEngine([cp(20), cp(-30), cp(50), cp(50), cp(50)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());
    if (!result.ok) throw new Error('expected success');
    const [ply1, ply2] = result.value.plies;

    // Ply 1 played by WHITE: +0.20 -> -0.30 is 50cp against White.
    expect(ply1!.sideToMove).toBe('w');
    expect(ply1!.swingCp).toBe(-50);
    expect(ply1!.swingForMoverCp).toBe(-50);

    // Ply 2 played by BLACK: -0.30 -> +0.50 is 80cp toward White,
    // which is 80cp AGAINST the mover. This is the sign case that a
    // white-relative-only implementation gets backwards.
    expect(ply2!.sideToMove).toBe('b');
    expect(ply2!.swingCp).toBe(80);
    expect(ply2!.swingForMoverCp).toBe(-80);
  });

  it('classifies mate transitions across plies', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), mate(3), mate(-2), cp(10), cp(10)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());
    if (!result.ok) throw new Error('expected success');

    expect(result.value.plies[0]!.mateTransition).toBe('mate-appeared');
    expect(result.value.plies[1]!.mateTransition).toBe('mate-flipped');
    expect(result.value.plies[2]!.mateTransition).toBe('mate-disappeared');
  });

  it('ranks candidates from the derived plies', async () => {
    const game = gameFrom(FIXTURE_PGN);
    // Ply 3 (White) throws away a winning position: +5.00 -> -2.00.
    const engine = new ScriptedEngine([cp(0), cp(10), cp(500), cp(-200), cp(-210)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());
    if (!result.ok) throw new Error('expected success');

    const candidates = result.value.candidates;
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.ply).toBe(3);
    expect(candidates[0]!.swingForMoverCp).toBe(-700);
  });
});

describe('analyzeGame — edge cases', () => {
  it('handles an empty game without calling the engine', async () => {
    const emptyGame: GameRecord = { headers: {}, positions: [], moves: [] };
    const engine = new ScriptedEngine([]);

    const result = await analyzeGame(emptyGame, engine, new ChessJsEngine());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plies).toEqual([]);
    expect(result.value.candidates).toEqual([]);
    expect(engine.evaluatedFens).toHaveLength(0);
  });

  it('handles a single-move game', async () => {
    const game = gameFrom('1. e4');
    const engine = new ScriptedEngine([cp(20), cp(30)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.plies).toHaveLength(1);
    expect(engine.evaluatedFens).toHaveLength(2);
  });

  it('uses the rules engine to evaluate a checkmate position the engine cannot score', async () => {
    // Fool's mate: 1. f3 e5 2. g4 Qh4# — the final position is checkmate,
    // where a real engine legitimately returns no score at all.
    const game = gameFrom('1. f3 e5 2. g4 Qh4#');
    const engine = new ScriptedEngine([cp(0), cp(-50), cp(-40), cp(-300), 'no-score']);

    const result = await analyzeGame(game, engine, new ChessJsEngine());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finalPly = result.value.plies[result.value.plies.length - 1]!;
    // Black delivered mate, so the terminal evaluation is a Black win —
    // derived from the rules, not fabricated as a centipawn number.
    expect(finalPly.evaluationAfter).toEqual({ kind: 'terminal', result: 'black-wins' });
    expect(finalPly.sideToMove).toBe('b');
    // Mate appearing on the board is a swing in the mover's favour.
    expect(finalPly.swingForMoverCp).toBeGreaterThan(0);
    expect(finalPly.mateTransition).toBe('mate-appeared');
    // Checkmate is not a draw — drawReason must never appear on a decisive result.
    expect('drawReason' in finalPly.evaluationAfter).toBe(false);
  });

  it('preserves stalemate as a distinct draw reason (Phase 2.2.1)', async () => {
    // A real, legal sequence (verified against chess.js directly) ending in
    // genuine stalemate for Black — not checkmate, not an ordinary draw.
    const game = gameFrom(
      '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6'
    );
    const engine = new ScriptedEngine([
      cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0),
      cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), cp(0), 'no-score'
    ]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finalPly = result.value.plies[result.value.plies.length - 1]!;
    expect(finalPly.evaluationAfter).toEqual({ kind: 'terminal', result: 'draw', drawReason: 'stalemate' });
  });

  it('does not report drawReason for an ordinary draw (Phase 2.2.1)', async () => {
    // terminalEvaluation() checks a single FEN via a freshly loaded rules
    // engine with no move history, so a repetition draw (which chess.js can
    // only detect from history) is not usable as a fixture here — that is a
    // pre-existing, orthogonal limitation of FEN-only terminal detection,
    // not something this phase changes. Insufficient material (verified
    // against chess.js directly) IS fully determinable from a single FEN,
    // so it is the correct "ordinary, non-stalemate draw" fixture. The move
    // list is a hand-built placeholder — analyzeGame never validates move
    // legality itself, only consults GameRecord.positions/moves as given
    // (the same trust boundary the empty-game fixture above relies on).
    const game: GameRecord = {
      headers: {},
      positions: [
        { ply: 0, fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1' },
        { ply: 1, fen: '4k3/8/8/8/8/8/8/4K3 w - - 0 1' }
      ],
      moves: [
        {
          ply: 1,
          san: 'placeholder',
          from: 'e1',
          to: 'e1',
          color: 'w',
          pieceType: 'k',
          pieceId: 'w-k-e1',
          isEnPassant: false
        }
      ]
    };
    const engine = new ScriptedEngine([cp(0), 'no-score']);

    const result = await analyzeGame(game, engine, new ChessJsEngine());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finalPly = result.value.plies[result.value.plies.length - 1]!;
    expect(finalPly.evaluationAfter).toEqual({ kind: 'terminal', result: 'draw' });
    expect('drawReason' in finalPly.evaluationAfter).toBe(false);
  });

  it('surfaces a genuine engine failure rather than silently substituting a score', async () => {
    // A mid-game position that is NOT terminal, but the engine returned nothing.
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), 'no-score', cp(0), cp(0), cp(0)]);

    const result = await analyzeGame(game, engine, new ChessJsEngine());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('analysis/protocol');
  });
});

describe('analyzeGame — progress and cancellation', () => {
  it('reports monotonic progress over the total position count', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), cp(0), cp(0), cp(0), cp(0)]);
    const seen: string[] = [];

    await analyzeGame(game, engine, new ChessJsEngine(), {
      onProgress: (p) => seen.push(`${p.completed}/${p.total}`)
    });

    expect(seen).toEqual(['1/5', '2/5', '3/5', '4/5', '5/5']);
  });

  it('stops promptly when cancellation is requested mid-run', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const engine = new ScriptedEngine([cp(0), cp(0), cp(0), cp(0), cp(0)]);
    let completed = 0;

    const result = await analyzeGame(game, engine, new ChessJsEngine(), {
      onProgress: () => { completed++; },
      isCancelled: () => completed >= 2
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('analysis/cancelled');
    // It stopped early rather than analysing all five positions.
    expect(engine.evaluatedFens.length).toBeLessThan(5);
  });

  it('propagates a cancellation raised by the engine itself', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const cancellingEngine: AnalysisEngine = {
      init: async () => ok(undefined),
      evaluatePosition: async () => err(analysisCancelledError()),
      evaluatePositionMultiPv: async () => ok({ lines: [] }),
      cancel: vi.fn(),
      dispose: vi.fn()
    };

    const result = await analyzeGame(game, cancellingEngine, new ChessJsEngine());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('analysis/cancelled');
  });

  it('is deterministic: the same scripted evaluations always give the same analysis', async () => {
    const game = gameFrom(FIXTURE_PGN);
    const script: Evaluation[] = [cp(30), cp(-120), cp(400), cp(-50), cp(90)];

    const first = await analyzeGame(game, new ScriptedEngine([...script]), new ChessJsEngine());
    const second = await analyzeGame(game, new ScriptedEngine([...script]), new ChessJsEngine());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toEqual(first.value);
  });
});
