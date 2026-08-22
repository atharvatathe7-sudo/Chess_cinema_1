import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { createInitialState, type AppState } from './AppState';
import { Store } from './store';
import {
  advancePlayback,
  goToNextMove,
  goToPreviousMove,
  loadPgn,
  restart,
  seekTo,
  setPlaying
} from './actions';

const PGN = '1. e4 e5 2. Nf3 Nc6';

describe('loadPgn action', () => {
  it('commits game and timeline atomically and resets playback', () => {
    const store = new Store<AppState>(createInitialState());
    const result = loadPgn(store, PGN, new ChessJsEngine());

    expect(result.ok).toBe(true);
    const state = store.getState();
    expect(state.game).not.toBeNull();
    expect(state.game!.timeline.scenes).toHaveLength(1);
    expect(state.playback.activeSceneId).toBe(state.game!.timeline.scenes[0]!.id);
    expect(state.playback.logicalTimeMs).toBe(0);
    expect(state.ui.pendingError).toBeNull();
  });

  it('leaves the store untouched and surfaces a recoverable error on malformed PGN', () => {
    const store = new Store<AppState>(createInitialState());
    const before = store.getState();

    const result = loadPgn(store, 'not a pgn', new ChessJsEngine());

    expect(result.ok).toBe(false);
    const after = store.getState();
    expect(after.game).toBeNull();
    expect(after).not.toBe(before); // pendingError update still fires...
    expect(after.game).toEqual(before.game); // ...but game/timeline are untouched
    expect(after.ui.pendingError).not.toBeNull();
  });
});

describe('playback actions', () => {
  function loadedStore(): Store<AppState> {
    const store = new Store<AppState>(createInitialState());
    loadPgn(store, PGN, new ChessJsEngine());
    return store;
  }

  it('setPlaying toggles the playing flag only', () => {
    const store = loadedStore();
    setPlaying(store, true);
    expect(store.getState().playback.playing).toBe(true);
  });

  it('seekTo sets logicalTimeMs directly', () => {
    const store = loadedStore();
    seekTo(store, 1234);
    expect(store.getState().playback.logicalTimeMs).toBe(1234);
  });

  it('advancePlayback clamps to the active scene duration and stops playing at the end', () => {
    const store = loadedStore();
    const duration = store.getState().game!.timeline.scenes[0]!.durationMs;
    setPlaying(store, true);

    advancePlayback(store, duration + 10_000);

    const state = store.getState();
    expect(state.playback.logicalTimeMs).toBe(duration);
    expect(state.playback.playing).toBe(false);
  });

  it('advancePlayback is a no-op while paused', () => {
    const store = loadedStore();
    seekTo(store, 100);
    setPlaying(store, false);

    advancePlayback(store, 500);

    expect(store.getState().playback.logicalTimeMs).toBe(100);
  });

  it('seekTo clamps out-of-range values to [0, sceneDurationMs]', () => {
    const store = loadedStore();
    const duration = store.getState().game!.timeline.scenes[0]!.durationMs;

    seekTo(store, -500);
    expect(store.getState().playback.logicalTimeMs).toBe(0);

    seekTo(store, duration + 9999);
    expect(store.getState().playback.logicalTimeMs).toBe(duration);
  });
});

describe('restart action', () => {
  function loadedStore(): Store<AppState> {
    const store = new Store<AppState>(createInitialState());
    loadPgn(store, PGN, new ChessJsEngine());
    return store;
  }

  it('resets the clock to 0 and pauses, without clearing the loaded game', () => {
    const store = loadedStore();
    seekTo(store, 1800);
    setPlaying(store, true);

    restart(store);

    const state = store.getState();
    expect(state.playback.logicalTimeMs).toBe(0);
    expect(state.playback.playing).toBe(false);
    expect(state.game).not.toBeNull(); // PGN was not reloaded
  });

  it('restart -> play advances from 0, not from the pre-restart position', () => {
    const store = loadedStore();
    seekTo(store, 1800);

    restart(store);
    setPlaying(store, true);
    advancePlayback(store, 250);

    expect(store.getState().playback.logicalTimeMs).toBe(250);
  });
});

describe('goToNextMove / goToPreviousMove', () => {
  function loadedStore(): Store<AppState> {
    const store = new Store<AppState>(createInitialState());
    loadPgn(store, PGN, new ChessJsEngine()); // 4 beats: e4, e5, Nf3, Nc6 at 0/600/1200/1800
    return store;
  }

  it('steps forward through beat boundaries and pauses', () => {
    const store = loadedStore();
    setPlaying(store, true);

    goToNextMove(store);
    expect(store.getState().playback.logicalTimeMs).toBe(600);
    expect(store.getState().playback.playing).toBe(false);

    goToNextMove(store);
    expect(store.getState().playback.logicalTimeMs).toBe(1200);
  });

  it('steps backward through beat boundaries and pauses', () => {
    const store = loadedStore();
    seekTo(store, 1800);
    setPlaying(store, true);

    goToPreviousMove(store);
    expect(store.getState().playback.logicalTimeMs).toBe(1200);
    expect(store.getState().playback.playing).toBe(false);

    goToPreviousMove(store);
    expect(store.getState().playback.logicalTimeMs).toBe(600);
  });

  it('is a no-op at the respective boundary', () => {
    const store = loadedStore();

    goToPreviousMove(store); // already at the start
    expect(store.getState().playback.logicalTimeMs).toBe(0);

    seekTo(store, store.getState().game!.timeline.scenes[0]!.durationMs);
    goToNextMove(store); // already at the end
    expect(store.getState().playback.logicalTimeMs).toBe(2400);
  });
});

describe('interaction scenarios required by Phase 1.1', () => {
  function loadedStore(): Store<AppState> {
    const store = new Store<AppState>(createInitialState());
    loadPgn(store, PGN, new ChessJsEngine());
    return store;
  }

  it('play -> pause -> scrub -> play works correctly: playback resumes from the scrubbed position', () => {
    const store = loadedStore();

    setPlaying(store, true);
    advancePlayback(store, 500); // logicalTimeMs = 500, still playing

    setPlaying(store, false); // pause
    expect(store.getState().playback.logicalTimeMs).toBe(500);

    seekTo(store, 1500); // scrub while paused
    expect(store.getState().playback.playing).toBe(false); // scrubbing itself never resumes playback

    setPlaying(store, true); // play again
    advancePlayback(store, 200);

    // advances from the scrubbed position (1500 + 200), not from the
    // pre-scrub position (500) and not from two independent clocks.
    expect(store.getState().playback.logicalTimeMs).toBe(1700);
  });
});
