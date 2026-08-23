import type { GameRecord } from '../pgn/types';
import type { Timeline } from '../timeline/types';
import type { AppError } from '../errors/AppError';
import type { AnalysisProgress, GameAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import type { StoryPlan } from '../story/types';
import type { CinematicPlan } from '../director/types';

/**
 * A GameRecord and the Timeline generated from it always travel together
 * — there is no state shape in which one exists without the other, so
 * they cannot silently drift out of sync (Correction 2).
 */
export interface LoadedGame {
  gameRecord: GameRecord;
  timeline: Timeline;
}

export interface PlaybackState {
  activeSceneId: string;
  /**
   * Virtual clock. Advanced by preview/PreviewLoop while playing;
   * computed arithmetically by export/runExport during export. Never
   * read from Date.now()/performance.now() outside those two drivers.
   */
  logicalTimeMs: number;
  playing: boolean;
  rate: number;
}

export interface UiState {
  pendingError: AppError | null;
  /**
   * Reserved, intentionally unused in Phase 1 (Correction 2): the
   * designated slot for future transient, in-progress-edit state (e.g. a
   * live drag before it becomes a committed Beat). Must never be read by
   * render/, and must never carry move timing or piece position data
   * that duplicates what Timeline already encodes.
   */
  transient?: unknown;
}

export type AssetLoadState = 'loading' | 'ready' | 'error';

export interface AssetState {
  pieces: AssetLoadState;
  error?: AppError;
}

/**
 * Analysis is strictly ADDITIVE state (Phase 2.1). It records what the engine
 * found, and nothing else: it holds no clock, no position, no piece placement
 * and no timing of its own, so it cannot drift from — or compete with —
 * Timeline/playback, which remain the sole authority for what is displayed
 * when. The renderer never reads this slice.
 */
export type AnalysisRunState = 'idle' | 'running' | 'complete' | 'error';

export interface AnalysisState {
  status: AnalysisRunState;
  /** Progress of the run currently in flight, if any. */
  progress: AnalysisProgress | null;
  /** The completed analysis, or null when none has finished for the loaded game. */
  result: GameAnalysis | null;
  error: AppError | null;
}

/**
 * Phase 2.5 — Cinematic Direction. Additive, like AnalysisState: it holds
 * what the (GameUnderstanding -> StoryPlan -> CinematicPlan) pipeline
 * produced, and nothing else. It never carries a clock or position of its
 * own. Unlike analysis, a *successful* run's side effect reaches beyond
 * this slice — it also atomically replaces game.timeline (state/
 * directionActions.ts is the only place allowed to do that) — but the
 * slice itself is still purely additive: renderer/preview/export never
 * read it directly, only game.timeline.
 */
export type DirectionRunState = 'idle' | 'running' | 'complete' | 'error';

export interface DirectionResult {
  readonly understanding: GameUnderstanding;
  readonly story: StoryPlan;
  readonly cinematicPlan: CinematicPlan;
}

export interface DirectionState {
  status: DirectionRunState;
  /** The completed pipeline output, or null when no successful run exists for the loaded game. */
  result: DirectionResult | null;
  error: AppError | null;
}

export interface AppState {
  game: LoadedGame | null;
  playback: PlaybackState;
  ui: UiState;
  assets: AssetState;
  analysis: AnalysisState;
  direction: DirectionState;
}

export function createInitialState(): AppState {
  return {
    game: null,
    playback: {
      activeSceneId: '',
      logicalTimeMs: 0,
      playing: false,
      rate: 1
    },
    ui: {
      pendingError: null
    },
    assets: {
      pieces: 'loading'
    },
    analysis: {
      status: 'idle',
      progress: null,
      result: null,
      error: null
    },
    direction: {
      status: 'idle',
      result: null,
      error: null
    }
  };
}
