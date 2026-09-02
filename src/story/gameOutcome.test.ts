import { describe, expect, it } from 'vitest';
import type { GameRecord, TerminationKind } from '../pgn/types';
import type { Evaluation } from '../analysis/types';
import { analysisFrom, plyAnalysis } from './storyFixtures';
import { isBoardTerminal, isOffBoardResult, isUnsupportedOutcome, resolveGameOutcome, winnerOf } from './gameOutcome';

/**
 * Phase 15 (M2) — GameOutcome precedence and the three-case distinction.
 *
 * The point of this object is that "the game ended" is not one fact. A
 * checkmate the engine saw, a resignation the file reports, and a bare
 * "1-0" with nothing behind it are three different epistemic situations,
 * and story selection behaves differently in each.
 */

const REAL_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function gameWith(headers: Partial<GameRecord['headers']>): GameRecord {
  return { headers, positions: [], moves: [] };
}

function analysisEndingIn(evaluation: Evaluation) {
  return analysisFrom([plyAnalysis(1, { fenAfter: REAL_FEN, evaluationAfter: evaluation })]);
}

describe('resolveGameOutcome — precedence', () => {
  it('1. engine terminal wins over everything, and is the only source with full confidence', () => {
    // The PGN claims a resignation; the board says checkmate. The board wins.
    const game = gameWith({ result: '1-0', termination: 'resignation' as TerminationKind });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'terminal', result: 'white-wins' }));

    expect(outcome.source).toBe('engine-terminal');
    expect(outcome.termination).toBe('checkmate');
    expect(outcome.onBoard).toBe(true);
    expect(outcome.confidence).toBe(1);
    expect(isBoardTerminal(outcome)).toBe(true);
  });

  it('1b. a terminal stalemate is distinguished from any other terminal draw', () => {
    const game = gameWith({ result: '1/2-1/2' });
    const stalemate = resolveGameOutcome(game, analysisEndingIn({ kind: 'terminal', result: 'draw', drawReason: 'stalemate' }));
    expect(stalemate.termination).toBe('stalemate');

    // A terminal draw with no drawReason is NOT guessed at as a stalemate.
    const otherDraw = resolveGameOutcome(game, analysisEndingIn({ kind: 'terminal', result: 'draw' }));
    expect(otherDraw.termination).not.toBe('stalemate');
  });

  it('2. the [Termination] tag is used when the board is not terminal', () => {
    const game = gameWith({ result: '0-1', termination: 'resignation' });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'cp', cp: -544 }));

    expect(outcome.source).toBe('termination-tag');
    expect(outcome.termination).toBe('resignation');
    expect(outcome.onBoard).toBe(false);
    expect(outcome.result).toBe('0-1');
    expect(isOffBoardResult(outcome)).toBe(true);
    expect(isBoardTerminal(outcome)).toBe(false);
  });

  it('2b. an off-board draw keeps the compound termination that explains it', () => {
    const game = gameWith({ result: '1/2-1/2', termination: 'timeout-vs-insufficient-material' });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'mate', mateIn: 2 }));

    expect(outcome.termination).toBe('timeout-vs-insufficient-material');
    expect(outcome.result).toBe('1/2-1/2');
    // The board/result divergence is representable: a forced mate stood
    // while the recorded result is a draw.
    expect(outcome.finalEvaluation).toEqual({ kind: 'mate', mateIn: 2 });
  });

  it('3. the result header is the last resort, and NEVER becomes a resignation', () => {
    const game = gameWith({ result: '1-0' });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'cp', cp: -20 }));

    expect(outcome.source).toBe('result-header');
    expect(outcome.result).toBe('1-0');
    // A decisive result with no terminal position and no tag says WHO is
    // recorded as winning and nothing about HOW. Inferring "resignation"
    // here is exactly the plausible-sounding fabrication being removed.
    expect(outcome.termination).toBe('absent');
    expect(outcome.termination).not.toBe('resignation');
    expect(outcome.confidence).toBeLessThan(0.5);
  });

  it('3b. an unrecognised tag is kept as "unknown" rather than being flattened to "absent"', () => {
    const game = gameWith({ result: '1-0', termination: 'unknown' });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'cp', cp: 10 }));
    // 'unknown' is not usable as a termination, so precedence falls through
    // to the result header — but the evidence that a tag existed survives.
    expect(outcome.source).toBe('result-header');
    expect(outcome.termination).toBe('unknown');
  });

  it('4. nothing known at all resolves to source "none" with zero confidence', () => {
    const outcome = resolveGameOutcome(gameWith({}), analysisEndingIn({ kind: 'cp', cp: 0 }));
    expect(outcome.source).toBe('none');
    expect(outcome.confidence).toBe(0);
    expect(outcome.result).toBeNull();
  });

  it('handles a game with zero analysed plies without throwing', () => {
    const outcome = resolveGameOutcome(gameWith({ result: '1-0' }), analysisFrom([]));
    expect(outcome.source).toBe('result-header');
    expect(outcome.finalMaterialDiff).toBe(0);
  });
});

describe('isUnsupportedOutcome — the game-06 shape', () => {
  /**
   * The real game_06 shape: a 23-ply fragment stopping in a level opening
   * position, headed "1-0", with no [Termination] tag and no terminal
   * position. Nothing observable in the game corroborates the result.
   */
  it('a result-only game with a level final position is unsupported', () => {
    const game = gameWith({ result: '1-0' });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'cp', cp: -20 }));

    expect(outcome.source).toBe('result-header');
    expect(outcome.onBoard).toBe(false);
    expect(outcome.termination).toBe('absent');
    expect(isUnsupportedOutcome(outcome)).toBe(true);
  });

  it('is NOT unsupported once the final position corroborates the result', () => {
    const game = gameWith({ result: '1-0' });
    const decisive = resolveGameOutcome(game, analysisEndingIn({ kind: 'cp', cp: 900 }));
    expect(isUnsupportedOutcome(decisive)).toBe(false);
  });

  it('is NOT unsupported when the board is terminal or a termination is known', () => {
    expect(isUnsupportedOutcome(resolveGameOutcome(gameWith({ result: '1-0' }), analysisEndingIn({ kind: 'terminal', result: 'white-wins' })))).toBe(
      false
    );
    expect(
      isUnsupportedOutcome(resolveGameOutcome(gameWith({ result: '1-0', termination: 'resignation' }), analysisEndingIn({ kind: 'cp', cp: 0 })))
    ).toBe(false);
  });

  it('a forced mate on the board always corroborates, however it is recorded', () => {
    const game = gameWith({ result: '1/2-1/2' });
    const outcome = resolveGameOutcome(game, analysisEndingIn({ kind: 'mate', mateIn: 2 }));
    expect(isUnsupportedOutcome(outcome)).toBe(false);
  });
});

describe('winnerOf', () => {
  it('maps a decisive result to a side and a draw to null', () => {
    const base = analysisEndingIn({ kind: 'cp', cp: 0 });
    expect(winnerOf(resolveGameOutcome(gameWith({ result: '1-0' }), base))).toBe('w');
    expect(winnerOf(resolveGameOutcome(gameWith({ result: '0-1' }), base))).toBe('b');
    expect(winnerOf(resolveGameOutcome(gameWith({ result: '1/2-1/2' }), base))).toBeNull();
    expect(winnerOf(resolveGameOutcome(gameWith({}), base))).toBeNull();
  });
});
