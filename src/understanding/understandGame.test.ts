import { describe, expect, it } from 'vitest';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import type { AnalysisSettings, GameAnalysis, MultiPvResult, PlyAnalysis } from '../analysis/types';
import { DEFAULT_ANALYSIS_SETTINGS } from '../analysis/types';
import type { GameRecord, MoveRecord } from '../pgn/types';
import { pieceIdFor } from '../pgn/pieceId';
import type { PieceType } from '../chess/ChessEngine';
import { ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { DEFAULT_UNDERSTANDING_SETTINGS } from './types';
import { understandGame } from './understandGame';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'e4',
    movePlayedUci: 'e2e4',
    fenBefore: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    fenAfter: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: 'e2e4',
    principalVariation: ['e2e4'],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

/** A no-op MultiPV engine: never called for these small games since nothing crosses the swing floor by much, but present for interface compliance. */
class StubEngine implements AnalysisEngine {
  public multiPvCalls: string[] = [];
  async init(): Promise<Result<void, AppError>> {
    return ok(undefined);
  }
  async evaluatePosition(): Promise<Result<never, AppError>> {
    throw new Error('not used by understandGame');
  }
  async evaluatePositionMultiPv(fen: string, _settings: AnalysisSettings, _lines: number): Promise<Result<MultiPvResult, AppError>> {
    this.multiPvCalls.push(fen);
    return ok({
      lines: [{ rank: 1, move: 'e2e4', principalVariation: ['e2e4'], evaluation: { kind: 'cp', cp: 20 }, depth: 12 }]
    });
  }
  cancel(): void {}
  dispose(): void {}
}

function analysisFrom(plies: PlyAnalysis[]): GameAnalysis {
  return { plies, candidates: [], settings: DEFAULT_ANALYSIS_SETTINGS };
}

/** Synthesizes a plausible MoveRecord from a fixture ply — from/to/promotion parsed straight out of
 * movePlayedUci, pieceId built via the real pgn/pieceId.ts encoder so it matches production format.
 * Overrides let a test express genuine piece continuity (a pieceId minted from an EARLIER square,
 * carried through a later move) exactly as pgn/assignPieceIdentities.ts does in production. */
function moveRecordFor(p: PlyAnalysis, overrides: Partial<MoveRecord> = {}): MoveRecord {
  const from = p.movePlayedUci.slice(0, 2);
  const to = p.movePlayedUci.slice(2, 4);
  const promotion = p.movePlayedUci.length > 4 ? (p.movePlayedUci.slice(4) as PieceType) : undefined;
  const pieceType: PieceType = /^[NBRQK]/.test(p.movePlayedSan) ? (p.movePlayedSan[0]!.toLowerCase() as PieceType) : 'p';
  return {
    ply: p.ply,
    san: p.movePlayedSan,
    from,
    to,
    color: p.sideToMove,
    pieceType,
    pieceId: pieceIdFor(p.sideToMove, pieceType, from),
    promotion,
    isEnPassant: false,
    ...overrides
  };
}

function gameFrom(plies: PlyAnalysis[]): GameRecord {
  return { headers: {}, positions: [], moves: plies.map((p) => moveRecordFor(p)) };
}

describe('understandGame', () => {
  it('handles an empty game', async () => {
    const result = await understandGame(gameFrom([]), analysisFrom([]), new StubEngine());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plies).toEqual([]);
      expect(result.value.schemaVersion).toBe(1);
    }
  });

  it('produces one PlySemantics entry per ply, in order', async () => {
    const plies = [
      ply({ ply: 1 }),
      ply({
        ply: 2,
        sideToMove: 'b',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1',
        movePlayedSan: 'e5',
        movePlayedUci: 'e7e5',
        bestMove: 'e7e5',
        principalVariation: ['e7e5']
      })
    ];
    const result = await understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.plies.map((p) => p.ply)).toEqual([1, 2]);
      expect(result.value.plies.every((p) => p.qualityClass === 'optimal')).toBe(true);
    }
  });

  it('surfaces a tactical motif produced by a move, wired into significance and cause/consequence', async () => {
    const forkPly = ply({
      ply: 1,
      movePlayedSan: 'Nb6',
      movePlayedUci: 'd5b6',
      fenBefore: '8/8/8/3N4/8/8/8/K6k w - - 0 1',
      fenAfter: 'k1q5/8/1N6/8/8/8/8/K7 b - - 0 1',
      evaluationBefore: { kind: 'cp', cp: 20 },
      evaluationAfter: { kind: 'cp', cp: 500 },
      bestMove: 'd5b6',
      principalVariation: ['d5b6'],
      swingCp: 480,
      swingForMoverCp: 480
    });
    const result = await understandGame(gameFrom([forkPly]), analysisFrom([forkPly]), new StubEngine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.motifs.some((m) => m.motif === 'fork')).toBe(true);
    const semantics = result.value.plies[0]!;
    expect(semantics.signals.motifIds.length).toBeGreaterThan(0);

    const turningPoint = result.value.turningPoints.find((tp) => tp.ply === 1);
    expect(turningPoint).toBeDefined();
    expect(turningPoint!.causeConsequence.immediateChange.motifsTriggered).toEqual(semantics.signals.motifIds);
  });

  it('never asserts MoveQualityClass as a function of significance or motifs (axis independence)', async () => {
    // A move that is the engine's own best line (optimal quality) but still
    // triggers a confirmed motif and a high significance score.
    const forkPly = ply({
      ply: 1,
      movePlayedSan: 'Nb6',
      movePlayedUci: 'd5b6',
      fenBefore: '8/8/8/3N4/8/8/8/K6k w - - 0 1',
      fenAfter: 'k1q5/8/1N6/8/8/8/8/K7 b - - 0 1',
      evaluationBefore: { kind: 'cp', cp: 480 },
      evaluationAfter: { kind: 'cp', cp: 500 },
      bestMove: 'd5b6',
      swingCp: 20,
      swingForMoverCp: 20
    });
    const result = await understandGame(gameFrom([forkPly]), analysisFrom([forkPly]), new StubEngine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const semantics = result.value.plies[0]!;
    expect(semantics.qualityClass).toBe('optimal');
    expect(semantics.signals.motifIds.length).toBeGreaterThan(0); // significance-relevant fact, independent of quality
  });

  it('is deterministic: identical inputs and settings produce byte-identical output', async () => {
    const plies = [
      ply({ ply: 1 }),
      ply({
        ply: 2,
        sideToMove: 'b',
        fenBefore: 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1',
        fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 1',
        movePlayedSan: 'e5',
        movePlayedUci: 'e7e5',
        bestMove: 'e7e5',
        principalVariation: ['e7e5']
      })
    ];

    const [a, b] = await Promise.all([
      understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS }),
      understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS })
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
    }
  });

  it('is deterministic for a fixture containing a promotion (Phase 2.2.1 fields included)', async () => {
    const plies = [
      ply({
        ply: 1,
        movePlayedSan: 'e8=Q',
        movePlayedUci: 'e7e8q',
        fenBefore: '8/4P3/8/8/8/8/8/K6k w - - 0 1',
        fenAfter: '4Q3/8/8/8/8/8/8/K6k b - - 0 1'
      })
    ];
    const [a, b] = await Promise.all([
      understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS }),
      understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS })
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });

  it('is deterministic for a fixture ending in stalemate (Phase 2.2.1 fields included)', async () => {
    const plies = [
      ply({
        ply: 1,
        evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' },
        fenBefore: '7k/8/8/8/8/8/6Q1/7K w - - 0 1',
        fenAfter: '7k/8/8/8/8/6Q1/8/7K b - - 0 1',
        movePlayedSan: 'Qg3',
        movePlayedUci: 'g2g3'
      })
    ];
    const [a, b] = await Promise.all([
      understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS }),
      understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS })
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
  });

  it('respects cancellation and returns a cancelled error rather than a partial result', async () => {
    const plies = [ply({ ply: 1 }), ply({ ply: 2, sideToMove: 'b' })];
    let calls = 0;
    const result = await understandGame(gameFrom(plies), analysisFrom(plies), new StubEngine(), {
      isCancelled: () => {
        calls++;
        return calls > 1;
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('analysis/cancelled');
  });

  it("threads pieceId onto every ply, preserving continuity across a piece's own later move, and captures capturedPieceId (Phase 2.2.1)", async () => {
    const p1 = ply({ ply: 1, movePlayedSan: 'Nf3', movePlayedUci: 'g1f3' });
    const p2 = ply({
      ply: 2,
      sideToMove: 'b',
      movePlayedSan: 'e5',
      movePlayedUci: 'e7e5',
      fenBefore: p1.fenAfter,
      fenAfter: 'rnbqkbnr/pppp1ppp/8/4p3/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 0 2'
    });
    const p3 = ply({
      ply: 3,
      sideToMove: 'w',
      movePlayedSan: 'Nxe5',
      movePlayedUci: 'f3e5',
      fenBefore: p2.fenAfter,
      fenAfter: 'rnbqkbnr/pppp1ppp/8/4N3/8/8/PPPPPPPP/RNBQKB1R b KQkq - 0 2'
    });

    // The continuity a real game gets from pgn/assignPieceIdentities.ts: the
    // SAME knight (minted "w-n-g1" at the start) moves twice, capturing a
    // specific enemy pawn on its second move.
    const game: GameRecord = {
      headers: {},
      positions: [],
      moves: [moveRecordFor(p1), moveRecordFor(p2), moveRecordFor(p3, { pieceId: 'w-n-g1', capturedPieceId: 'b-p-e7' })]
    };

    const result = await understandGame(game, analysisFrom([p1, p2, p3]), new StubEngine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [s1, , s3] = result.value.plies;
    expect(s1!.signals.pieceId).toBe('w-n-g1');
    expect(s1!.signals.capturedPieceId).toBeUndefined();
    expect(s3!.signals.pieceId).toBe('w-n-g1'); // the same physical knight, three plies later
    expect(s3!.signals.capturedPieceId).toBe('b-p-e7');
  });

  it('surfaces promotion and underpromotion as structured PlySignals, and neither on an ordinary move (Phase 2.2.1)', async () => {
    const queenPromo = ply({
      ply: 1,
      movePlayedSan: 'e8=Q',
      movePlayedUci: 'e7e8q',
      fenBefore: '8/4P3/8/8/8/8/8/K6k w - - 0 1',
      fenAfter: '4Q3/8/8/8/8/8/8/K6k b - - 0 1'
    });
    const knightPromo = ply({
      ply: 1,
      movePlayedSan: 'e8=N',
      movePlayedUci: 'e7e8n',
      fenBefore: '8/4P3/8/8/8/8/8/K6k w - - 0 1',
      fenAfter: '4N3/8/8/8/8/8/8/K6k b - - 0 1'
    });
    const noPromo = ply({ ply: 1 });

    const [queenResult, knightResult, noneResult] = await Promise.all([
      understandGame(gameFrom([queenPromo]), analysisFrom([queenPromo]), new StubEngine()),
      understandGame(gameFrom([knightPromo]), analysisFrom([knightPromo]), new StubEngine()),
      understandGame(gameFrom([noPromo]), analysisFrom([noPromo]), new StubEngine())
    ]);
    expect(queenResult.ok && knightResult.ok && noneResult.ok).toBe(true);
    if (!queenResult.ok || !knightResult.ok || !noneResult.ok) return;

    expect(queenResult.value.plies[0]!.signals).toMatchObject({
      isPromotion: true,
      isUnderpromotion: false,
      promotionPieceType: 'q'
    });
    expect(knightResult.value.plies[0]!.signals).toMatchObject({
      isPromotion: true,
      isUnderpromotion: true,
      promotionPieceType: 'n'
    });
    expect(noneResult.value.plies[0]!.signals.isPromotion).toBe(false);
    expect(noneResult.value.plies[0]!.signals.isUnderpromotion).toBe(false);
    expect(noneResult.value.plies[0]!.signals.promotionPieceType).toBeUndefined();
  });

  describe('king mobility (Phase 2.2.1)', () => {
    it('reports legal escape squares and their count for a king with room to move', async () => {
      // Same position already verified in geometry.test.ts's legalKingEscapeSquares suite.
      const p = ply({
        ply: 1,
        sideToMove: 'w',
        fenBefore: '7k/8/8/8/8/8/8/K7 w - - 0 1',
        fenAfter: '7k/8/8/8/8/8/8/1K6 b - - 0 1',
        movePlayedSan: 'Kb1',
        movePlayedUci: 'a1b1'
      });
      const result = await understandGame(gameFrom([p]), analysisFrom([p]), new StubEngine());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.kingMobility).toHaveLength(1);
      const record = result.value.kingMobility[0]!;
      expect(record.ply).toBe(1);
      expect(record.color).toBe('w');
      expect([...record.legalEscapeSquares].sort()).toEqual(['a2', 'b1', 'b2']);
      expect(record.legalEscapeSquareCount).toBe(3);
    });

    it('reports zero legal escape squares for a smothered king', async () => {
      // Same smothered position already verified in geometry.test.ts.
      const smothered = '6rk/6pp/6N1/8/8/8/8/6QK b - - 0 1';
      const p = ply({
        ply: 1,
        sideToMove: 'b',
        fenBefore: smothered,
        fenAfter: smothered,
        movePlayedSan: 'Rg8',
        movePlayedUci: 'g8g8'
      });
      const result = await understandGame(gameFrom([p]), analysisFrom([p]), new StubEngine());
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const record = result.value.kingMobility[0]!;
      expect(record.legalEscapeSquares).toEqual([]);
      expect(record.legalEscapeSquareCount).toBe(0);
    });
  });
});
