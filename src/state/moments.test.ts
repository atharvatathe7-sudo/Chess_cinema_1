import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from '../pgn/parsePgn';
import { DEFAULT_DIRECTOR_SETTINGS, DIRECTOR_SCHEMA_VERSION, type AnnotationDirective, type AnnotationDirectiveKind, type CinematicPlan } from '../director/types';
import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import { DEFAULT_ANALYSIS_SETTINGS } from '../analysis/types';
import type { MoveBeat, Timeline } from '../timeline/types';
import { createInitialState, type AppState } from './AppState';
import { Store } from './store';
import { deriveCinematicMoments, goToNextMoment, goToPreviousMoment } from './moments';

/**
 * Fixture builders. director/annotations.ts and director/lowerToTimeline.ts
 * are already independently tested elsewhere (director/annotations.test.ts,
 * director/lowerToTimeline.test.ts) for producing correct
 * AnnotationDirective/AnnotationBeat data in the first place — these tests
 * are about moments.ts's own derivation/merge/navigation logic given that
 * data, so the fixtures below are hand-built directly rather than run
 * through the real pipeline (same "ScriptedEngine"-style precedent already
 * established in analysis/analyzeGame.test.ts and understanding/
 * understandGame.test.ts).
 */

function moveBeat(ply: number, atMs: number, durationMs: number): MoveBeat {
  return {
    kind: 'move',
    san: `move${ply}`,
    pieceId: `w-p-${ply}` as never,
    from: 'e2',
    to: 'e4',
    atMs,
    durationMs,
    isEnPassant: false,
    resultingPly: ply
  };
}

/** Builds a single-scene Timeline whose moves have the given durations, back to back with no gaps. */
function timelineFromDurations(durationsMs: readonly number[]): Timeline {
  const beats: MoveBeat[] = [];
  let cursor = 0;
  for (let i = 0; i < durationsMs.length; i++) {
    const ply = i + 1;
    beats.push(moveBeat(ply, cursor, durationsMs[i]!));
    cursor += durationsMs[i]!;
  }
  return {
    scenes: [
      {
        id: 'scene-0',
        startPositionFen: 'startpos',
        startPly: 0,
        beats,
        cameraPlan: { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] },
        durationMs: cursor
      }
    ]
  };
}

function directive(
  kind: AnnotationDirectiveKind,
  fromPly: number,
  toPly: number,
  evidenceRef: AnnotationDirective['evidenceRef'] = { kind: 'move', ply: fromPly }
): AnnotationDirective {
  return { fromPly, toPly, kind, squares: ['e2', 'e4'], evidenceRef };
}

function cinematicPlan(annotationDirectives: readonly AnnotationDirective[]): CinematicPlan {
  return {
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
    moveTreatmentPlan: [],
    cameraDirectives: [],
    annotationDirectives,
    transitionDirectives: [],
    settings: DEFAULT_DIRECTOR_SETTINGS
  };
}

function plyAnalysis(ply: number, evaluationAfter: PlyAnalysis['evaluationAfter']): PlyAnalysis {
  return {
    ply,
    moveNumber: Math.ceil(ply / 2),
    sideToMove: ply % 2 === 1 ? 'w' : 'b',
    movePlayedSan: `m${ply}`,
    movePlayedUci: 'e2e4',
    fenBefore: 'startpos',
    fenAfter: 'startpos',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter,
    bestMove: null,
    principalVariation: [],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12
  };
}

function analysisEndingWith(plyCount: number, finalEvaluationAfter: PlyAnalysis['evaluationAfter']): GameAnalysis {
  const plies: PlyAnalysis[] = [];
  for (let ply = 1; ply <= plyCount; ply++) {
    const isLast = ply === plyCount;
    plies.push(plyAnalysis(ply, isLast ? finalEvaluationAfter : { kind: 'cp', cp: 0 }));
  }
  return { plies, candidates: [], settings: DEFAULT_ANALYSIS_SETTINGS };
}

const QUIET_ANALYSIS = analysisEndingWith(6, { kind: 'cp', cp: 10 });

