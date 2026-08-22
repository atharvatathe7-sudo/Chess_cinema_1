import { describe, expect, it } from 'vitest';
import { parseFenPlacement, pieceAtSquare } from './fen';

const STANDARD_START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

describe('parseFenPlacement / pieceAtSquare', () => {
  it('places all 32 pieces of the standard start position correctly', () => {
    const board = parseFenPlacement(STANDARD_START_FEN);
    expect(board.size).toBe(32);
    expect(board.get('a1')).toEqual({ type: 'r', color: 'w' });
    expect(board.get('e1')).toEqual({ type: 'k', color: 'w' });
    expect(board.get('e8')).toEqual({ type: 'k', color: 'b' });
    expect(board.get('a2')).toEqual({ type: 'p', color: 'w' });
    expect(board.get('a7')).toEqual({ type: 'p', color: 'b' });
  });

  it('leaves empty squares absent from the map', () => {
    const board = parseFenPlacement(STANDARD_START_FEN);
    expect(board.has('e4')).toBe(false);
    expect(pieceAtSquare(STANDARD_START_FEN, 'e4')).toBeNull();
  });

  it('pieceAtSquare matches parseFenPlacement for an occupied square', () => {
    expect(pieceAtSquare(STANDARD_START_FEN, 'd1')).toEqual({ type: 'q', color: 'w' });
  });
});
