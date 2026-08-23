import type { ChessEngine } from '../chess/ChessEngine';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import { understandGame } from '../understanding/understandGame';
import { DEFAULT_UNDERSTANDING_SETTINGS, type UnderstandingSettings } from '../understanding/types';
import { buildStoryPlan } from '../story/buildStoryPlan';
import { buildCinematicPlan } from '../director/buildCinematicPlan';
import { lowerToTimeline } from '../director/lowerToTimeline';
import { assertValidTimeline } from '../timeline/invariants';
import { appError, type AppError } from '../errors/AppError';
import type { AppState } from './AppState';
import type { Store } from './store';

/**
 * Store-level wiring for Phase 2.5 (Cinematic Direction). Mirrors
 * state/analysisActions.ts's own conventions exactly: these are the only
 * functions permitted to write the direction slice, and — on success only
 * — to atomically replace game.timeline alongside it. A failed run never
 * touches game.timeline, so the existing (trivial or previously-directed)
 * timeline stays fully usable.
 */

/** Reduced follow-up engine budget for live UI responsiveness — the same one tests/e2e/*.spec.ts already use. */
const LIVE_UNDERSTANDING_SETTINGS: UnderstandingSettings = {
  ...DEFAULT_UNDERSTANDING_SETTINGS,
  engineBudget: {
    ...DEFAULT_UNDERSTANDING_SETTINGS.engineBudget,
    maxFollowUpPositions: 4,
    multiPvDepth: 8,
    multiPvMaxTimeMsPerPosition: 2000
  }
};

/** Set while a run is in flight, so cancelDirection() can stop it. */
let activeRun: { cancelled: boolean; engine: AnalysisEngine } | null = null;

export function isDirectionRunning(): boolean {
  return activeRun !== null;
}

/**
 * Runs the full (GameUnderstanding -> StoryPlan -> CinematicPlan ->
 * Timeline) pipeline against the game's already-completed analysis, and —
 * only if every step succeeds — atomically replaces game.timeline with the
 * result, resets playback to the start, and pauses. Requires a completed
 * analysis (never analyzes on its own — that stays "Analyze Game"'s own,
 * separate, explicit responsibility) and refuses to run a second time
 * concurrently, exactly like runAnalysis.
 */
export async function runDirection(
  store: Store<AppState>,
  engine: AnalysisEngine,
  rules: ChessEngine,
  settings: UnderstandingSettings = LIVE_UNDERSTANDING_SETTINGS
): Promise<void> {
  const state = store.getState();
  const game = state.game;
  const analysis = state.analysis;
  if (!game) return;
  if (analysis.status !== 'complete' || !analysis.result) return;
  if (activeRun) return; // one run at a time; a second request is ignored rather than racing

  const run = { cancelled: false, engine };
  activeRun = run;

  // Every setState below is guarded by `s.game !== game`: `game` is the
  // LoadedGame captured above, at this call's own start. Every step past
  // this point is async (an engine call, or work that follows one), so the
  // user can load an entirely different PGN before any of them settle —
  // loadPgn() gives that new game its own fresh `game` object, so a stale
  // guard here reliably tells "this run's game is no longer the active
  // one" and discards the commit instead of writing it. Without this, a
  // late-resolving run for an abandoned game could silently overwrite the
  // current game's timeline/playback/direction with data describing a
  // different game entirely (the exact defect the Phase 2.5 review found
  // and reproduced).
  store.setState((s) => {
    if (s.game !== game) return s;
    return { ...s, direction: { status: 'running', result: null, error: null } };
  });

  try {
    const initResult = await engine.init();
    if (!initResult.ok) {
      store.setState((s) => {
        if (s.game !== game) return s;
        return { ...s, direction: { status: 'error', result: null, error: initResult.error } };
      });
      return;
    }

    const understandingResult = await understandGame(game.gameRecord, analysis.result, engine, {
      settings,
      isCancelled: () => run.cancelled
    });
    if (!understandingResult.ok) {
      if (run.cancelled) {
        store.setState((s) => {
          if (s.game !== game) return s;
          return { ...s, direction: { status: 'idle', result: null, error: null } };
        });
      } else {
        store.setState((s) => {
          if (s.game !== game) return s;
          return { ...s, direction: { status: 'error', result: null, error: understandingResult.error } };
        });
      }
      return;
    }
    const understanding = understandingResult.value;

    // Everything from here on is pure/synchronous — no engine call can
    // fail it for a valid, already-analyzed GameRecord (see each module's
    // own doc comment: buildStoryPlan, buildCinematicPlan, lowerToTimeline
    // are all deterministic functions of already-materialized inputs).
    const story = buildStoryPlan(game.gameRecord, analysis.result, understanding);
    const cinematicPlan = buildCinematicPlan(game.gameRecord, analysis.result, understanding, story);
    const timeline = lowerToTimeline(game.gameRecord, cinematicPlan);

    try {
      assertValidTimeline(timeline);
    } catch (cause) {
      store.setState((s) => {
        if (s.game !== game) return s;
        return {
          ...s,
          direction: {
            status: 'error',
            result: null,
            error: appError('direction/invalid-timeline', 'fatal', 'Generated cinematic timeline failed invariant checks.', cause)
          }
        };
      });
      return;
    }

    const firstScene = timeline.scenes[0];
    if (!firstScene) {
      store.setState((s) => {
        if (s.game !== game) return s;
        return {
          ...s,
          direction: {
            status: 'error',
            result: null,
            error: appError('direction/empty-timeline', 'fatal', 'Generated cinematic timeline has no scenes.')
          }
        };
      });
      return;
    }

    // The one atomic update that matters: direction result, the new
    // timeline, and a reset playback position all commit together — never
    // a partial state where one has changed and the others haven't. Guarded
    // by the same staleness check as every other commit above — see the
    // comment on this function's first setState for why it's necessary.
    store.setState((s) => {
      if (s.game !== game) return s;

      return {
        ...s,
        direction: {
          status: 'complete',
          result: { understanding, story, cinematicPlan },
          error: null
        },
        game: {
          ...s.game,
          timeline
        },
        playback: {
          ...s.playback,
          activeSceneId: firstScene.id,
          logicalTimeMs: 0,
          playing: false
        }
      };
    });
  } finally {
    activeRun = null;
  }
}

/**
 * Requests cancellation of the in-flight run. Both flags matter, same as
 * cancelAnalysis: the engine is told to stop searching the current
 * position immediately, and the loop is told not to start the next one.
 */
export function cancelDirection(): void {
  if (!activeRun) return;
  activeRun.cancelled = true;
  activeRun.engine.cancel();
}
