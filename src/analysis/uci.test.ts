import { describe, expect, it } from 'vitest';
import { foldInfoLines, foldMultiPvLines, parseBestMoveLine, parseInfoLine } from './uci';

describe('parseInfoLine', () => {
  it('parses a real Stockfish info line captured from the engine', () => {
    // Verbatim from stockfish-18-lite-single running in Chromium.
    const line =
      'info depth 10 seldepth 18 multipv 1 score cp 46 nodes 32689 nps 363211 hashfull 14 time 90 pv g1f3 g8f6 d2d4 e5d4';
    expect(parseInfoLine(line)).toEqual({
      depth: 10,
      multipv: 1,
      score: { kind: 'cp', value: 46 },
      principalVariation: ['g1f3', 'g8f6', 'd2d4', 'e5d4']
    });
  });

  it('parses a mate score', () => {
    const info = parseInfoLine('info depth 20 score mate 3 nodes 1000 pv d1h5 g6h5 h1h5');
    expect(info?.score).toEqual({ kind: 'mate', value: 3 });
    expect(info?.principalVariation).toEqual(['d1h5', 'g6h5', 'h1h5']);
  });

  it('parses a negative mate score (being mated)', () => {
    expect(parseInfoLine('info depth 12 score mate -2 pv a1a2')?.score).toEqual({
      kind: 'mate',
      value: -2
    });
  });

  it('parses a negative centipawn score', () => {
    expect(parseInfoLine('info depth 8 score cp -137 pv e7e5')?.score).toEqual({
      kind: 'cp',
      value: -137
    });
  });

  it('flags upperbound/lowerbound lines so they can be discarded', () => {
    expect(parseInfoLine('info depth 9 score cp 20 upperbound nodes 5')?.bound).toBe('upper');
    expect(parseInfoLine('info depth 9 score cp 20 lowerbound nodes 5')?.bound).toBe('lower');
  });

  it('returns null for non-info lines and for scoreless chatter', () => {
    expect(parseInfoLine('bestmove e2e4')).toBeNull();
    expect(parseInfoLine('uciok')).toBeNull();
    expect(parseInfoLine('info string NNUE evaluation using nn-9067e33176e.nnue')).toBeNull();
    expect(parseInfoLine('')).toBeNull();
  });

  it('handles an info line with no pv', () => {
    const info = parseInfoLine('info depth 4 score cp 12 nodes 300');
    expect(info?.depth).toBe(4);
    expect(info?.principalVariation).toBeUndefined();
  });
});

describe('parseBestMoveLine', () => {
  it('parses a bestmove line with a ponder move', () => {
    expect(parseBestMoveLine('bestmove g1f3 ponder g8f6')).toEqual({ bestMove: 'g1f3' });
  });

  it('parses a bestmove line without a ponder move', () => {
    expect(parseBestMoveLine('bestmove e2e4')).toEqual({ bestMove: 'e2e4' });
  });

  it('parses a promotion bestmove', () => {
    expect(parseBestMoveLine('bestmove a7a8q')).toEqual({ bestMove: 'a7a8q' });
  });

  it('reports null for "(none)" — a terminal position with no legal move', () => {
    expect(parseBestMoveLine('bestmove (none)')).toEqual({ bestMove: null });
  });

  it('returns null for lines that are not bestmove lines', () => {
    expect(parseBestMoveLine('info depth 3 score cp 5')).toBeNull();
    expect(parseBestMoveLine('readyok')).toBeNull();
  });
});

