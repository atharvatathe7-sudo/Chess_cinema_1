import type { ChessEngine } from '../chess/ChessEngine';
import { parsePgn } from '../pgn/parsePgn';
import { buildTrivialTimeline } from '../timeline/buildTrivialTimeline';
import { assertValidTimeline } from '../timeline/invariants';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { appError } from '../errors/AppError';
import type { AppState } from './AppState';
import type { Store } from './store';

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
    ui: { ...s.ui, pendingError: null }
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

export function seekTo(store: Store<AppState>, logicalTimeMs: number): void {
  store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs } }));
}

export function advancePlayback(store: Store<AppState>, deltaMs: number): void {
  store.setState((s) => {
    if (!s.playback.playing || !s.game) return s;
    const scene = s.game.timeline.scenes.find((sc) => sc.id === s.playback.activeSceneId);
    const max = scene ? scene.durationMs : s.playback.logicalTimeMs;
    const next = Math.min(max, s.playback.logicalTimeMs + deltaMs * s.playback.rate);
    return { ...s, playback: { ...s.playback, logicalTimeMs: next, playing: next < max } };
  });
}
