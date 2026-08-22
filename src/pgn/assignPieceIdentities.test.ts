import { describe, expect, it } from 'vitest';
import type { EngineMoveResult, PieceType, Color } from '../chess/ChessEngine';
import { assignPieceIdentities } from './assignPieceIdentities';

function move(partial: {
  from: string;
  to: string;
  color: Color;
  piece: PieceType;
  promotion?: PieceType;
  isCapture?: boolean;
  isEnPassant?: boolean;
  isKingsideCastle?: boolean;
  isQueensideCastle?: boolean;
}): EngineMoveResult {
  return {
    from: partial.from,
    to: partial.to,
    san: `${partial.from}${partial.to}`,
    piece: partial.piece,
    color: partial.color,
    promotion: partial.promotion,
    isCapture: partial.isCapture ?? false,
    isEnPassant: partial.isEnPassant ?? false,
    isKingsideCastle: partial.isKingsideCastle ?? false,
    isQueensideCastle: partial.isQueensideCastle ?? false,
    before: 'unused',
    after: 'unused'
  };
}

describe('assignPieceIdentities', () => {
  it('assigns a stable id that follows a piece across quiet moves', () => {
    const records = assignPieceIdentities([
      move({ from: 'e2', to: 'e4', color: 'w', piece: 'p' }),
      move({ from: 'e7', to: 'e5', color: 'b', piece: 'p' }),
      move({ from: 'e4', to: 'e5', color: 'w', piece: 'p', isCapture: true })
    ]);
    expect(records[0]!.pieceId).toBe('w-p-e2');
    expect(records[1]!.pieceId).toBe('b-p-e7');
    // the same white pawn (w-p-e2) makes the third move, now from e4
    expect(records[2]!.pieceId).toBe('w-p-e2');
    expect(records[2]!.capturedPieceId).toBe('b-p-e7');
  });

  it('resolves a bishop capturing a knight that has already moved', () => {
    const records = assignPieceIdentities([
      move({ from: 'e2', to: 'e4', color: 'w', piece: 'p' }),
      move({ from: 'e7', to: 'e5', color: 'b', piece: 'p' }),
      move({ from: 'g1', to: 'f3', color: 'w', piece: 'n' }),
      move({ from: 'b8', to: 'c6', color: 'b', piece: 'n' }),
      move({ from: 'f1', to: 'b5', color: 'w', piece: 'b' }),
      move({ from: 'a7', to: 'a6', color: 'b', piece: 'p' }),
      move({ from: 'b5', to: 'c6', color: 'w', piece: 'b', isCapture: true }),
      move({ from: 'd7', to: 'c6', color: 'b', piece: 'p', isCapture: true })
    ]);
    const bxc6 = records[6]!;
    expect(bxc6.pieceId).toBe('w-b-f1');
    expect(bxc6.capturedPieceId).toBe('b-n-b8');

    const dxc6 = records[7]!;
    expect(dxc6.pieceId).toBe('b-p-d7');
    expect(dxc6.capturedPieceId).toBe('w-b-f1');
  });

  it('resolves en passant capture against the correct square, not the destination', () => {
    const records = assignPieceIdentities([
      move({ from: 'e2', to: 'e4', color: 'w', piece: 'p' }),
      move({ from: 'g8', to: 'f6', color: 'b', piece: 'n' }),
      move({ from: 'e4', to: 'e5', color: 'w', piece: 'p' }),
      move({ from: 'd7', to: 'd5', color: 'b', piece: 'p' }),
      move({ from: 'e5', to: 'd6', color: 'w', piece: 'p', isCapture: true, isEnPassant: true })
    ]);
    const epCapture = records[4]!;
    expect(epCapture.pieceId).toBe('w-p-e2');
    expect(epCapture.isEnPassant).toBe(true);
    expect(epCapture.to).toBe('d6');
    // the captured pawn was on d5, NOT on d6 (the destination square)
    expect(epCapture.capturedPieceId).toBe('b-p-d7');
  });

  it('produces a rookMove alongside the king move for kingside castling', () => {
    const records = assignPieceIdentities([
      move({ from: 'e2', to: 'e4', color: 'w', piece: 'p' }),
      move({ from: 'e7', to: 'e5', color: 'b', piece: 'p' }),
      move({ from: 'g1', to: 'f3', color: 'w', piece: 'n' }),
      move({ from: 'b8', to: 'c6', color: 'b', piece: 'n' }),
      move({ from: 'f1', to: 'c4', color: 'w', piece: 'b' }),
      move({ from: 'f8', to: 'c5', color: 'b', piece: 'b' }),
      move({ from: 'e1', to: 'g1', color: 'w', piece: 'k', isKingsideCastle: true })
    ]);
    const castleMove = records[6]!;
    expect(castleMove.castle).toBe('king');
    expect(castleMove.pieceId).toBe('w-k-e1');
    expect(castleMove.rookMove).toEqual({ pieceId: 'w-r-h1', from: 'h1', to: 'f1' });
  });

  it('keeps the same pieceId through a capturing promotion', () => {
    const records = assignPieceIdentities([
      move({ from: 'a2', to: 'a4', color: 'w', piece: 'p' }),
      move({ from: 'a4', to: 'a5', color: 'w', piece: 'p' }),
      move({ from: 'a5', to: 'a6', color: 'w', piece: 'p' }),
      move({ from: 'a6', to: 'b7', color: 'w', piece: 'p', isCapture: true }),
      move({ from: 'b7', to: 'a8', color: 'w', piece: 'p', isCapture: true, promotion: 'q' })
    ]);
    const promotionMove = records[4]!;
    expect(promotionMove.pieceId).toBe('w-p-a2');
    expect(promotionMove.promotion).toBe('q');
    expect(promotionMove.capturedPieceId).toBe('b-r-a8');
  });

  it('throws on an internally inconsistent move list rather than guessing', () => {
    expect(() =>
      assignPieceIdentities([move({ from: 'e5', to: 'e6', color: 'w', piece: 'p' })])
    ).toThrow(/no tracked piece/);
  });
});
