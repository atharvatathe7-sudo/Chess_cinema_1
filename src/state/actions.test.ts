import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { createInitialState, type AppState } from './AppState';
import { Store } from './store';
import { advancePlayback, loadPgn, seekTo, setPlaying } from './actions';

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
});
