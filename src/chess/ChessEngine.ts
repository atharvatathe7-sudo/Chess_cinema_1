import type { Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Color = 'w' | 'b';

export interface Piece {
  type: PieceType;
  color: Color;
}

export interface EngineMoveResult {
  from: string;
  to: string;
  san: string;
  piece: PieceType;
  color: Color;
  captured?: PieceType;
  promotion?: PieceType;
  isCapture: boolean;
  isEnPassant: boolean;
  isKingsideCastle: boolean;
  isQueensideCastle: boolean;
  /** FEN of the position immediately before this move. */
  before: string;
  /** FEN of the position immediately after this move. */
  after: string;
}

export type GameStatus = 'in_progress' | 'checkmate' | 'stalemate' | 'draw';

/**
 * The only interface anything outside chess/ is allowed to depend on for
 * chess rules. ChessJsEngine is presently the only implementation; a
 * future AnalysisEngine (Stockfish) is a separate interface, not a
 * replacement for this one.
 */
export interface ChessEngine {
  reset(): void;
  loadFen(fen: string): Result<void, AppError>;
  loadPgn(pgn: string): Result<EngineMoveResult[], AppError>;
  move(from: string, to: string, promotion?: PieceType): Result<EngineMoveResult, AppError>;
  get(square: string): Piece | null;
  turn(): Color;
  status(): GameStatus;
  isCheck(): boolean;
  fen(): string;
  headers(): Record<string, string>;
}
