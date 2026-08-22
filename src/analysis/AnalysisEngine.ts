import type { Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import type { AnalysisSettings, MultiPvResult, PositionEvaluation } from './types';

/**
 * Position evaluation — deliberately SEPARATE from chess/ChessEngine.
 *
 * ChessEngine  = the rules: what is legal, what position results, is it mate.
 * AnalysisEngine = the opinion: how good is this position, what would be best.
 *
 * They are different concerns with different failure modes and different
 * lifetimes (rules are instant and always available; analysis is slow,
 * cancellable, and may be unavailable entirely). Stockfish implements this
 * interface; it never replaces or subsumes ChessEngine, and nothing in the
 * rules layer depends on analysis being present. Keeping the split means a
 * game still loads and plays back with no analysis engine at all.
 */
export interface AnalysisEngine {
  /** Boots the engine and waits until it is ready to accept work. */
  init(): Promise<Result<void, AppError>>;

  /**
   * Evaluates a single position given as FEN. Resolves with our own
   * PositionEvaluation (white-relative — see types.ts), never engine-native
   * types or raw protocol text.
   */
  evaluatePosition(fen: string, settings: AnalysisSettings): Promise<Result<PositionEvaluation, AppError>>;

  /**
   * Evaluates a position and returns the engine's top `lines` distinct
   * lines, ranked by strength, instead of only the best. Additive to the
   * single-PV evaluatePosition — implementations must leave that method's
   * behaviour unaffected regardless of how many MultiPV calls preceded it.
   * Used by Phase 2.2's Chess Understanding Layer, selectively and within a
   * bounded budget; ordinary single-PV analysis never calls this.
   */
  evaluatePositionMultiPv(
    fen: string,
    settings: AnalysisSettings,
    lines: number
  ): Promise<Result<MultiPvResult, AppError>>;

  /**
   * Aborts any in-flight evaluation. Safe to call when nothing is running.
   * An evaluation interrupted this way resolves as a cancellation error
   * rather than hanging or silently returning a partial score.
   */
  cancel(): void;

  /** Releases the worker and any engine resources. The engine is unusable afterwards. */
  dispose(): void;
}
