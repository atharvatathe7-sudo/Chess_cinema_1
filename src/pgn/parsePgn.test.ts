import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { classifyTermination, parsePgn } from './parsePgn';

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
      result: '1-0',
      // Phase 15 — always set explicitly, never left undefined. This PGN has
      // no [Termination] tag, which is a fact worth recording rather than a
      // gap: story/gameOutcome.ts treats "told us nothing" differently from
      // "told us something unrecognised".
      termination: 'absent'
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

describe('classifyTermination (M1)', () => {
  it('classifies the real-world wordings the corpus actually contains', () => {
    expect(classifyTermination('White won by checkmate')).toBe('checkmate');
    expect(classifyTermination('Black won by resignation')).toBe('resignation');
    expect(classifyTermination('Game drawn by stalemate')).toBe('stalemate');
    expect(classifyTermination('Game drawn by insufficient material')).toBe('insufficient-material');
    expect(classifyTermination('Game drawn by agreement')).toBe('agreement');
    expect(classifyTermination('Game drawn by repetition')).toBe('repetition');
    expect(classifyTermination('Game drawn by 50-move rule')).toBe('fifty-move');
    expect(classifyTermination('Alice won on time')).toBe('timeout');
    expect(classifyTermination('Time forfeit')).toBe('timeout');
  });

  it('keeps "timeout vs insufficient material" distinct from both of its own substrings', () => {
    // The whole reason this compound form is worth parsing: it is a draw
    // despite one side being far ahead, which is a different story from
    // either a plain timeout or a plain insufficient-material draw.
    expect(classifyTermination('Game drawn by timeout vs insufficient material')).toBe('timeout-vs-insufficient-material');
  });

  it('does not let "stalemate" be swallowed by the checkmate rule', () => {
    // 'stalemate' contains the substring 'mate'.
    expect(classifyTermination('Game drawn by stalemate')).not.toBe('checkmate');
  });

  it('preserves an unfamiliar termination as unknown rather than failing', () => {
    expect(classifyTermination('Game ended by some future rule')).toBe('unknown');
    expect(classifyTermination(undefined)).toBe('absent');
    expect(classifyTermination('   ')).toBe('absent');
  });

  it('parses a real [Termination] tag through parsePgn and keeps the raw text', () => {
    const pgn = `[Result "1/2-1/2"]\n[Termination "Game drawn by timeout vs insufficient material"]\n\n1. e4 e5 1/2-1/2`;
    const result = parsePgn(pgn, new ChessJsEngine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.headers.termination).toBe('timeout-vs-insufficient-material');
    expect(result.value.headers.terminationRaw).toBe('Game drawn by timeout vs insufficient material');
  });

  it('an unrecognised [Termination] still parses, retaining its own words', () => {
    const pgn = `[Result "1-0"]\n[Termination "Won by interstellar decree"]\n\n1. e4 e5 1-0`;
    const result = parsePgn(pgn, new ChessJsEngine());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.headers.termination).toBe('unknown');
    expect(result.value.headers.terminationRaw).toBe('Won by interstellar decree');
  });
});
