import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import type { Evaluation, GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameUnderstanding, KingMobilityRecord } from '../understanding/types';
import { classifyCausalFacts } from './consequenceChain';
import { forcedSequence, plyAnalysis, understandingFrom } from './storyFixtures';

/**
 * Phase 16 (MUST HAVE 5) — the chess-fact classifier.
 *
 * Each fact gets a positive case and at least one negative case that is as
 * close to it as possible, because the point of every gate here is to separate
 * the fact from the thing that merely resembles it: a capture from a defender
 * loss, a spike from a collapse, a move inside a sequence from a forced reply.
 */

const QUIET = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

function realPly(ply: number, fen: string, moveUci: string, overrides: Partial<PlyAnalysis> = {}): PlyAnalysis {
  const chess = new Chess(fen);
  const move = chess.move({ from: moveUci.slice(0, 2), to: moveUci.slice(2, 4) });
  if (!move) throw new Error(`illegal fixture move ${moveUci}`);
  return plyAnalysis(ply, {
    sideToMove: move.color,
    movePlayedSan: move.san,
    movePlayedUci: moveUci,
    fenBefore: fen,
    fenAfter: chess.fen(),
    ...overrides
  });
}

function analysisOf(plies: readonly PlyAnalysis[]): GameAnalysis {
  return { plies: [...plies], candidates: [], settings: { depth: 12, maxTimeMsPerPosition: 3000 } };
}

function classify(plyNumber: number, plies: readonly PlyAnalysis[], understanding: GameUnderstanding) {
  const analysis = analysisOf(plies);
  const byNumber = new Map(analysis.plies.map((p) => [p.ply, p]));
  const lastPly = analysis.plies[analysis.plies.length - 1]!.ply;
  return classifyCausalFacts(plyNumber, understanding, byNumber, lastPly);
}

const EMPTY_UNDERSTANDING = understandingFrom({ plies: [] });

describe('material-lost', () => {
  it('fires on a real material swing measured from the board itself', () => {
    // White rook takes an undefended black queen: a 900-unit board diff.
    const ply = realPly(1, '4k3/8/8/3q4/8/8/8/3RK3 w - - 0 1', 'd1d5');
    expect(classify(1, [ply], EMPTY_UNDERSTANDING)).toContain('material-lost');
  });

  it('does not fire on a quiet move that changes no material', () => {
    const ply = realPly(1, QUIET, 'e2e4');
    const facts = classify(1, [ply], EMPTY_UNDERSTANDING);
    expect(facts === undefined || !facts.includes('material-lost')).toBe(true);
  });

  it('does not fire on a capture below the floor', () => {
    // A pawn (100) is real but under MATERIAL_LOST_FLOOR (200): a swing worth
    // naming has to be worth naming.
    const ply = realPly(1, '4k3/8/8/3p4/8/8/8/3RK3 w - - 0 1', 'd1d5');
    const facts = classify(1, [ply], EMPTY_UNDERSTANDING);
    expect(facts === undefined || !facts.includes('material-lost')).toBe(true);
  });
});

describe('evaluation-collapse', () => {
  const cp = (value: number): Evaluation => ({ kind: 'cp', cp: value });

  /** A White move after which White's own evaluation falls by `drop`, then behaves per `after`. */
  function collapseFixture(drop: number, after: readonly number[]): PlyAnalysis[] {
    const first = realPly(1, QUIET, 'e2e4', { evaluationBefore: cp(0), evaluationAfter: cp(-drop) });
    const rest = after.map((value, index) =>
      plyAnalysis(index + 2, { evaluationBefore: cp(-drop), evaluationAfter: cp(value) })
    );
    return [first, ...rest];
  }

  it('fires when a decisive drop is still standing plies later', () => {
    const plies = collapseFixture(600, [-600, -620, -590, -640, -610, -600]);
    expect(classify(1, plies, EMPTY_UNDERSTANDING)).toContain('evaluation-collapse');
  });

  it('does NOT fire on a single temporary spike that immediately recovers', () => {
    // The explicit requirement: one transient Stockfish reading is not a
    // causal collapse. Same drop as above, fully given back on the next ply.
    const plies = collapseFixture(600, [-20, 0, 10, 5, 0, -10]);
    const facts = classify(1, plies, EMPTY_UNDERSTANDING);
    expect(facts === undefined || !facts.includes('evaluation-collapse')).toBe(true);
  });

  it('does not fire on a drop that is too small to be decisive', () => {
    const plies = collapseFixture(120, [-120, -130, -110, -120, -125, -120]);
    const facts = classify(1, plies, EMPTY_UNDERSTANDING);
    expect(facts === undefined || !facts.includes('evaluation-collapse')).toBe(true);
  });

  it('is mover-relative: the same board swing is a collapse for the side that caused it, not the other', () => {
    // Black plays a move after which White is +600. That is Black's collapse.
    const first = realPly(2, 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'e7e5', {
      evaluationBefore: cp(0),
      evaluationAfter: cp(600)
    });
    const rest = [3, 4, 5, 6, 7, 8].map((n) => plyAnalysis(n, { evaluationBefore: cp(600), evaluationAfter: cp(620) }));
    expect(classify(2, [first, ...rest], EMPTY_UNDERSTANDING)).toContain('evaluation-collapse');
  });
});

