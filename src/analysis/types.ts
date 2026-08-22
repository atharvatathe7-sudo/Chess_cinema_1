import type { Color } from '../chess/ChessEngine';

/**
 * ============================================================
 * EVALUATION SIGN CONVENTION — the single rule for this codebase
 * ============================================================
 *
 * Every `Evaluation` value in Chess Cinema is **WHITE-RELATIVE**,
 * without exception:
 *
 *   cp > 0       White stands better by that many centipawns (+100 = +1.00 pawn)
 *   cp < 0       Black stands better
 *   cp === 0     dead level
 *   mateIn > 0   WHITE delivers mate in |mateIn| moves
 *   mateIn < 0   BLACK delivers mate in |mateIn| moves
 *
 * `mateIn === 0` is never produced (a mate "in zero" is not a thing;
 * a finished game simply has no further evaluation).
 *
 * UCI — and therefore Stockfish — reports `score cp` / `score mate`
 * relative to the **side to move**, NOT to White. Converting that into
 * this convention is the job of `fromUciScore()` in evaluation.ts, and
 * it is the *only* place the flip is allowed to happen. Nothing else in
 * the application may reinterpret signs.
 *
 * Worked example of why this matters (the Phase 2.1 chess correction):
 *   +2.0 -> +5.0   White-relative: White improved. Good for White.
 *   +2.0 -> -3.0   White-relative: a 5-pawn swing in BLACK's favour.
 * Whether that swing was a *mistake* depends on who moved — which is
 * what `swingForMover()` expresses, and why the raw white-relative
 * swing and the mover-relative swing are both stored.
 */
export type Evaluation =
  | { readonly kind: 'cp'; readonly cp: number }
  | { readonly kind: 'mate'; readonly mateIn: number }
  /**
   * The game is already over in this position — checkmate or a draw is on the
   * board, so there is nothing left to search and the engine correctly returns
   * no score. This is a genuinely different state from "someone has a forced
   * mate coming", and modelling it explicitly avoids inventing a fake
   * centipawn number for the most decisive position in the game.
   */
  | { readonly kind: 'terminal'; readonly result: TerminalResult; readonly drawReason?: DrawReason };

/** Outcome of a finished position, from the game's point of view. */
export type TerminalResult = 'white-wins' | 'black-wins' | 'draw';

/**
 * Present only when result === 'draw' and the draw was specifically a
 * stalemate — ChessEngine.status() already distinguishes 'stalemate' from
 * other draw causes, and this field is the one place that distinction is
 * preserved rather than discarded. Absent for every other draw cause
 * (repetition, 50-move, insufficient material), which chess.js does not
 * currently expose separately through ChessEngine.
 */
export type DrawReason = 'stalemate';

/** A single engine evaluation of one position, in our own vocabulary (never Stockfish's). */
export interface PositionEvaluation {
  /** White-relative — see the convention above. */
  readonly evaluation: Evaluation;
  /** Engine's preferred move in this position, in UCI long algebraic (e.g. "g1f3"), if reported. */
  readonly bestMove: string | null;
  /** Principal variation in UCI long algebraic, best-first. Empty when the engine reported none. */
  readonly principalVariation: readonly string[];
  /** Search depth actually reached for this evaluation. */
  readonly depth: number;
}