describe('foldInfoLines', () => {
  it('keeps the deepest exact score from a stream of info lines', () => {
    const best = foldInfoLines([
      'info depth 1 score cp 10 pv e2e4',
      'info depth 5 score cp 25 pv d2d4 d7d5',
      'info depth 12 score cp 46 pv g1f3 g8f6'
    ]);
    expect(best?.depth).toBe(12);
    expect(best?.score).toEqual({ kind: 'cp', value: 46 });
    expect(best?.principalVariation).toEqual(['g1f3', 'g8f6']);
  });

  it('ignores bound-limited lines even when they are the deepest', () => {
    const best = foldInfoLines([
      'info depth 10 score cp 30 pv e2e4',
      'info depth 14 score cp 900 upperbound pv d2d4'
    ]);
    expect(best?.depth).toBe(10);
    expect(best?.score).toEqual({ kind: 'cp', value: 30 });
  });

  it('ignores multipv lines beyond the primary variation', () => {
    const best = foldInfoLines([
      'info depth 12 multipv 1 score cp 40 pv e2e4',
      'info depth 12 multipv 2 score cp -200 pv a2a3'
    ]);
    expect(best?.score).toEqual({ kind: 'cp', value: 40 });
  });

  it('prefers a later line at equal depth (the engine refines within a depth)', () => {
    const best = foldInfoLines([
      'info depth 12 score cp 40 pv e2e4',
      'info depth 12 score cp 55 pv d2d4'
    ]);
    expect(best?.score).toEqual({ kind: 'cp', value: 55 });
  });

  it('returns null when no usable line is present', () => {
    expect(foldInfoLines([])).toBeNull();
    expect(foldInfoLines(['uciok', 'readyok', 'info string hello'])).toBeNull();
  });

  it('handles a mate-only stream', () => {
    const best = foldInfoLines(['info depth 6 score mate 2 pv d1h5 g6h5']);
    expect(best?.score).toEqual({ kind: 'mate', value: 2 });
  });
});

describe('foldMultiPvLines', () => {
  it('keeps the deepest line for each multipv index separately', () => {
    const folded = foldMultiPvLines([
      'info depth 12 multipv 1 score cp 40 pv e2e4',
      'info depth 12 multipv 2 score cp 10 pv d2d4',
      'info depth 12 multipv 3 score cp -20 pv c2c4'
    ]);
    expect(folded.size).toBe(3);
    expect(folded.get(1)?.score).toEqual({ kind: 'cp', value: 40 });
    expect(folded.get(2)?.score).toEqual({ kind: 'cp', value: 10 });
    expect(folded.get(3)?.score).toEqual({ kind: 'cp', value: -20 });
  });

  it('refines a line across depths, keeping only the deepest per index', () => {
    const folded = foldMultiPvLines([
      'info depth 8 multipv 1 score cp 30 pv e2e4',
      'info depth 12 multipv 1 score cp 46 pv g1f3 g8f6',
      'info depth 8 multipv 2 score cp 5 pv d2d4'
    ]);
    expect(folded.get(1)?.depth).toBe(12);
    expect(folded.get(1)?.score).toEqual({ kind: 'cp', value: 46 });
    expect(folded.get(2)?.depth).toBe(8);
  });

  it('treats a line with no explicit multipv token as index 1, same as foldInfoLines', () => {
    const folded = foldMultiPvLines(['info depth 10 score cp 25 pv e2e4']);
    expect(folded.get(1)?.score).toEqual({ kind: 'cp', value: 25 });
  });

  it('ignores bound-limited lines', () => {
    const folded = foldMultiPvLines(['info depth 12 multipv 1 score cp 900 upperbound pv d2d4']);
    expect(folded.size).toBe(0);
  });

  it('returns an empty map when no usable line is present', () => {
    expect(foldMultiPvLines([]).size).toBe(0);
    expect(foldMultiPvLines(['uciok', 'info string hello']).size).toBe(0);
  });

  it('does not affect foldInfoLines when both are run over the same stream', () => {
    const lines = [
      'info depth 12 multipv 1 score cp 40 pv e2e4',
      'info depth 12 multipv 2 score cp -200 pv a2a3'
    ];
    expect(foldInfoLines(lines)?.score).toEqual({ kind: 'cp', value: 40 });
    expect(foldMultiPvLines(lines).size).toBe(2);
  });
});
