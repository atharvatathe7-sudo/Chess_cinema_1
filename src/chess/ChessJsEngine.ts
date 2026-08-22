import { Chess } from 'chess.js';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import {
  engineLoadError,
  illegalMoveError,
  invalidFenError,
  invalidPgnError
} from './engineErrors';
import type {
  ChessEngine,
  Color,
  EngineMoveResult,
  GameStatus,
  Piece,
  PieceType
} from './ChessEngine';

/**
 * The only file in the codebase that imports chess.js. If construction
 * fails, that is a fatal AppError raised to the caller — there is no
 * fallback rules engine. Constructor failure is genuinely unlikely once
 * chess.js is a pinned npm dependency (unlike the old CDN <script> tag),
 * but the seam is kept explicit and testable rather than assumed away.
 */
export class ChessJsEngine implements ChessEngine {
  private chess: Chess;

  constructor() {
    try {
      this.chess = new Chess();
    } catch (cause) {
      throw engineLoadError(cause);
    }
  }

  reset(): void {
    this.chess.reset();
  }

  loadFen(fen: string): Result<void, AppError> {
    try {
      this.chess.load(fen);
      return ok(undefined);
    } catch (cause) {
      return err(invalidFenError(fen, cause));
    }
  }

  loadPgn(pgn: string): Result<EngineMoveResult[], AppError> {
    try {
      this.chess.reset();
      this.chess.loadPgn(pgn);
    } catch (cause) {
      return err(invalidPgnError(cause));
    }
    const verboseHistory = this.chess.history({ verbose: true });
    const moves: EngineMoveResult[] = verboseHistory.map((m) => toEngineMoveResult(m));
    return ok(moves);
  }

  move(from: string, to: string, promotion?: PieceType): Result<EngineMoveResult, AppError> {
    try {
      const result = this.chess.move({ from, to, promotion });
      if (!result) return err(illegalMoveError(from, to));
      return ok(toEngineMoveResult(result));
    } catch {
      return err(illegalMoveError(from, to));
    }
  }

  get(square: string): Piece | null {
    const p = this.chess.get(square as never);
    if (!p) return null;
    return { type: p.type as PieceType, color: p.color as Color };
  }

  turn(): Color {
    return this.chess.turn() as Color;
  }

  status(): GameStatus {
    if (this.chess.isCheckmate()) return 'checkmate';
    if (this.chess.isStalemate()) return 'stalemate';
    if (this.chess.isDraw()) return 'draw';
    return 'in_progress';
  }

  isCheck(): boolean {
    return this.chess.isCheck();
  }

  fen(): string {
    return this.chess.fen();
  }

  headers(): Record<string, string> {
    return this.chess.getHeaders();
  }
}

// chess.js's Move class, narrowed to the members we consume.
interface ChessJsMove {
  from: string;
  to: string;
  san: string;
  piece: string;
  color: string;
  captured?: string;
  promotion?: string;
  before: string;
  after: string;
  isCapture(): boolean;
  isEnPassant(): boolean;
  isKingsideCastle(): boolean;
  isQueensideCastle(): boolean;
}

function toEngineMoveResult(m: ChessJsMove): EngineMoveResult {
  return {
    from: m.from,
    to: m.to,
    san: m.san,
    piece: m.piece as PieceType,
    color: m.color as Color,
    captured: m.captured as PieceType | undefined,
    promotion: m.promotion as PieceType | undefined,
    isCapture: m.isCapture(),
    isEnPassant: m.isEnPassant(),
    isKingsideCastle: m.isKingsideCastle(),
    isQueensideCastle: m.isQueensideCastle(),
    before: m.before,
    after: m.after
  };
}
