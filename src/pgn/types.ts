import type { Color, PieceType } from '../chess/ChessEngine';

/**
 * Stable identity for a single physical piece across an entire game
 * record. Assigned once from the standard starting position and carried
 * forward through moves (including promotion, which changes a piece's
 * type but not its identity). Never derived from a square, because
 * squares are reused by different pieces over the course of a game —
 * see docs/architecture.md, Correction 3.
 */
export type PieceId = string;

export interface RookMove {
  pieceId: PieceId;
  from: string;
  to: string;
}

export interface MoveRecord {
  /** 1-indexed half-move number. positions[ply] is the position after this move. */
  ply: number;
  san: string;
  from: string;
  to: string;
  color: Color;
  pieceType: PieceType;
  pieceId: PieceId;
  capturedPieceId?: PieceId;
  promotion?: PieceType;
  isEnPassant: boolean;
  castle?: 'king' | 'queen';
  rookMove?: RookMove;
}

export interface PositionSnapshot {
  /** 0 = starting position, N = position after the Nth half-move. */
  ply: number;
  fen: string;
}

export interface GameHeaders {
  white?: string;
  black?: string;
  whiteElo?: number;
  blackElo?: number;
  result?: string;
  event?: string;
}

export interface GameRecord {
  headers: GameHeaders;
  /** positions.length === moves.length + 1 */
  positions: PositionSnapshot[];
  moves: MoveRecord[];
}