describe('deriveCinematicMoments', () => {
  it('A: excludes last-move', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    const plan = cinematicPlan([directive('last-move', 1, 1), directive('last-move', 2, 2), directive('last-move', 3, 3)]);
    expect(deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS)).toEqual([]);
  });

  it('B: includes all four meaningful annotation kinds', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600]);
    const plan = cinematicPlan([
      directive('threat-refutation-arrow', 1, 1),
      directive('central-conflict-highlight', 2, 2),
      directive('archetype-track', 3, 3, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
      directive('terminal-result-highlight', 4, 4, { kind: 'terminal' })
    ]);
    const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(4, { kind: 'terminal', result: 'white-wins' }));
    expect(moments.map((m) => m.kind)).toEqual([
      'threat-refutation-arrow',
      'central-conflict-highlight',
      'archetype-track',
      'terminal-result-highlight'
    ]);
    expect(moments.map((m) => m.label)).toEqual(['Threat Refutation', 'Climax', 'King Hunt', 'Checkmate']);
  });

  it('C: deterministic chronological ordering, byte-identical across calls', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600]);
    const plan = cinematicPlan([
      directive('terminal-result-highlight', 4, 4, { kind: 'terminal' }),
      directive('threat-refutation-arrow', 1, 1)
    ]);
    const analysis = analysisEndingWith(4, { kind: 'terminal', result: 'black-wins' });
    const first = deriveCinematicMoments(plan, timeline, analysis);
    const second = deriveCinematicMoments(plan, timeline, analysis);
    expect(first).toEqual(second);
    expect(first.map((m) => m.fromPly)).toEqual([1, 4]);
  });

  it('D: target timestamp is strictly inside [atMs, untilMs)', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
    const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS);
    expect(moment!.atMs).toBe(600);
    expect(moment!.untilMs).toBe(1200);
    expect(moment!.targetTimeMs).toBe(1199);
    expect(moment!.atMs <= moment!.targetTimeMs).toBe(true);
    expect(moment!.targetTimeMs < moment!.untilMs).toBe(true);
  });

  it('E: terminal moment target is strictly less than scene.durationMs', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    expect(timeline.scenes[0]!.durationMs).toBe(1800);
    const plan = cinematicPlan([directive('terminal-result-highlight', 3, 3, { kind: 'terminal' })]);
    const analysis = analysisEndingWith(3, { kind: 'terminal', result: 'draw', drawReason: 'stalemate' });
    const [moment] = deriveCinematicMoments(plan, timeline, analysis);
    expect(moment!.untilMs).toBe(timeline.scenes[0]!.durationMs);
    expect(moment!.targetTimeMs).toBeLessThan(timeline.scenes[0]!.durationMs);
    expect(moment!.targetTimeMs).toBe(1799);
    expect(moment!.label).toBe('Stalemate');
  });

  it('F: overlapping directives merge into one moment', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600, 600]);
    const plan = cinematicPlan([
      directive('archetype-track', 2, 4, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
      directive('central-conflict-highlight', 3, 5)
    ]);
    const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(5, { kind: 'cp', cp: 0 }));
    expect(moments).toHaveLength(1);
    expect(moments[0]!.fromPly).toBe(2);
    expect(moments[0]!.toPly).toBe(5);
    // archetype-track (3) outranks central-conflict-highlight (2) in KIND_PRIORITY.
    expect(moments[0]!.kind).toBe('archetype-track');
    expect(moments[0]!.label).toBe('King Hunt');
  });

  it('G: non-overlapping directives remain separate', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 1, 1), directive('archetype-track', 4, 5, { kind: 'archetypeSignal', archetype: 'pawn-journey' })]);
    const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(5, { kind: 'cp', cp: 0 }));
    expect(moments).toHaveLength(2);
    expect(moments.map((m) => [m.fromPly, m.toPly])).toEqual([
      [1, 1],
      [4, 5]
    ]);
  });

  it('H: KIND_ORDER priority is respected for the merged label (terminal-result-highlight wins over central-conflict-highlight)', () => {
    const timeline = timelineFromDurations([600, 600]);
    const plan = cinematicPlan([directive('central-conflict-highlight', 1, 2), directive('terminal-result-highlight', 2, 2, { kind: 'terminal' })]);
    const analysis = analysisEndingWith(2, { kind: 'terminal', result: 'white-wins' });
    const moments = deriveCinematicMoments(plan, timeline, analysis);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.kind).toBe('terminal-result-highlight');
    expect(moments[0]!.label).toBe('Checkmate');
  });

  it('I: no moment-worthy directives produces an empty array', () => {
    const timeline = timelineFromDurations([600]);
    expect(deriveCinematicMoments(cinematicPlan([]), timeline, QUIET_ANALYSIS)).toEqual([]);
    expect(deriveCinematicMoments(cinematicPlan([directive('last-move', 1, 1)]), timeline, QUIET_ANALYSIS)).toEqual([]);
  });

  it('safely omits a moment whose window is empty (a zero-duration/pruned ply)', () => {
    const timeline = timelineFromDurations([600, 0, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
    expect(deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS)).toEqual([]);
  });

  it('safely omits a moment referencing a ply with no corresponding MoveBeat', () => {
    const timeline = timelineFromDurations([600, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 99, 99)]);
    expect(deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS)).toEqual([]);
  });

  it('labels a non-stalemate draw generically, and a decisive result as Checkmate', () => {
    const timeline = timelineFromDurations([600]);
    const plan = cinematicPlan([directive('terminal-result-highlight', 1, 1, { kind: 'terminal' })]);
    const draw = deriveCinematicMoments(plan, timeline, analysisEndingWith(1, { kind: 'terminal', result: 'draw' }));
    expect(draw[0]!.label).toBe('Draw');
    const mate = deriveCinematicMoments(plan, timeline, analysisEndingWith(1, { kind: 'terminal', result: 'black-wins' }));
    expect(mate[0]!.label).toBe('Checkmate');
  });
});

