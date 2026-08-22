import { describe, expect, it } from 'vitest';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import type { AnalysisSettings, MultiPvResult, PlyAnalysis } from '../analysis/types';
import { ok, err, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { engineTimeoutError } from '../analysis/analysisErrors';
import { DEFAULT_UNDERSTANDING_ENGINE_BUDGET } from './types';
import { runFollowUpQueries, selectFollowUpPlies } from './followUpBudget';

function ply(overrides: Partial<PlyAnalysis>): PlyAnalysis {
  return {
    ply: 1,
    moveNumber: 1,
    sideToMove: 'w',
    movePlayedSan: 'x',
    movePlayedUci: 'a1a2',
    fenBefore: '7k/8/8/8/8/8/8/K7 w - - 0 1',
    fenAfter: '7k/8/8/8/8/8/8/K7 b - - 0 1',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: null,
    principalVariation: [],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

describe('selectFollowUpPlies', () => {
  it('ranks decisive mate transitions above any swing magnitude', () => {
    const plies = [
      ply({ ply: 1, swingForMoverCp: -900 }),
      ply({ ply: 2, swingForMoverCp: -10, mateTransition: 'mate-flipped' })
    ];
    const budget = { ...DEFAULT_UNDERSTANDING_ENGINE_BUDGET, maxFollowUpPositions: 1 };
    expect(selectFollowUpPlies(plies, budget).map((p) => p.ply)).toEqual([2]);
  });

  it('ranks by |swingForMoverCp| when no decisive transitions are present', () => {
    const plies = [ply({ ply: 1, swingForMoverCp: -50 }), ply({ ply: 2, swingForMoverCp: 300 }), ply({ ply: 3, swingForMoverCp: -10 })];
    const budget = { ...DEFAULT_UNDERSTANDING_ENGINE_BUDGET, maxFollowUpPositions: 2 };
    expect(selectFollowUpPlies(plies, budget).map((p) => p.ply)).toEqual([2, 1]);
  });

  it('ties break by ply ascending', () => {
    const plies = [ply({ ply: 5, swingForMoverCp: -100 }), ply({ ply: 2, swingForMoverCp: -100 })];
    const budget = { ...DEFAULT_UNDERSTANDING_ENGINE_BUDGET, maxFollowUpPositions: 2 };
    expect(selectFollowUpPlies(plies, budget).map((p) => p.ply)).toEqual([2, 5]);
  });

  it('respects maxFollowUpPositions as a hard cap', () => {
    const plies = Array.from({ length: 30 }, (_, i) => ply({ ply: i + 1, swingForMoverCp: -(i + 1) }));
    const budget = { ...DEFAULT_UNDERSTANDING_ENGINE_BUDGET, maxFollowUpPositions: 5 };
    expect(selectFollowUpPlies(plies, budget)).toHaveLength(5);
  });

  it('is deterministic across repeated calls', () => {
    const plies = [ply({ ply: 1, swingForMoverCp: -100 }), ply({ ply: 2, swingForMoverCp: -100 }), ply({ ply: 3, swingForMoverCp: -50 })];
    const budget = DEFAULT_UNDERSTANDING_ENGINE_BUDGET;
    expect(selectFollowUpPlies(plies, budget)).toEqual(selectFollowUpPlies(plies, budget));
  });
});

class ScriptedMultiPvEngine implements AnalysisEngine {
  public calls: string[] = [];
  constructor(private readonly script: Record<string, MultiPvResult | 'timeout'>) {}

  async init(): Promise<Result<void, AppError>> {
    return ok(undefined);
  }
  async evaluatePosition(): Promise<Result<never, AppError>> {
    throw new Error('not used in these tests');
  }
  async evaluatePositionMultiPv(fen: string, _settings: AnalysisSettings, _lines: number): Promise<Result<MultiPvResult, AppError>> {
    this.calls.push(fen);
    const entry = this.script[fen];
    if (entry === 'timeout') return err(engineTimeoutError(fen));
    return ok(entry ?? { lines: [] });
  }
  cancel(): void {}
  dispose(): void {}
}

describe('runFollowUpQueries', () => {
  it('spends the budget only on the deterministically selected plies', async () => {
    const plies = [ply({ ply: 1, fenBefore: 'fen1', swingForMoverCp: -900 }), ply({ ply: 2, fenBefore: 'fen2', swingForMoverCp: -5 })];
    const engine = new ScriptedMultiPvEngine({ fen1: { lines: [{ rank: 1, move: 'a1a2', principalVariation: ['a1a2'], evaluation: { kind: 'cp', cp: 900 }, depth: 12 }] } });
    const budget = { ...DEFAULT_UNDERSTANDING_ENGINE_BUDGET, maxFollowUpPositions: 1 };

    const result = await runFollowUpQueries(plies, engine, budget);

    expect(result.ok).toBe(true);
    expect(engine.calls).toEqual(['fen1']);
    if (result.ok) {
      expect(result.value.multiPvByPly.has(1)).toBe(true);
      expect(result.value.multiPvByPly.has(2)).toBe(false);
    }
  });

  it('does not abort the whole pass when one follow-up query times out', async () => {
    const plies = [ply({ ply: 1, fenBefore: 'fen1', swingForMoverCp: -900 }), ply({ ply: 2, fenBefore: 'fen2', swingForMoverCp: -800 })];
    const engine = new ScriptedMultiPvEngine({ fen1: 'timeout', fen2: { lines: [] } });
    const budget = { ...DEFAULT_UNDERSTANDING_ENGINE_BUDGET, maxFollowUpPositions: 2 };

    const result = await runFollowUpQueries(plies, engine, budget);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.multiPvByPly.has(1)).toBe(false); // timed out — simply absent, not a hard failure
      expect(result.value.multiPvByPly.has(2)).toBe(true);
    }
  });

  it('respects cancellation between calls', async () => {
    const plies = [ply({ ply: 1, fenBefore: 'fen1' }), ply({ ply: 2, fenBefore: 'fen2' })];
    const engine = new ScriptedMultiPvEngine({});
    let calls = 0;
    const result = await runFollowUpQueries(plies, engine, DEFAULT_UNDERSTANDING_ENGINE_BUDGET, () => {
      calls++;
      return calls > 1;
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('analysis/cancelled');
  });
});