/** Everything Phase 2.1 knows about one played half-move (ply). */
export interface PlyAnalysis {
  /** 1-indexed half-move number, matching pgn/types MoveRecord.ply. */
  readonly ply: number;
  /** Standard 1-indexed full-move number as printed in PGN (ply 1 and 2 are both move 1). */
  readonly moveNumber: number;
  /** Side that played this ply — i.e. the side to move in the position *before* it. */
  readonly sideToMove: Color;
  /** The move actually played, in SAN (for display) and UCI long algebraic (for engine comparison). */
  readonly movePlayedSan: string;
  readonly movePlayedUci: string;
  /** FEN before the move was played. */
  readonly fenBefore: string;
  /** FEN after the move was played. */
  readonly fenAfter: string;
  /** Engine evaluation of the position BEFORE this move (white-relative). */
  readonly evaluationBefore: Evaluation;
  /** Engine evaluation of the position AFTER this move (white-relative). */
  readonly evaluationAfter: Evaluation;
  /** Engine's preferred move in the position before this ply, UCI long algebraic. */
  readonly bestMove: string | null;
  /** Principal variation from the position before this ply. */
  readonly principalVariation: readonly string[];
  /**
   * White-relative evaluation change across this ply, in centipawns on the
   * clamped comparison scale (see evaluation.ts). Positive = position moved
   * in White's favour, negative = in Black's favour, regardless of who moved.
   */
  readonly swingCp: number;
  /**
   * The same swing expressed from the perspective of the player who actually
   * moved: negative means the mover's own position got worse. This is the
   * number that answers "was this a good or bad move?" without yet attaching
   * any label to it.
   */
  readonly swingForMoverCp: number;
  /** How the mate picture changed across this ply. */
  readonly mateTransition: MateTransition;
  /** Search depth used (minimum of the two positions' depths). */
  readonly depth: number;
}

/**
 * How a ply changed the presence of a forced mate. Deliberately factual and
 * label-free: Phase 2.1 does not decide whether any of these is "a blunder".
 */
export type MateTransition =
  /** No forced mate on either side of the ply. */
  | 'none'
  /** No mate before, a forced mate after. */
  | 'mate-appeared'
  /** A forced mate before, none after. */
  | 'mate-disappeared'
  /** Forced mate on both sides of the ply, but for the opposite player. */
  | 'mate-flipped'
  /** Forced mate for the same player before and after. */
  | 'mate-sustained';

/** A ply flagged as a significant evaluation change. Intentionally NOT called a blunder/brilliancy. */
export interface EvaluationSwingCandidate {
  readonly ply: number;
  readonly moveNumber: number;
  readonly sideToMove: Color;
  readonly movePlayedSan: string;
  readonly evaluationBefore: Evaluation;
  readonly evaluationAfter: Evaluation;
  readonly swingCp: number;
  readonly swingForMoverCp: number;
  readonly mateTransition: MateTransition;
  /** Deterministic ranking score — higher means "more significant". See candidates.ts. */
  readonly rankScore: number;
}

/** The complete Phase 2.1 analysis product for one game. */
export interface GameAnalysis {
  /** One entry per played ply, in play order. */
  readonly plies: readonly PlyAnalysis[];
  /** Significant evaluation changes, ranked most-significant-first (deterministic). */
  readonly candidates: readonly EvaluationSwingCandidate[];
  /** The settings this analysis was produced with, so results are reproducible/comparable. */
  readonly settings: AnalysisSettings;
}

/**
 * Analysis effort. Phase 2.1 ships one sensible default; the shape exists so
 * Fast/Balanced/Deep presets can be added later without changing any consumer.
 */
export interface AnalysisSettings {
  /** Fixed search depth per position. */
  readonly depth: number;
  /** Hard per-position wall-clock ceiling, so a position can never hang the run. */
  readonly maxTimeMsPerPosition: number;
}

export const DEFAULT_ANALYSIS_SETTINGS: AnalysisSettings = {
  depth: 12,
  maxTimeMsPerPosition: 3000
};

export interface AnalysisProgress {
  /** Positions evaluated so far. */
  readonly completed: number;
  /** Total positions to evaluate (plies + 1: every position including the start). */
  readonly total: number;
}

/**
 * One line from a MultiPV search — an alternative the engine considered,
 * ranked by strength. rank 1 is the same as what a single-PV
 * evaluatePosition call would have returned.
 */
export interface MultiPvLine {
  readonly rank: number;
  /** First move of this line, UCI long algebraic. */
  readonly move: string;
  readonly principalVariation: readonly string[];
  /** White-relative, via fromUciScore — same convention as everywhere else. */
  readonly evaluation: Evaluation;
  readonly depth: number;
}

export interface MultiPvResult {
  /** Ordered by rank ascending. May be shorter than requested if the engine reported fewer distinct lines. */
  readonly lines: readonly MultiPvLine[];
}