/** A store with a real (if trivial) loaded game, so seekTo's own scene-duration clamp is exercised. */
function storeWithTimeline(timeline: Timeline): Store<AppState> {
  const store = new Store<AppState>(createInitialState());
  const parsed = parsePgn('1. e4 e5 2. Nf3 Nc6', new ChessJsEngine());
  if (!parsed.ok) throw new Error('fixture PGN failed to parse');
  store.setState((s) => ({
    ...s,
    game: { gameRecord: parsed.value, timeline },
    playback: { ...s.playback, activeSceneId: timeline.scenes[0]!.id, logicalTimeMs: 0 }
  }));
  return store;
}

describe('goToNextMoment / goToPreviousMoment', () => {
  const timeline = timelineFromDurations([600, 600, 600, 600, 600]);
  const plan = cinematicPlan([
    directive('threat-refutation-arrow', 1, 1),
    directive('central-conflict-highlight', 3, 3),
    directive('terminal-result-highlight', 5, 5, { kind: 'terminal' })
  ]);
  const analysis = analysisEndingWith(5, { kind: 'terminal', result: 'white-wins' });

  function moments() {
    return deriveCinematicMoments(plan, timeline, analysis);
  }

  it('J: Next Moment from before the first moment lands on the first moment', () => {
    const store = storeWithTimeline(timeline);
    goToNextMoment(store, moments());
    expect(store.getState().playback.logicalTimeMs).toBe(moments()[0]!.targetTimeMs);
  });

  it('J: Previous Moment from the very end lands on the last moment', () => {
    const store = storeWithTimeline(timeline);
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: timeline.scenes[0]!.durationMs } }));
    goToPreviousMoment(store, moments());
    expect(store.getState().playback.logicalTimeMs).toBe(moments()[2]!.targetTimeMs);
  });

  it('K: Next Moment then Previous Moment returns to the original moment', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: all[0]!.targetTimeMs } }));
    goToNextMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[1]!.targetTimeMs);
    goToPreviousMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[0]!.targetTimeMs);
  });

  it('L: repeated Next Moment at the final moment does not escape it', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: all[2]!.targetTimeMs } }));
    goToNextMoment(store, all);
    goToNextMoment(store, all);
    goToNextMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[2]!.targetTimeMs);
  });

  it('M: repeated Previous Moment at the first moment does not escape it', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: all[0]!.targetTimeMs } }));
    goToPreviousMoment(store, all);
    goToPreviousMoment(store, all);
    goToPreviousMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[0]!.targetTimeMs);
  });

  it('pauses playback when navigating between moments', () => {
    const store = storeWithTimeline(timeline);
    store.setState((s) => ({ ...s, playback: { ...s.playback, playing: true } }));
    goToNextMoment(store, moments());
    expect(store.getState().playback.playing).toBe(false);
  });

  it('the terminal moment target never equals scene.durationMs, so ordinary Next Move overshoot behavior is unaffected by this module', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    const terminal = all[all.length - 1]!;
    expect(terminal.targetTimeMs).not.toBe(timeline.scenes[0]!.durationMs);
    expect(terminal.targetTimeMs).toBeLessThan(timeline.scenes[0]!.durationMs);
  });
});
