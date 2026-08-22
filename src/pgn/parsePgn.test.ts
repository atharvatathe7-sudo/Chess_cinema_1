import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from './parsePgn';

const SAMPLE_PGN = `[White "Alice"]
[Black "Bob"]
[WhiteElo "1600"]
[BlackElo "1650"]
[Result "1-0"]

1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 1-0`;

describe('parsePgn', () => {
  it('parses headers, moves, and per-ply FEN snapshots', () => {
    const result = parsePgn(SAMPLE_PGN, new ChessJsEngine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const record = result.value;
    expect(record.headers).toEqual({
      white: 'Alice',
      black: 'Bob',
      whiteElo: 1600,
      blackElo: 1650,
      result: '1-0'
    });
    expect(record.moves).toHaveLength(10);
    // positions.length must always be moves.length + 1 (start + one per ply)
    expect(record.positions).toHaveLength(11);
    expect(record.positions[0]!.fen).toContain('rnbqkbnr/pppppppp');
    expect(record.moves[0]!.san).toBe('e4');
    expect(record.moves[0]!.pieceId).toBe('w-p-e2');

    // castling move (O-O) is present and carries a rookMove
    const castling = record.moves.find((m) => m.san === 'O-O');
    expect(castling?.rookMove).toBeDefined();
  });

  it('returns a recoverable error for malformed PGN instead of throwing', () => {
    const result = parsePgn('not a real pgn', new ChessJsEngine());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.severity).toBe('recoverable');
    }
  });

  it('rejects PGN with zero moves', () => {
    const result = parsePgn('[White "A"]\n[Black "B"]\n\n*', new ChessJsEngine());
    expect(result.ok).toBe(false);
  });
});
