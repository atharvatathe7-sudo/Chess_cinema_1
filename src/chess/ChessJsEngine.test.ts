import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from './ChessJsEngine';

describe('ChessJsEngine', () => {
  it('starts at the standard position', () => {
    const engine = new ChessJsEngine();
    expect(engine.fen()).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(engine.turn()).toBe('w');
    expect(engine.status()).toBe('in_progress');
  });

  it('applies a legal move and updates turn', () => {
    const engine = new ChessJsEngine();
    const result = engine.move('e2', 'e4');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.san).toBe('e4');
      expect(result.value.piece).toBe('p');
    }
    expect(engine.turn()).toBe('b');
  });

  it('rejects an illegal move as a recoverable Result error, never throwing', () => {
    const engine = new ChessJsEngine();
    const result = engine.move('e2', 'e5');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.severity).toBe('recoverable');
      expect(result.error.code).toBe('chess/illegal-move');
    }
    // state must be unchanged after a rejected move
    expect(engine.turn()).toBe('w');
  });

  it('detects checkmate (fool\'s mate)', () => {
    const engine = new ChessJsEngine();
    for (const [from, to] of [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4']
    ] as const) {
      const r = engine.move(from, to);
      expect(r.ok).toBe(true);
    }
    expect(engine.status()).toBe('checkmate');
  });

  it('rejects invalid PGN as a recoverable Result error', () => {
    const engine = new ChessJsEngine();
    const result = engine.loadPgn('this is not a pgn 1. Zz9 Zz9');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('chess/invalid-pgn');
    }
  });

  it('loads valid PGN and returns the full verbose move history', () => {
    const engine = new ChessJsEngine();
    const result = engine.loadPgn('1. e4 e5 2. Nf3 Nc6');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    }
  });

  it('reports check without conflating it with checkmate', () => {
    const engine = new ChessJsEngine();
    for (const [from, to] of [
      ['e2', 'e4'],
      ['d7', 'd5'],
      ['f1', 'b5']
    ] as const) {
      expect(engine.move(from, to).ok).toBe(true);
    }
    expect(engine.isCheck()).toBe(true);
    expect(engine.status()).toBe('in_progress');
  });
});
