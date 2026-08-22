import type { GameRecord } from '../pgn/types';
import type { Timeline } from '../timeline/types';
import type { AppError } from '../errors/AppError';

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

export interface AppState {
  game: LoadedGame | null;
  playback: PlaybackState;
  ui: UiState;
  assets: AssetState;
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
    }
  };
}
