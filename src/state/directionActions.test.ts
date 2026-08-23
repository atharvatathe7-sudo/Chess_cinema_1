import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from '../pgn/parsePgn';
import { analyzeGame } from '../analysis/analyzeGame';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import type { AnalysisSettings, Evaluation, GameAnalysis, MultiPvResult, PositionEvaluation } from '../analysis/types';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { appError } from '../errors/AppError';
import { createInitialState, type AppState } from './AppState';
import { Store } from './store';
import { loadPgn } from './actions';
import { cancelDirection, runDirection } from './directionActions';

/**
 * A deterministic stand-in for Stockfish, mirroring analysis/analyzeGame.test.ts's
 * ScriptedEngine and understanding/understandGame.test.ts's StubEngine — these
 * tests are about directionActions' own store-orchestration (guards, atomicity,
 * playback reset, failure safety), not about understandGame/buildStoryPlan's own
 * correctness, which is already covered by their own test suites.
 */
class QuietEngine implements AnalysisEngine {
  async init(): Promise<Result<void, AppError>> {
    return ok(undefined);
  }
  async evaluatePosition(_fen: string, _settings: AnalysisSettings): Promise<Result<PositionEvaluation, AppError>> {
    const cp: Evaluation = { kind: 'cp', cp: 0 };
    return ok({ evaluation: cp, bestMove: 'e2e4', principalVariation: ['e2e4'], depth: 12 });
  }
  async evaluatePositionMultiPv(): Promise<Result<MultiPvResult, AppError>> {
    return ok({ lines: [] });
  }
  cancel(): void {}
  dispose(): void {}
}

class InitFailsEngine implements AnalysisEngine {
  async init(): Promise<Result<void, AppError>> {
    return err(appError('engine/init-failed', 'fatal', 'fixture: engine init deliberately fails'));
  }
  async evaluatePosition(): Promise<Result<never, AppError>> {
    throw new Error('not reached');
  }
  async evaluatePositionMultiPv(): Promise<Result<never, AppError>> {
    throw new Error('not reached');
  }
  cancel(): void {}
  dispose(): void {}
}

/**
 * Same as QuietEngine, but init() stays pending until the test explicitly
 * releases it — a deterministic (no sleep/timing guesswork) way to hold a
 * runDirection call open across an intervening loadPgn() or
 * cancelDirection() call, exactly reproducing the interleaving the Phase
 * 2.5 review found and confirmed.
 */
class DeferredInitEngine implements AnalysisEngine {
  private release!: () => void;
  private readonly gate: Promise<void>;
  constructor() {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }
  async init(): Promise<Result<void, AppError>> {
    await this.gate;
    return ok(undefined);
  }
  releaseInit(): void {
    this.release();
  }
  async evaluatePosition(): Promise<Result<PositionEvaluation, AppError>> {
    const cp: Evaluation = { kind: 'cp', cp: 0 };
    return ok({ evaluation: cp, bestMove: 'e2e4', principalVariation: ['e2e4'], depth: 12 });
  }
  async evaluatePositionMultiPv(): Promise<Result<MultiPvResult, AppError>> {
    return ok({ lines: [] });
  }
  cancel(): void {}
  dispose(): void {}
}

const FIXTURE_PGN = '1. e4 e5 2. Nf3 Nc6';
const OTHER_PGN = '1. d4 d5 2. c4 e6';

async function realAnalysis(): Promise<GameAnalysis> {
  const rules = new ChessJsEngine();
  const parsed = parsePgn(FIXTURE_PGN, rules);
  if (!parsed.ok) throw new Error('fixture PGN failed to parse');
  const result = await analyzeGame(parsed.value, new QuietEngine(), new ChessJsEngine());
  if (!result.ok) throw new Error('fixture analysis failed to build');
  return result.value;
}

/** A store with a loaded game and a completed analysis, ready for runDirection. */
async function analyzedStore(): Promise<Store<AppState>> {
  const store = new Store<AppState>(createInitialState());
  const loadResult = loadPgn(store, FIXTURE_PGN, new ChessJsEngine());
  if (!loadResult.ok) throw new Error('fixture PGN failed to load');
  const analysis = await realAnalysis();
  store.setState((s) => ({ ...s, analysis: { status: 'complete', progress: null, result: analysis, error: null } }));
  return store;
}

