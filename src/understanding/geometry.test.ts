import { describe, expect, it } from 'vitest';
import {
  attackersOf,
  boardFromFen,
  coordsOf,
  findDiscoveries,
  findForks,
  findLineMotifs,
  legalKingEscapeSquares,
  materialBalance,
  staticExchangeEvaluation
} from './geometry';

describe('boardFromFen / attackersOf', () => {
  it('finds a rook attacking along an open file', () => {
    const board = boardFromFen('4k3/8/8/8/8/8/8/4R2K w - - 0 1');
    const attackers = attackersOf(board, coordsOf('e8'), 'w');
    expect(attackers).toEqual([{ square: 'e1', type: 'r' }]);
  });

  it('finds no attackers when the line is blocked', () => {
    const board = boardFromFen('4k3/8/8/8/4p3/8/8/4R2K w - - 0 1');
    const attackers = attackersOf(board, coordsOf('e8'), 'w');
    expect(attackers).toEqual([]);
  });
});

describe('findForks', () => {
  it('detects a textbook knight fork of a king and a queen', () => {
    // Nb6 forks Ka8 and Qc8 — a standard fork geometry.
    const board = boardFromFen('k1q5/8/1N6/8/8/8/8/K7 w - - 0 1');
    const forks = findForks(board, 'w', 320);
    expect(forks).toHaveLength(1);
    expect(forks[0]!.attacker).toBe('b6');
    expect([...forks[0]!.targets].sort()).toEqual(['a8', 'c8']);
  });

  it('does not report a fork below the minimum material value', () => {
    // Nb6 attacks Ka8 (always counts) and a pawn on d7 (below the 320 floor)
    // — only 1 qualifying target, so this is not a fork.
    const board = boardFromFen('k7/3p4/1N6/8/8/8/8/K7 w - - 0 1');
    const forks = findForks(board, 'w', 320);
    expect(forks.find((fk) => fk.attacker === 'b6')).toBeUndefined();
  });
});

describe('findLineMotifs', () => {
  it('detects an absolute pin against the king', () => {
    // Re1 pins Ne5 to Ke8.
    const board = boardFromFen('4k3/8/8/4n3/8/8/8/4R2K w - - 0 1');
    const motifs = findLineMotifs(board, 'w');
    expect(motifs).toContainEqual({ kind: 'pin', attacker: 'e1', through: 'e5', target: 'e8' });
  });

  it('detects a skewer of a higher-value piece in front of a lower-value one', () => {
    // Re1 skewers Qe5 in front of Re8: the queen must move, exposing the rook.
    const board = boardFromFen('k3r3/8/8/4q3/8/8/8/4R2K w - - 0 1');
    const motifs = findLineMotifs(board, 'w');
    expect(motifs).toContainEqual({ kind: 'skewer', attacker: 'e1', through: 'e5', target: 'e8' });
  });

  it('detects a battery of two doubled rooks on an open file', () => {
    const board = boardFromFen('4k3/8/8/8/8/8/4R3/4R2K w - - 0 1');
    const motifs = findLineMotifs(board, 'w');
    expect(motifs).toContainEqual({ kind: 'battery', attacker: 'e1', through: 'e2', target: 'e2' });
  });

  it('reports nothing on a ray with no defender pieces at all', () => {
    const board = boardFromFen('7k/8/8/8/8/8/8/4R2K w - - 0 1');
    const motifs = findLineMotifs(board, 'w');
    expect(motifs).toEqual([]);
  });
});

describe('findDiscoveries', () => {
  it('detects a discovered attack revealed by vacating the blocking square', () => {
    // White rook on e1, White bishop on e3 blocking, Black king on e8.
    // Moving the bishop away from e3 uncovers Re1 -> Ke8.
    const boardAfter = boardFromFen('4k3/8/8/8/8/8/8/4R2K w - - 0 1');
    const discoveries = findDiscoveries(boardAfter, 'e3', 'w');
    expect(discoveries).toContainEqual({ attacker: 'e1', target: 'e8' });
  });

  it('finds nothing when the vacated square is still occupied', () => {
    const boardAfter = boardFromFen('4k3/8/8/8/4b3/8/8/4R2K w - - 0 1');
    const discoveries = findDiscoveries(boardAfter, 'e4', 'w');
    expect(discoveries).toEqual([]);
  });
});

describe('staticExchangeEvaluation', () => {
  it('is positive when a hanging pawn is undefended', () => {
    const board = boardFromFen('7k/8/8/4p3/8/8/8/4R2K w - - 0 1');
    const see = staticExchangeEvaluation(board, coordsOf('e5'), 'w');
    expect(see).toBe(100); // wins the pawn outright
  });

  it('is non-positive when the target is adequately defended', () => {
    // Black pawn on e5 defended by a black pawn on d6 — Rxe5 dxe5 loses the exchange for White.
    const board = boardFromFen('7k/8/3p4/4p3/8/8/8/4R2K w - - 0 1');
    const see = staticExchangeEvaluation(board, coordsOf('e5'), 'w');
    expect(see).toBeLessThanOrEqual(0);
  });

  it('is zero when the capturing side has no attacker on the square at all', () => {
    // Black queen on a8, White king alone on h1 — nothing White has attacks a8.
    const board = boardFromFen('q6k/8/8/8/8/8/8/7K w - - 0 1');
    const see = staticExchangeEvaluation(board, coordsOf('a8'), 'w');
    expect(see).toBe(0);
  });
});

describe('legalKingEscapeSquares', () => {
  it('returns every square the king can legally step to', () => {
    const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
    const squares = legalKingEscapeSquares(fen, 'w');
    expect([...squares].sort()).toEqual(['a2', 'b1', 'b2']);
  });

  it('returns an empty list when it is not that color’s turn', () => {
    const fen = '7k/8/8/8/8/8/8/K7 w - - 0 1';
    expect(legalKingEscapeSquares(fen, 'b')).toEqual([]);
  });

  it('returns an empty list when the king has no legal squares (smothered)', () => {
    // Black king on h8 fully boxed in by its own pieces, in check from Qg6 — mate, zero escape squares.
    const fen = '6rk/6pp/6N1/8/8/8/8/6QK b - - 0 1';
    expect(legalKingEscapeSquares(fen, 'b')).toEqual([]);
  });
});

describe('materialBalance', () => {
  it('is zero for the standard starting position', () => {
    const board = boardFromFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
    expect(materialBalance(board)).toBe(0);
  });

  it('reflects an extra queen for White', () => {
    const board = boardFromFen('4k3/8/8/8/8/8/8/3QK3 w - - 0 1');
    expect(materialBalance(board)).toBe(900);
  });
});
