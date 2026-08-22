import type { ChessEngine } from '../chess/ChessEngine';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import { analyzeGame } from '../analysis/analyzeGame';
import type { AnalysisSettings } from '../analysis/types';
import type { AppState } from './AppState';
import type { Store } from './store';

/**
 * Store-level wiring for analysis runs. Mirrors the existing actions.ts
 * conventions: these are the only functions permitted to write the analysis
 * slice, and they never touch game/timeline/playback.
 */

/** Set while a run is in flight, so cancelAnalysis() can stop it. */
let activeRun: { cancelled: boolean; engine: AnalysisEngine } | null = null;

export function isAnalysisRunning(): boolean {
  return activeRun !== null;
}

/**
 * Runs a full-game analysis, streaming progress into the store as it goes.
 *
 * The engine does its work in a Web Worker, and this function awaits it one
 * position at a time, so the main thread is free between positions: the UI
 * keeps rendering and the Cancel button stays responsive throughout.
 */
export async function runAnalysis(
  store: Store<AppState>,
  engine: AnalysisEngine,
  rules: ChessEngine,
  settings?: AnalysisSettings
): Promise<void> {
  const game = store.getState().game;
  if (!game) return;
  if (activeRun) return; // one run at a time; a second request is ignored rather than racing

  const run = { cancelled: false, engine };
  activeRun = run;

  store.setState((s) => ({
    ...s,
    analysis: { status: 'running', progress: { completed: 0, total: 0 }, result: null, error: null }
  }));

  try {
    const initResult = await engine.init();
    if (!initResult.ok) {
      store.setState((s) => ({
        ...s,
        analysis: { status: 'error', progress: null, result: null, error: initResult.error }
      }));
      return;
    }

    const result = await analyzeGame(game.gameRecord, engine, rules, {
      ...(settings ? { settings } : {}),
      onProgress: (progress) => {
        store.setState((s) =>
          s.analysis.status === 'running' ? { ...s, analysis: { ...s.analysis, progress } } : s
        );
      },
      isCancelled: () => run.cancelled
    });

    if (result.ok) {
      store.setState((s) => ({
        ...s,
        analysis: { status: 'complete', progress: null, result: result.value, error: null }
      }));
    } else if (result.error.code === 'analysis/cancelled') {
      store.setState((s) => ({
        ...s,
        analysis: { status: 'idle', progress: null, result: null, error: null }
      }));
    } else {
      store.setState((s) => ({
        ...s,
        analysis: { status: 'error', progress: null, result: null, error: result.error }
      }));
    }
  } finally {
    activeRun = null;
  }
}

/**
 * Requests cancellation of the in-flight run. Both flags matter: the engine
 * is told to stop searching the current position immediately, and the loop is
 * told not to start the next one.
 */
export function cancelAnalysis(): void {
  if (!activeRun) return;
  activeRun.cancelled = true;
  activeRun.engine.cancel();
}
