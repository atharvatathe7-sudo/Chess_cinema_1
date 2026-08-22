import { describe, expect, it } from 'vitest';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import type { AnalysisSettings, GameAnalysis, MultiPvResult, PlyAnalysis } from '../analysis/types';
import { DEFAULT_ANALYSIS_SETTINGS } from '../analysis/types';
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

describe('understandGame', () => {
  it('handles an empty game', async () => {
    const result = await understandGame(analysisFrom([]), new StubEngine());
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
    const result = await understandGame(analysisFrom(plies), new StubEngine());
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
    const result = await understandGame(analysisFrom([forkPly]), new StubEngine());
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
    const result = await understandGame(analysisFrom([forkPly]), new StubEngine());
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
      understandGame(analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS }),
      understandGame(analysisFrom(plies), new StubEngine(), { settings: DEFAULT_UNDERSTANDING_SETTINGS })
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(JSON.stringify(a.value)).toBe(JSON.stringify(b.value));
    }
  });

  it('respects cancellation and returns a cancelled error rather than a partial result', async () => {
    const plies = [ply({ ply: 1 }), ply({ ply: 2, sideToMove: 'b' })];
    let calls = 0;
    const result = await understandGame(analysisFrom(plies), new StubEngine(), {
      isCancelled: () => {
        calls++;
        return calls > 1;
      }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('analysis/cancelled');
  });
});