describe('forced-response', () => {
  it('fires for a reply inside a forced sequence', () => {
    const plies = [10, 11, 12].map((n) => realPly(n, QUIET, 'e2e4'));
    const understanding = understandingFrom({ plies: [], sequences: [forcedSequence('seq-1', [10, 11, 12], 'check')] });
    expect(classify(11, plies, understanding)).toContain('forced-response');
  });

  it('does NOT fire for the move that OPENS the sequence — that move was a free choice', () => {
    const plies = [10, 11, 12].map((n) => realPly(n, QUIET, 'e2e4'));
    const understanding = understandingFrom({ plies: [], sequences: [forcedSequence('seq-1', [10, 11, 12], 'check')] });
    const facts = classify(10, plies, understanding);
    expect(facts === undefined || !facts.includes('forced-response')).toBe(true);
  });

  it('does not fire for a ply in no sequence at all', () => {
    const plies = [10, 11, 12].map((n) => realPly(n, QUIET, 'e2e4'));
    const facts = classify(12, plies, understandingFrom({ plies: [], sequences: [forcedSequence('seq-1', [10, 11], 'check')] }));
    expect(facts === undefined || !facts.includes('forced-response')).toBe(true);
  });
});

describe('escape-square-removed', () => {
  function mobility(ply: number, color: 'w' | 'b', count: number): KingMobilityRecord {
    return { ply, color, legalEscapeSquares: Array.from({ length: count }, (_, i) => `sq${i}`), legalEscapeSquareCount: count };
  }

  it('fires when the opposing king has fewer legal escape squares after this move', () => {
    // Records bracket the move: the defending king is described at ply-1 and
    // ply+1, both its own colour.
    const plies = [4, 5, 6].map((n) => realPly(n, QUIET, 'e2e4'));
    const understanding = understandingFrom({
      plies: [],
      kingMobility: [mobility(4, 'b', 3), mobility(5, 'w', 2), mobility(6, 'b', 1)]
    });
    expect(classify(5, plies, understanding)).toContain('escape-square-removed');
  });

  it('does not fire when the count is unchanged', () => {
    const plies = [4, 5, 6].map((n) => realPly(n, QUIET, 'e2e4'));
    const understanding = understandingFrom({
      plies: [],
      kingMobility: [mobility(4, 'b', 3), mobility(5, 'w', 2), mobility(6, 'b', 3)]
    });
    const facts = classify(5, plies, understanding);
    expect(facts === undefined || !facts.includes('escape-square-removed')).toBe(true);
  });

  it('does not fire when the count RISES', () => {
    const plies = [4, 5, 6].map((n) => realPly(n, QUIET, 'e2e4'));
    const understanding = understandingFrom({
      plies: [],
      kingMobility: [mobility(4, 'b', 1), mobility(5, 'w', 2), mobility(6, 'b', 4)]
    });
    const facts = classify(5, plies, understanding);
    expect(facts === undefined || !facts.includes('escape-square-removed')).toBe(true);
  });

  it('does not compare two different kings', () => {
    // Guard: if the bracketing records are not the same colour, they are not
    // the same king, and the comparison would be meaningless.
    const plies = [4, 5, 6].map((n) => realPly(n, QUIET, 'e2e4'));
    const understanding = understandingFrom({
      plies: [],
      kingMobility: [mobility(4, 'b', 5), mobility(5, 'w', 2), mobility(6, 'w', 0)]
    });
    const facts = classify(5, plies, understanding);
    expect(facts === undefined || !facts.includes('escape-square-removed')).toBe(true);
  });

  it('does not fire without the bracketing records', () => {
    const plies = [5].map((n) => realPly(n, QUIET, 'e2e4'));
    const facts = classify(5, plies, understandingFrom({ plies: [], kingMobility: [mobility(5, 'w', 2)] }));
    expect(facts === undefined || !facts.includes('escape-square-removed')).toBe(true);
  });
});

describe('defender-lost, surfaced through the classifier', () => {
  it('fires when the defender primitive reports a real collapse', () => {
    const ply = realPly(1, '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1', 'h3e6');
    expect(classify(1, [ply], EMPTY_UNDERSTANDING)).toContain('defender-lost');
  });

  it('does not fire on a capture that removes no defender', () => {
    const ply = realPly(1, '4k3/8/8/n7/8/8/8/R3K3 w - - 0 1', 'a1a5');
    const facts = classify(1, [ply], EMPTY_UNDERSTANDING);
    expect(facts === undefined || !facts.includes('defender-lost')).toBe(true);
  });
});

describe('classifier contract', () => {
  it('returns undefined — never an empty array — when nothing clears its gate', () => {
    expect(classify(1, [realPly(1, QUIET, 'e2e4')], EMPTY_UNDERSTANDING)).toBeUndefined();
  });

  it('returns facts in a fixed order regardless of how many fired', () => {
    // Bxe6 removes the sole defender of d5 AND takes a bishop (330 >= floor).
    const ply = realPly(1, '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1', 'h3e6');
    expect(classify(1, [ply], EMPTY_UNDERSTANDING)).toEqual(['defender-lost', 'material-lost']);
  });

  it('is deterministic across repeated calls', () => {
    const plies = [realPly(1, '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1', 'h3e6')];
    expect(classify(1, plies, EMPTY_UNDERSTANDING)).toEqual(classify(1, plies, EMPTY_UNDERSTANDING));
  });

  it('returns undefined for a ply that does not exist', () => {
    expect(classify(99, [realPly(1, QUIET, 'e2e4')], EMPTY_UNDERSTANDING)).toBeUndefined();
  });
});