describe('runDirection', () => {
  it('does not run without a completed analysis', async () => {
    const store = new Store<AppState>(createInitialState());
    const loadResult = loadPgn(store, FIXTURE_PGN, new ChessJsEngine());
    expect(loadResult.ok).toBe(true);
    expect(store.getState().analysis.status).toBe('idle');

    const timelineBefore = store.getState().game!.timeline;
    await runDirection(store, new QuietEngine(), new ChessJsEngine());

    expect(store.getState().direction.status).toBe('idle');
    expect(store.getState().game!.timeline).toBe(timelineBefore);
  });

  it('does not run concurrently: a second call while one is in flight is a no-op', async () => {
    const store = await analyzedStore();

    const first = runDirection(store, new QuietEngine(), new ChessJsEngine());
    // Fired while the first run is still in flight (activeRun is set).
    const second = runDirection(store, new QuietEngine(), new ChessJsEngine());

    await Promise.all([first, second]);

    // Exactly one successful completion — the second call returned
    // immediately without starting a competing run or corrupting state.
    expect(store.getState().direction.status).toBe('complete');
    expect(store.getState().direction.result).not.toBeNull();
  });

  it('on success, atomically stores the direction result and replaces game.timeline', async () => {
    const store = await analyzedStore();
    const timelineBefore = store.getState().game!.timeline;

    await runDirection(store, new QuietEngine(), new ChessJsEngine());

    const state = store.getState();
    expect(state.direction.status).toBe('complete');
    expect(state.direction.error).toBeNull();
    expect(state.direction.result).not.toBeNull();
    expect(state.direction.result!.understanding).toBeDefined();
    expect(state.direction.result!.story).toBeDefined();
    expect(state.direction.result!.cinematicPlan).toBeDefined();
    // game.timeline was actually replaced (a new object), not left as the trivial one.
    expect(state.game!.timeline).not.toBe(timelineBefore);
  });

  it('on success, resets playback to logicalTimeMs 0 and playing false', async () => {
    const store = await analyzedStore();
    // Simulate the user having scrubbed/played partway through before directing.
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: 999, playing: true } }));

    await runDirection(store, new QuietEngine(), new ChessJsEngine());

    const state = store.getState();
    expect(state.direction.status).toBe('complete');
    expect(state.playback.logicalTimeMs).toBe(0);
    expect(state.playback.playing).toBe(false);
  });

  it('on failure, leaves the existing timeline unchanged', async () => {
    const store = await analyzedStore();
    const timelineBefore = store.getState().game!.timeline;
    const playbackBefore = store.getState().playback;

    await runDirection(store, new InitFailsEngine(), new ChessJsEngine());

    const state = store.getState();
    expect(state.direction.status).toBe('error');
    expect(state.direction.error).not.toBeNull();
    expect(state.direction.result).toBeNull();
    // The trivial timeline from load is still exactly what it was — same
    // object, not just equal — and playback was never touched.
    expect(state.game!.timeline).toBe(timelineBefore);
    expect(state.playback).toEqual(playbackBefore);
  });

  it('loading a new PGN resets direction state back to idle', async () => {
    const store = await analyzedStore();
    await runDirection(store, new QuietEngine(), new ChessJsEngine());
    expect(store.getState().direction.status).toBe('complete');

    const secondLoad = loadPgn(store, '1. d4 d5', new ChessJsEngine());
    expect(secondLoad.ok).toBe(true);

    const state = store.getState();
    expect(state.direction).toEqual({ status: 'idle', result: null, error: null });
    expect(state.analysis).toEqual({ status: 'idle', progress: null, result: null, error: null });
  });

  it('a stale in-flight run for an abandoned game never overwrites the newly-loaded game (Phase 2.5 review regression)', async () => {
    // 1. Start Direction for Game A.
    const store = await analyzedStore(); // Game A = FIXTURE_PGN, analyzed
    const engine = new DeferredInitEngine();
    const directionPromise = runDirection(store, engine, new ChessJsEngine());

    // Deterministically wait for the run to actually be in flight (its own
    // synchronous 'running' setState has happened) before proceeding — no
    // sleep/timing guesswork, just draining the microtask queue up to that
    // known point.
    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().direction.status).toBe('running');

    // 2. The async run is deterministically held open (gated on init()).
    // 3. Load Game B while Game A's run is still stuck inside engine.init().
    const loadB = loadPgn(store, OTHER_PGN, new ChessJsEngine());
    expect(loadB.ok).toBe(true);
    const gameBRecordRef = store.getState().game!.gameRecord;
    const gameBTimelineRef = store.getState().game!.timeline;
    const playbackAfterLoadB = store.getState().playback;
    expect(store.getState().direction.status).toBe('idle'); // loadPgn's own reset

    // 4. Allow the old Game A run to finish.
    engine.releaseInit();
    await directionPromise;

    // 5. None of it reached Game B's state.
    const finalState = store.getState();
    expect(finalState.game!.gameRecord).toBe(gameBRecordRef); // still Game B
    expect(finalState.game!.timeline).toBe(gameBTimelineRef); // Game B's original timeline, unchanged
    expect(finalState.playback).toEqual(playbackAfterLoadB); // playback unchanged
    expect(finalState.direction.result).toBeNull(); // Game A's stale result never landed
    expect(finalState.direction.status).toBe('idle'); // no stale "complete" applied to Game B
  });

  it('cancelDirection() returns direction to idle and leaves the existing timeline/playback unchanged', async () => {
    const store = await analyzedStore();
    const timelineBefore = store.getState().game!.timeline;
    const playbackBefore = store.getState().playback;

    const engine = new DeferredInitEngine();
    const directionPromise = runDirection(store, engine, new ChessJsEngine());

    await Promise.resolve();
    await Promise.resolve();
    expect(store.getState().direction.status).toBe('running');

    // Cancel while still gated inside engine.init() — understandGame's own
    // isCancelled() check (understanding/understandGame.ts) fires as soon
    // as it's called and short-circuits immediately, before any further
    // engine work, exactly like analyzeGame's own cancellation convention.
    cancelDirection();
    engine.releaseInit();
    await directionPromise;

    const state = store.getState();
    expect(state.direction).toEqual({ status: 'idle', result: null, error: null });
    expect(state.game!.timeline).toBe(timelineBefore);
    expect(state.playback).toEqual(playbackBefore);
  });
});
