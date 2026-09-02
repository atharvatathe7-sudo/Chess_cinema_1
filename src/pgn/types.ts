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

/**
 * How the game ended, as a closed classification of the PGN [Termination]
 * tag. 'unknown' means a [Termination] tag was present but its text did not
 * match any recognised form; 'absent' means no tag was present at all.
 * Those two are deliberately distinct: "the producer told us something we
 * don't understand" is different evidence from "the producer told us
 * nothing", and story/gameOutcome.ts treats them differently.
 */
export type TerminationKind =
  | 'checkmate'
  | 'stalemate'
  | 'resignation'
  | 'timeout'
  | 'timeout-vs-insufficient-material'
  | 'insufficient-material'
  | 'agreement'
  | 'repetition'
  | 'fifty-move'
  | 'unknown'
  | 'absent';

export interface GameHeaders {
  white?: string;
  black?: string;
  whiteElo?: number;
  blackElo?: number;
  result?: string;
  event?: string;
  /**
   * Classified [Termination] tag. parsePgn always sets this explicitly
   * ('absent' when no tag was present); it stays optional only so that the
   * many existing GameRecord fixtures that pass `headers: {}` keep
   * compiling. Consumers must normalise `undefined` to 'absent' — see
   * story/gameOutcome.ts's terminationOf.
   */
  termination?: TerminationKind;
  /**
   * The verbatim [Termination] text, preserved whenever a tag was present —
   * including (especially) when classification fell through to 'unknown', so
   * an unfamiliar PGN's own words are never silently discarded and an
   * unrecognised value can never make parsing fail.
   */
  terminationRaw?: string;
}

export interface GameRecord {
  headers: GameHeaders;
  /** positions.length === moves.length + 1 */
  positions: PositionSnapshot[];
  moves: MoveRecord[];
}
