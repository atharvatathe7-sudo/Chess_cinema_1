import type { ChessEngine } from '../chess/ChessEngine';
import { parsePgn } from '../pgn/parsePgn';
import { buildTrivialTimeline } from '../timeline/buildTrivialTimeline';
import { assertValidTimeline } from '../timeline/invariants';
import { clampToScene, nextBeatBoundaryMs, previousBeatBoundaryMs } from '../timeline/navigation';
import type { Scene } from '../timeline/types';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { appError } from '../errors/AppError';
import type { AppState } from './AppState';
import type { Store } from './store';

/** The Scene the store's current playback.activeSceneId points at, if any. */
function activeScene(state: AppState): Scene | null {
  return state.game?.timeline.scenes.find((sc) => sc.id === state.playback.activeSceneId) ?? null;
}

/**
 * Parses PGN, builds the Phase 1 trivial Timeline, validates it against
 * the lane invariants (a defense-in-depth check — buildTrivialTimeline
 * is proven correct by its own tests, but a future generator might not
 * be, and this is the one gate everything must pass through before it
 * can reach the renderer), and commits game+timeline to the store as a
 * single atomic update. On any failure the store is left untouched and
 * the error is returned to the caller (and mirrored into ui.pendingError
 * for the UI to display) rather than swallowed.
 */
export function loadPgn(
  store: Store<AppState>,
  pgnText: string,
  engine: ChessEngine
): Result<void, AppError> {
  const parseResult = parsePgn(pgnText, engine);
  if (!parseResult.ok) {
    store.setState((s) => ({ ...s, ui: { ...s.ui, pendingError: parseResult.error } }));
    return err(parseResult.error);
  }

  const gameRecord = parseResult.value;
  const timeline = buildTrivialTimeline(gameRecord);

  const violations = validateTimelineOrError(timeline);
  if (!violations.ok) {
    store.setState((s) => ({ ...s, ui: { ...s.ui, pendingError: violations.error } }));
    return err(violations.error);
  }

  const firstScene = timeline.scenes[0];
  if (!firstScene) {
    const error = appError('timeline/empty', 'recoverable', 'Timeline has no scenes.');
    store.setState((s) => ({ ...s, ui: { ...s.ui, pendingError: error } }));
    return err(error);
  }

  store.setState((s) => ({
    ...s,
    game: { gameRecord, timeline },
    playback: { ...s.playback, activeSceneId: firstScene.id, logicalTimeMs: 0, playing: false },
    ui: { ...s.ui, pendingError: null },
    // Any previous analysis (and, downstream of it, any previous
    // direction) describes the previous game, so both are dropped rather
    // than left to be read against the newly loaded one.
    analysis: { status: 'idle', progress: null, result: null, error: null },
    direction: { status: 'idle', result: null, error: null }
  }));

  return ok(undefined);
}

function validateTimelineOrError(timeline: Parameters<typeof assertValidTimeline>[0]): Result<void, AppError> {
  try {
    assertValidTimeline(timeline);
    return ok(undefined);
  } catch (cause) {
    return err(appError('timeline/invalid', 'fatal', 'Generated timeline failed invariant checks.', cause));
  }
}

export function setPlaying(store: Store<AppState>, playing: boolean): void {
  store.setState((s) => ({ ...s, playback: { ...s.playback, playing } }));
}

/**
 * The one function allowed to write playback.logicalTimeMs directly.
 * Every navigation action (scrubbing, Previous/Next Move, Restart) goes
 * through this, so out-of-range clamping only ever needs to live here —
 * see timeline/navigation.ts's clampToScene.
 */
export function seekTo(store: Store<AppState>, logicalTimeMs: number): void {
  store.setState((s) => {
    const scene = activeScene(s);
    const clamped = scene ? clampToScene(scene, logicalTimeMs) : Math.max(0, logicalTimeMs);
    return { ...s, playback: { ...s.playback, logicalTimeMs: clamped } };
  });
}

export function advancePlayback(store: Store<AppState>, deltaMs: number): void {
  store.setState((s) => {
    if (!s.playback.playing || !s.game) return s;
    const scene = activeScene(s);
    const max = scene ? scene.durationMs : s.playback.logicalTimeMs;
    const next = Math.min(max, s.playback.logicalTimeMs + deltaMs * s.playback.rate);
    return { ...s, playback: { ...s.playback, logicalTimeMs: next, playing: next < max } };
  });
}

/**
 * Resets the logical clock to the start and pauses, without touching
 * game/timeline — the loaded PGN stays loaded, matching every other
 * navigation action's "reposition, then let the user press Play"
 * convention (seekTo/scrubbing already worked this way).
 */
export function restart(store: Store<AppState>): void {
  seekTo(store, 0);
  setPlaying(store, false);
}

/** Jumps to the start of the next move/beat and pauses. No-op past the end of the timeline. */
export function goToNextMove(store: Store<AppState>): void {
  const state = store.getState();
  const scene = activeScene(state);
  if (!scene) return;
  seekTo(store, nextBeatBoundaryMs(scene, state.playback.logicalTimeMs));
  setPlaying(store, false);
}

/** Jumps to the start of the previous move/beat and pauses. No-op before the start of the timeline. */
export function goToPreviousMove(store: Store<AppState>): void {
  const state = store.getState();
  const scene = activeScene(state);
  if (!scene) return;
  seekTo(store, previousBeatBoundaryMs(scene, state.playback.logicalTimeMs));
  setPlaying(store, false);
}
