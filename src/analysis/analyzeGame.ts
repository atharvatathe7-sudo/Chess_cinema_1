import type { ChessEngine, Color } from '../chess/ChessEngine';
import type { GameRecord } from '../pgn/types';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import type { AnalysisEngine } from './AnalysisEngine';
import {
  DEFAULT_ANALYSIS_SETTINGS,
  type AnalysisProgress,
  type AnalysisSettings,
  type Evaluation,
  type GameAnalysis,
  type PlyAnalysis,
  type PositionEvaluation,
  type TerminalResult
} from './types';
import { evaluationSwingCp, mateTransition, swingForMoverCp } from './evaluation';
import { detectCandidates, DEFAULT_CANDIDATE_SETTINGS, type CandidateDetectionSettings } from './candidates';
import { analysisCancelledError } from './analysisErrors';

/**
 * Turns a parsed game into evaluated plies and ranked candidate moments.
 *
 * The pipeline is exactly:
 *   PGN -> GameRecord -> AnalysisEngine -> GameAnalysis -> candidates
 *
 * It consumes the GameRecord the existing pgn/ layer already produces, and
 * knows nothing about the Timeline, the renderer, or playback. Analysis and
 * presentation stay entirely separate concerns: nothing here can affect what
 * is drawn, and the renderer has no idea analysis exists.
 *
 * Every position is evaluated once. A game of N plies has N+1 positions, and
 * ply i's "before" is position i-1 while its "after" is position i — so no
 * position is ever searched twice and the two evaluations bracketing a move
 * are guaranteed to be mutually consistent.
 */

export interface AnalyzeGameOptions {
  readonly settings?: AnalysisSettings;
  readonly candidateSettings?: CandidateDetectionSettings;
  readonly onProgress?: (progress: AnalysisProgress) => void;
  /** Polled between positions; returning true aborts the run promptly. */
  readonly isCancelled?: () => boolean;
}

function sideToMoveFromFen(fen: string): Color {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w';
}

/**
 * Decides the evaluation of a position the engine could not score. The engine
 * returns no score for a finished position, which is correct behaviour rather
 * than a failure — so the rules layer (ChessEngine, not the analysis engine)
 * is asked what actually happened. Returns null if the position is not in fact
 * terminal, in which case the engine's silence really was a problem.
 */
function terminalEvaluation(fen: string, rules: ChessEngine): Evaluation | null {
  const loaded = rules.loadFen(fen);
  if (!loaded.ok) return null;

  const status = rules.status();
  if (status === 'in_progress') return null;

  let result: TerminalResult;
  if (status === 'checkmate') {
    // The side to move is the side that has been mated.
    result = sideToMoveFromFen(fen) === 'w' ? 'black-wins' : 'white-wins';
  } else {
    result = 'draw';
  }
  // status === 'stalemate' is itself a draw, but a factually distinct one
  // from repetition/50-move/insufficient-material — preserved here rather
  // than collapsed, since ChessEngine.status() already tells us which.
  return status === 'stalemate' ? { kind: 'terminal', result, drawReason: 'stalemate' } : { kind: 'terminal', result };
}

export async function analyzeGame(
  game: GameRecord,
  engine: AnalysisEngine,
  rules: ChessEngine,
  options: AnalyzeGameOptions = {}
): Promise<Result<GameAnalysis, AppError>> {
  const settings = options.settings ?? DEFAULT_ANALYSIS_SETTINGS;
  const candidateSettings = options.candidateSettings ?? DEFAULT_CANDIDATE_SETTINGS;

  const positions = game.positions;
  const total = positions.length;

  // An empty game has no positions to evaluate and no plies to compare.
  if (total === 0) {
    return ok({ plies: [], candidates: [], settings });
  }

  const evaluations: (PositionEvaluation | null)[] = [];
  const fallbackEvaluations: (Evaluation | null)[] = [];

  for (let i = 0; i < total; i++) {
    if (options.isCancelled?.()) return err(analysisCancelledError());

    const fen = positions[i]!.fen;
    const result = await engine.evaluatePosition(fen, settings);

    if (result.ok) {
      evaluations.push(result.value);
      fallbackEvaluations.push(null);
    } else {
      if (result.error.code === 'analysis/cancelled') return err(result.error);
      // No score can legitimately mean "the game is already over here".
      const terminal = terminalEvaluation(fen, rules);
      if (terminal === null) return err(result.error);
      evaluations.push(null);
      fallbackEvaluations.push(terminal);
    }

    options.onProgress?.({ completed: i + 1, total });
  }

  const evaluationAt = (index: number): Evaluation => {
    const scored = evaluations[index];
    if (scored) return scored.evaluation;
    const fallback = fallbackEvaluations[index];
    if (fallback) return fallback;
    // Unreachable: every index gets either a score or a terminal fallback above.
    throw new Error(`analyzeGame: no evaluation recorded for position index ${index}`);
  };

  const plies: PlyAnalysis[] = game.moves.map((move) => {
    const beforeIndex = move.ply - 1;
    const afterIndex = move.ply;
    const evaluationBefore = evaluationAt(beforeIndex);
    const evaluationAfter = evaluationAt(afterIndex);
    const beforeDetail = evaluations[beforeIndex];

    return {
      ply: move.ply,
      moveNumber: Math.ceil(move.ply / 2),
      sideToMove: move.color,
      movePlayedSan: move.san,
      movePlayedUci: `${move.from}${move.to}${move.promotion ?? ''}`,
      fenBefore: positions[beforeIndex]!.fen,
      fenAfter: positions[afterIndex]!.fen,
      evaluationBefore,
      evaluationAfter,
      bestMove: beforeDetail?.bestMove ?? null,
      principalVariation: beforeDetail?.principalVariation ?? [],
      swingCp: evaluationSwingCp(evaluationBefore, evaluationAfter),
      swingForMoverCp: swingForMoverCp(evaluationBefore, evaluationAfter, move.color),
      mateTransition: mateTransition(evaluationBefore, evaluationAfter),
      depth: Math.min(
        evaluations[beforeIndex]?.depth ?? settings.depth,
        evaluations[afterIndex]?.depth ?? settings.depth
      )
    };
  });

  return ok({
    plies,
    candidates: detectCandidates(plies, candidateSettings),
    settings
  });
}
