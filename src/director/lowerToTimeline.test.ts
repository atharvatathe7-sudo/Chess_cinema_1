import { describe, expect, it } from 'vitest';
import { assertValidTimeline } from '../timeline/invariants';
import type { MoveBeat } from '../timeline/types';
import { resolveCamera } from '../render/resolveCamera';
import { boundsOfSquares } from '../render/coords';
import { pieceIdFor } from '../pgn/pieceId';
import type { CameraDirective, CinematicPlan, TacticalAnnotationDirective, TrackingDirective } from './types';
import { buildCinematicPlan } from './buildCinematicPlan';
import { buildCameraPlan, lowerToTimeline, TERMINAL_ZOOM_IN_MS, TERMINAL_ZOOM_OUT_MS } from './lowerToTimeline';
import { zoomForSquares } from './camera';
import { gameFromMoves, moveRecord, prunedPlyScenario, quietGameScenario, richMateEndingScenario, storyPlanFrom, windowedMomentScenario, zeroMoveScenario } from './directorFixtures';
import { centralConflict, consequenceChain } from '../story/storyFixtures';
import type { StoryPlan } from '../story/types';
import { DEFAULT_DIRECTOR_SETTINGS } from './types';

/** Mirrors lowerToTimeline.ts's own private centerOfSquares exactly, for computing expected values from production geometry rather than hardcoding them. */
function expectedCenter(squares: readonly string[]): { centerX: number; centerY: number } {
  const bounds = boundsOfSquares(squares)!;
  return { centerX: (bounds.minX + bounds.maxX) / 2, centerY: (bounds.minY + bounds.maxY) / 2 };
}

function moveBeats(timeline: ReturnType<typeof lowerToTimeline>): MoveBeat[] {
  return timeline.scenes[0]!.beats.filter((b): b is MoveBeat => b.kind === 'move');
}

describe('lowerToTimeline', () => {
  it('passes assertValidTimeline with zero violations for a rich, multi-beat plan', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('passes assertValidTimeline for a quiet game', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('produces a valid, static, zero-duration Scene for a zero-move game', () => {
    const { game, analysis, understanding, story } = zeroMoveScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    expect(timeline.scenes).toHaveLength(1);
    expect(timeline.scenes[0]!.beats).toEqual([]);
    expect(timeline.scenes[0]!.durationMs).toBe(0);
    expect(timeline.scenes[0]!.startPositionFen).toBe(game.positions[0]!.fen);
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('genuinely exercises a pruned ply through the real pipeline: pacing decision -> lowerToTimeline -> zero-duration MoveBeat -> subsequent position progression -> timeline validation', () => {
    const { game, analysis, understanding, story } = prunedPlyScenario();

    // Precondition: the REAL classifyMoveTreatment() (story/retention.ts),
    // not a hand-faked value, actually labels ply 2 'pruned' in this
    // fixture. If this ever stops holding, the fixture — not the
    // assertions below — needs revisiting.
    const treatmentByPly = new Map(story.moveTreatment.map((t) => [t.ply, t.treatment]));
    expect(treatmentByPly.get(1)).toBe('theory');
    expect(treatmentByPly.get(2)).toBe('pruned');
    expect(treatmentByPly.get(3)).toBe('compressible');

    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const prunedEntry = plan.moveTreatmentPlan.find((t) => t.ply === 2);
    expect(prunedEntry).toEqual({ ply: 2, pacing: 'skipped', durationMultiplier: 0 });

    const timeline = lowerToTimeline(game, plan, story);
    const beats = moveBeats(timeline).sort((a, b) => a.atMs - b.atMs);
    expect(beats).toHaveLength(3);

    // 1 & 2: the pruned ply's own MoveBeat exists and has durationMs exactly 0.
    const prunedBeat = beats.find((b) => b.resultingPly === 2);
    expect(prunedBeat).toBeDefined();
    expect(prunedBeat!.durationMs).toBe(0);

    // 3: resultingPly is correct for every beat, in order — nothing was
    // dropped, duplicated, or reassigned to the wrong ply by collapsing
    // ply 2's duration to zero.
    expect(beats.map((b) => b.resultingPly)).toEqual([1, 2, 3]);

    // 4: the FOLLOWING move (ply 3) still advances to the correct position:
    // its own atMs starts exactly where the zero-width ply-2 window ended
    // (not before it, not skipped over, not colliding with it), and it
    // carries its own real destination square/piece — proving the chess
    // position genuinely progresses past the collapsed ply rather than
    // silently freezing or losing the move.
    const ply1Beat = beats.find((b) => b.resultingPly === 1)!;
    const ply3Beat = beats.find((b) => b.resultingPly === 3)!;
    expect(prunedBeat!.atMs).toBe(ply1Beat.atMs + ply1Beat.durationMs);
    expect(ply3Beat.atMs).toBe(prunedBeat!.atMs + prunedBeat!.durationMs); // = prunedBeat.atMs, since duration is 0
    expect(ply3Beat.to).toBe('f3');
    expect(ply3Beat.san).toBe('Nf3');

    // Exact duration math for every beat (base 600ms, no beats/transitions in this fixture):
    expect(ply1Beat.durationMs).toBe(Math.round(600 * DEFAULT_DIRECTOR_SETTINGS.theoryMultiplier)); // 150
    expect(prunedBeat!.durationMs).toBe(0);
    expect(ply3Beat.durationMs).toBe(Math.round(600 * DEFAULT_DIRECTOR_SETTINGS.compressedMultiplier)); // 300

    // 5: beat ordering remains valid — atMs is non-decreasing across the
    // whole sequence, including straight through the zero-width beat.
    for (let i = 1; i < beats.length; i++) {
      expect(beats[i]!.atMs).toBeGreaterThanOrEqual(beats[i - 1]!.atMs);
    }

    // 6: Scene.durationMs is mathematically exact: 150 + 0 + 300 = 450.
    expect(timeline.scenes[0]!.durationMs).toBe(450);

    // 7: the real invariant gate passes with zero violations.
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('realizes a beat-boundary pause as a plain gap between beats, not a new Beat kind', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    const beats = moveBeats(timeline).sort((a, b) => a.atMs - b.atMs);

    expect(plan.transitionDirectives.length).toBeGreaterThan(0);
    for (const transition of plan.transitionDirectives) {
      const beatAtBoundary = beats.find((b) => b.resultingPly === transition.beforePly);
      const previousBeat = beats.find((b) => b.resultingPly === transition.beforePly - 1);
      expect(beatAtBoundary).toBeDefined();
      expect(previousBeat).toBeDefined();
      const gap = beatAtBoundary!.atMs - (previousBeat!.atMs + previousBeat!.durationMs);
      expect(gap).toBeGreaterThanOrEqual(transition.pauseMs);
    }
    // Every beat is still exactly a MoveBeat or AnnotationBeat — no third kind exists.
    for (const beat of timeline.scenes[0]!.beats) {
      expect(['move', 'annotation']).toContain(beat.kind);
    }
  });

  it('computes total scene duration as the sum of per-ply durations plus transition pauses', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    const beats = moveBeats(timeline);

    const sumDurations = plan.moveTreatmentPlan.reduce(
      (sum, t) => sum + Math.round(DEFAULT_DIRECTOR_SETTINGS.baseMoveDurationMs * t.durationMultiplier),
      0
    );
    // Two beats sharing the same ply (climax + resolution, in this fixture)
    // produce two TransitionDirectives with the same beforePly — only one
    // pause is ever actually inserted before that single ply, so the
    // expected total dedupes by beforePly the same way lowerToTimeline does.
    const pauseByPly = new Map(plan.transitionDirectives.map((t) => [t.beforePly, t.pauseMs]));
    const sumPauses = [...pauseByPly.values()].reduce((sum, p) => sum + p, 0);
    expect(timeline.scenes[0]!.durationMs).toBe(sumDurations + sumPauses);
    expect(Math.max(...beats.map((b) => b.atMs + b.durationMs))).toBeLessThanOrEqual(timeline.scenes[0]!.durationMs);
  });

  it('is deterministic: two calls on the same CinematicPlan match byte-for-byte', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const first = lowerToTimeline(game, plan, story);
    const second = lowerToTimeline(game, plan, story);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it('produces a camera plan with a single static full-board keyframe when there is no climax beat', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    expect(timeline.scenes[0]!.cameraPlan.keyframes).toEqual([{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }]);
  });

  it('produces a camera plan anchored on the climax ply, using the critical directive\'s own geometry-derived zoom', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    const keyframes = timeline.scenes[0]!.cameraPlan.keyframes;
    // Phase 18B — zoom is now derived per-directive from real geometry
    // (director/camera.ts's zoomForSquares), not a fixed climaxZoom
    // constant; the critical directive's own computed zoom, at its own
    // atPly's own MoveBeat time, is the ground truth to look for here.
    const critical = plan.cameraDirectives.find((d) => d.role === 'critical');
    expect(critical).toBeDefined();
    const climaxAtMs = timeline.scenes[0]!.beats.find((b) => b.kind === 'move' && b.resultingPly === critical!.atPly)?.atMs;
    expect(climaxAtMs).toBeDefined();

    expect(keyframes.length).toBeGreaterThanOrEqual(4);
    expect(keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });
    expect(keyframes.some((k) => k.atMs === climaxAtMs && k.zoom === critical!.zoom)).toBe(true);
    expect(keyframes[keyframes.length - 1]).toEqual({
      atMs: timeline.scenes[0]!.durationMs,
      centerX: 4,
      centerY: 4,
      zoom: 1
    });
  });

  it('threads preClimaxRampMs through the real buildCinematicPlan -> lowerToTimeline pipeline correctly', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    const keyframes = timeline.scenes[0]!.cameraPlan.keyframes;
    const critical = plan.cameraDirectives.find((d) => d.role === 'critical');
    expect(critical).toBeDefined();
    const climaxAtMs = timeline.scenes[0]!.beats.find((b) => b.kind === 'move' && b.resultingPly === critical!.atPly)?.atMs;
    expect(climaxAtMs).toBeDefined();
    // Phase 18B — the ramp's own baseline is whatever keyframe already
    // precedes the critical directive (the base keyframe when nothing does,
    // or an earlier 'establish' directive's own hold-end otherwise), not
    // always 0.
    const priorKeyframeAtMs = Math.max(0, ...keyframes.filter((k) => k.atMs < climaxAtMs!).map((k) => k.atMs));
    const rampStartMs = Math.max(priorKeyframeAtMs, climaxAtMs! - DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs);
    if (rampStartMs > priorKeyframeAtMs) {
      expect(keyframes.some((k) => k.atMs === rampStartMs && k.zoom === 1 && k.centerX === 4 && k.centerY === 4)).toBe(true);
    } else {
      // Short-gap case: the prior keyframe already covers this — no separate ramp-start keyframe is needed or inserted.
      expect(keyframes.filter((k) => k.zoom === 1 && k.atMs > priorKeyframeAtMs && k.atMs < climaxAtMs!)).toHaveLength(0);
    }
  });
});

/**
 * Phase 12B — direct unit coverage for buildCameraPlan's own pre-climax
 * ramp logic, using hand-crafted inputs (including the real Scholar's
 * Mate/Evergreen atMs/durationMs/sceneDurationMs values established in the
 * Phase 12 investigation) so exact keyframe values can be pinned precisely,
 * independent of any fixture's own particular climax timing.
 */
describe('buildCameraPlan — Phase 12B pre-climax ramp', () => {
  // Phase 18B — zoom is now carried on the directive itself (see
  // director/camera.ts's zoomForSquares), not read from settings; 1.8 is
  // kept here only as this suite's own fixed test value, matching the old
  // climaxZoom exactly so every pre-existing keyframe assertion below stays
  // numerically valid.
  const CLIMAX_ZOOM = 1.8;
  const RAMP_MS = DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs;

  // 'e4'/'e5' share a file, so their bounding-box midpoint (Phase 18B) is
  // identical to the old average-of-centers value (4.5, 4) — every
  // hardcoded centerX/centerY below is unaffected by that change.
  function singleDirective(atPly: number): readonly CameraDirective[] {
    return [{ atPly, untilPly: atPly, role: 'critical', zoom: CLIMAX_ZOOM, squares: ['e4', 'e5'], evidenceRef: { kind: 'beat', id: 'beat-test' } }];
  }

  it('DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs defaults to 1200', () => {
    expect(DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs).toBe(1200);
  });

  it("short-gap (Scholar's-Mate-shaped: climaxAtMs=1200, the real game's own value): no ramp-start keyframe is inserted, and the plan is byte-identical to the pre-Phase-12B 4-keyframe shape", () => {
    const climaxAtMs = 1200; // Scholar's Mate's own real climax atMs
    const durationMs = 2100; // Scholar's Mate's own real climax ply duration
    const sceneDurationMs = 3600; // Scholar's Mate's own real scene duration
    const plyAtMs = new Map([[6, climaxAtMs]]);
    const plyDurationMs = new Map([[6, durationMs]]);

    const plan = buildCameraPlan(singleDirective(6), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, null);

    expect(plan.keyframes).toHaveLength(4);
    expect(plan.keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });
    expect(plan.keyframes[1]!.atMs).toBe(climaxAtMs);
    expect(plan.keyframes[1]!.zoom).toBe(CLIMAX_ZOOM);
    expect(plan.keyframes[2]).toEqual({ ...plan.keyframes[1]!, atMs: climaxAtMs + durationMs });
    expect(plan.keyframes[3]).toEqual({ atMs: sceneDurationMs, centerX: 4, centerY: 4, zoom: 1 });
  });

  it('long-gap (Evergreen-shaped: climaxAtMs=12850, the real game\'s own value): exactly one ramp-start keyframe is inserted at climaxAtMs - preClimaxRampMs, and every existing keyframe keeps its exact pre-Phase-12B value', () => {
    const climaxAtMs = 12850; // Evergreen's own real climax atMs
    const durationMs = 2100; // Evergreen's own real climax ply duration
    const sceneDurationMs = 17050; // Evergreen's own real scene duration
    const plyAtMs = new Map([[40, climaxAtMs]]);
    const plyDurationMs = new Map([[40, durationMs]]);

    const plan = buildCameraPlan(singleDirective(40), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, null);

    expect(plan.keyframes).toHaveLength(5);
    expect(plan.keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });

    // The new ramp-start keyframe: exactly climaxAtMs - preClimaxRampMs, full-board framing.
    expect(plan.keyframes[1]).toEqual({ atMs: climaxAtMs - RAMP_MS, centerX: 4, centerY: 4, zoom: 1 });

    // Existing climax-start keyframe unchanged.
    expect(plan.keyframes[2]!.atMs).toBe(climaxAtMs);
    expect(plan.keyframes[2]!.zoom).toBe(CLIMAX_ZOOM);

    // Existing climax-hold keyframe unchanged.
    expect(plan.keyframes[3]).toEqual({ ...plan.keyframes[2]!, atMs: climaxAtMs + durationMs });

    // Existing final reset keyframe unchanged.
    expect(plan.keyframes[4]).toEqual({ atMs: sceneDurationMs, centerX: 4, centerY: 4, zoom: 1 });
  });

  it('does not create a duplicate/degenerate keyframe when rampStartMs computes to exactly 0', () => {
    const climaxAtMs = RAMP_MS; // climaxAtMs - preClimaxRampMs === 0 exactly
    const plyAtMs = new Map([[6, climaxAtMs]]);
    const plyDurationMs = new Map([[6, 300]]);
    const plan = buildCameraPlan(singleDirective(6), plyAtMs, plyDurationMs, climaxAtMs + 300, RAMP_MS, null);
    expect(plan.keyframes.filter((k) => k.atMs === 0)).toHaveLength(1);
    expect(plan.keyframes).toHaveLength(4);
  });

  it('the camera trajectory remains at zoom=1 for every time before the ramp-start keyframe', () => {
    const climaxAtMs = 12850;
    const plyAtMs = new Map([[40, climaxAtMs]]);
    const plyDurationMs = new Map([[40, 2100]]);
    const plan = buildCameraPlan(singleDirective(40), plyAtMs, plyDurationMs, 17050, RAMP_MS, null);
    const rampStartMs = climaxAtMs - RAMP_MS;

    for (const t of [0, 1000, rampStartMs / 2, rampStartMs - 1]) {
      expect(resolveCamera(plan, t).zoom).toBe(1);
    }
  });

  it('camera zoom begins increasing only inside the final preClimaxRampMs before the climax, and reaches exactly climaxZoom at the climax itself', () => {
    const climaxAtMs = 12850;
    const plyAtMs = new Map([[40, climaxAtMs]]);
    const plyDurationMs = new Map([[40, 2100]]);
    const plan = buildCameraPlan(singleDirective(40), plyAtMs, plyDurationMs, 17050, RAMP_MS, null);
    const rampStartMs = climaxAtMs - RAMP_MS;

    expect(resolveCamera(plan, rampStartMs).zoom).toBe(1);
    expect(resolveCamera(plan, rampStartMs + 1).zoom).toBeGreaterThan(1);
    expect(resolveCamera(plan, climaxAtMs).zoom).toBe(CLIMAX_ZOOM);
  });
});

/**
 * Phase 13B — direct unit coverage for buildCameraPlan's own terminal
 * payoff re-engagement logic, using hand-crafted inputs mirroring the real
 * Scholar's Mate/Evergreen/Stalemate/Promotion race atMs/durationMs/
 * sceneDurationMs/terminal-ply values established in the Phase 13/13A
 * investigation and design report, so exact keyframe values can be pinned
 * precisely, independent of any fixture's own particular timing.
 */
describe('buildCameraPlan — Phase 13B terminal payoff', () => {
  const CLIMAX_ZOOM = 1.8;
  const RAMP_MS = DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs;

  function singleDirective(atPly: number): readonly CameraDirective[] {
    return [{ atPly, untilPly: atPly, role: 'critical', zoom: CLIMAX_ZOOM, squares: ['e4', 'e5'], evidenceRef: { kind: 'beat', id: 'beat-test' } }];
  }

  function assertAscending(keyframes: readonly { atMs: number }[]): void {
    for (let i = 1; i < keyframes.length; i++) {
      expect(keyframes[i]!.atMs, `keyframe ${i} (${keyframes[i]!.atMs}) must be > keyframe ${i - 1} (${keyframes[i - 1]!.atMs})`).toBeGreaterThan(
        keyframes[i - 1]!.atMs
      );
    }
  }

  it('TERMINAL_ZOOM_OUT_MS/TERMINAL_ZOOM_IN_MS are the approved, independent constants (200/400), not coupled to DEFAULT_DIRECTOR_SETTINGS', () => {
    expect(TERMINAL_ZOOM_OUT_MS).toBe(200);
    expect(TERMINAL_ZOOM_IN_MS).toBe(400);
  });

  it("Scholar's-Mate-shaped zero-gap case (climaxAtMs=1200, terminal ply begins exactly at the natural hold-end=3300): the SAME hold-end keyframe is extended to sceneDurationMs-TERMINAL_ZOOM_OUT_MS, with no separate re-engagement episode", () => {
    const climaxAtMs = 1200;
    const durationMs = 2100;
    const sceneDurationMs = 3600;
    const terminalPlyAtMs = 3300; // == climaxAtMs + durationMs, the real zero-gap case
    const plyAtMs = new Map([[6, climaxAtMs]]);
    const plyDurationMs = new Map([[6, durationMs]]);

    const plan = buildCameraPlan(singleDirective(6), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, terminalPlyAtMs);

    expect(plan.keyframes).toEqual([
      { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 1200, centerX: 4.5, centerY: 4, zoom: CLIMAX_ZOOM },
      { atMs: 3400, centerX: 4.5, centerY: 4, zoom: CLIMAX_ZOOM },
      { atMs: 3600, centerX: 4, centerY: 4, zoom: 1 }
    ]);
    assertAscending(plan.keyframes);
  });

  it('Evergreen-shaped gap case (climaxAtMs=12850, terminal ply begins at 16750, well after the natural hold-end=14950): the existing climax hold is left unchanged, and a short re-engagement episode is inserted around the terminal move', () => {
    const climaxAtMs = 12850;
    const durationMs = 2100;
    const sceneDurationMs = 17050;
    const terminalPlyAtMs = 16750;
    const plyAtMs = new Map([[40, climaxAtMs]]);
    const plyDurationMs = new Map([[40, durationMs]]);

    const plan = buildCameraPlan(singleDirective(40), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, terminalPlyAtMs);

    const center = { centerX: 4.5, centerY: 4 }; // squareCenter('e4')/squareCenter('e5') averaged — see singleDirective
    expect(plan.keyframes).toEqual([
      { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 11650, centerX: 4, centerY: 4, zoom: 1 }, // Phase 12B ramp-start, unchanged
      { atMs: 12850, ...center, zoom: CLIMAX_ZOOM }, // existing climax-start, unchanged
      { atMs: 14950, ...center, zoom: CLIMAX_ZOOM }, // existing climax-hold-end, unchanged
      { atMs: 16350, ...center, zoom: 1 }, // NEW: re-engagement reset (16750 - TERMINAL_ZOOM_IN_MS)
      { atMs: 16750, ...center, zoom: CLIMAX_ZOOM }, // NEW: re-zoom completes as terminal ply begins
      { atMs: 16850, ...center, zoom: CLIMAX_ZOOM }, // NEW: hold-end (sceneDurationMs - TERMINAL_ZOOM_OUT_MS)
      { atMs: 17050, centerX: 4, centerY: 4, zoom: 1 } // existing final reset, unchanged
    ]);
    assertAscending(plan.keyframes);
  });

  it('Stalemate-shaped gap case (climaxAtMs=5600, terminal ply begins at 9500, well after the natural hold-end=7700): same re-engagement shape as Evergreen, different numbers', () => {
    const climaxAtMs = 5600;
    const durationMs = 2100;
    const sceneDurationMs = 9800;
    const terminalPlyAtMs = 9500;
    const plyAtMs = new Map([[12, climaxAtMs]]);
    const plyDurationMs = new Map([[12, durationMs]]);

    const plan = buildCameraPlan(singleDirective(12), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, terminalPlyAtMs);

    const center = { centerX: 4.5, centerY: 4 }; // squareCenter('e4')/squareCenter('e5') averaged — see singleDirective
    expect(plan.keyframes).toEqual([
      { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 4400, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 5600, ...center, zoom: CLIMAX_ZOOM },
      { atMs: 7700, ...center, zoom: CLIMAX_ZOOM },
      { atMs: 9100, ...center, zoom: 1 },
      { atMs: 9500, ...center, zoom: CLIMAX_ZOOM },
      { atMs: 9600, ...center, zoom: CLIMAX_ZOOM },
      { atMs: 9800, centerX: 4, centerY: 4, zoom: 1 }
    ]);
    assertAscending(plan.keyframes);
  });

  it('Promotion-race-shaped non-terminal case (terminalPlyAtMs=null): byte-identical to the pre-Phase-13B/pre-existing Phase 12B shape — no terminal re-engagement is ever inserted', () => {
    const climaxAtMs = 3100;
    const durationMs = 2100;
    const sceneDurationMs = 5800;
    const plyAtMs = new Map([[8, climaxAtMs]]);
    const plyDurationMs = new Map([[8, durationMs]]);

    const plan = buildCameraPlan(singleDirective(8), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, null);

    expect(plan.keyframes).toEqual([
      { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 1900, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 3100, centerX: 4.5, centerY: 4, zoom: CLIMAX_ZOOM },
      { atMs: 5200, centerX: 4.5, centerY: 4, zoom: CLIMAX_ZOOM },
      { atMs: 5800, centerX: 4, centerY: 4, zoom: 1 }
    ]);
  });

  it('Quiet-shaped case (no camera directive at all): remains the single static full-board keyframe regardless of terminalPlyAtMs', () => {
    const plyAtMs = new Map<number, number>();
    const plyDurationMs = new Map<number, number>();
    const plan = buildCameraPlan([], plyAtMs, plyDurationMs, 2550, RAMP_MS, 2250);
    expect(plan.keyframes).toEqual([{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }]);
  });

  it('Phase 12A freeze-anchor preservation: resolveCamera(plan, sceneDurationMs - 1) resolves to zoom=1/center=(4,4) within 1e-6, for all three terminal shapes', () => {
    const cases = [
      { climaxAtMs: 1200, durationMs: 2100, sceneDurationMs: 3600, terminalPlyAtMs: 3300, ply: 6 },
      { climaxAtMs: 12850, durationMs: 2100, sceneDurationMs: 17050, terminalPlyAtMs: 16750, ply: 40 },
      { climaxAtMs: 5600, durationMs: 2100, sceneDurationMs: 9800, terminalPlyAtMs: 9500, ply: 12 }
    ];
    for (const c of cases) {
      const plyAtMs = new Map([[c.ply, c.climaxAtMs]]);
      const plyDurationMs = new Map([[c.ply, c.durationMs]]);
      const plan = buildCameraPlan(singleDirective(c.ply), plyAtMs, plyDurationMs, c.sceneDurationMs, RAMP_MS, c.terminalPlyAtMs);
      const cam = resolveCamera(plan, c.sceneDurationMs - 1);
      expect(Math.abs(cam.zoom - 1), `sceneDurationMs=${c.sceneDurationMs}: zoom`).toBeLessThan(1e-6);
      expect(Math.abs(cam.centerX - 4), `sceneDurationMs=${c.sceneDurationMs}: centerX`).toBeLessThan(1e-6);
      expect(Math.abs(cam.centerY - 4), `sceneDurationMs=${c.sceneDurationMs}: centerY`).toBeLessThan(1e-6);
    }
  });

  it('camera remains meaningfully zoomed (> 1.5) for a real portion of the terminal ply, for all three terminal shapes', () => {
    const cases = [
      { climaxAtMs: 1200, durationMs: 2100, sceneDurationMs: 3600, terminalPlyAtMs: 3300, ply: 6 },
      { climaxAtMs: 12850, durationMs: 2100, sceneDurationMs: 17050, terminalPlyAtMs: 16750, ply: 40 },
      { climaxAtMs: 5600, durationMs: 2100, sceneDurationMs: 9800, terminalPlyAtMs: 9500, ply: 12 }
    ];
    for (const c of cases) {
      const plyAtMs = new Map([[c.ply, c.climaxAtMs]]);
      const plyDurationMs = new Map([[c.ply, c.durationMs]]);
      const plan = buildCameraPlan(singleDirective(c.ply), plyAtMs, plyDurationMs, c.sceneDurationMs, RAMP_MS, c.terminalPlyAtMs);
      // Right at the terminal ply's own start, the camera must already be at full climaxZoom.
      expect(resolveCamera(plan, c.terminalPlyAtMs).zoom).toBe(CLIMAX_ZOOM);
      // And it must still be meaningfully zoomed 50ms into the terminal move.
      expect(resolveCamera(plan, c.terminalPlyAtMs + 50).zoom).toBeGreaterThan(1.5);
    }
  });

  it('small-gap edge case (gap between climax hold-end and terminal ply smaller than TERMINAL_ZOOM_IN_MS): no duplicate/conflicting-zoom keyframe is produced, and the camera simply stays held through the short gap', () => {
    const climaxAtMs = 1200;
    const durationMs = 2100; // natural hold-end = 3300
    const terminalPlyAtMs = 3500; // only 200ms gap, less than TERMINAL_ZOOM_IN_MS (400)
    const sceneDurationMs = 3800;
    const plyAtMs = new Map([[6, climaxAtMs]]);
    const plyDurationMs = new Map([[6, durationMs]]);

    const plan = buildCameraPlan(singleDirective(6), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, terminalPlyAtMs);

    assertAscending(plan.keyframes);
    // No keyframe pair shares an atMs.
    const seen = new Set<number>();
    for (const k of plan.keyframes) {
      expect(seen.has(k.atMs), `duplicate atMs=${k.atMs}`).toBe(false);
      seen.add(k.atMs);
    }
    // The camera stays at climaxZoom continuously from the climax hold straight through to the terminal ply.
    expect(resolveCamera(plan, climaxAtMs + durationMs).zoom).toBe(CLIMAX_ZOOM);
    expect(resolveCamera(plan, terminalPlyAtMs).zoom).toBe(CLIMAX_ZOOM);
  });

  it('unusually short terminal-ply-to-sceneDurationMs budget (less than TERMINAL_ZOOM_OUT_MS): falls back to holding through the terminal ply\'s own start rather than producing an out-of-order keyframe', () => {
    const climaxAtMs = 1200;
    const durationMs = 2100; // natural hold-end = 3300
    const terminalPlyAtMs = 5000;
    const sceneDurationMs = 5100; // only 100ms after terminalPlyAtMs, less than TERMINAL_ZOOM_OUT_MS (200)
    const plyAtMs = new Map([[6, climaxAtMs]]);
    const plyDurationMs = new Map([[6, durationMs]]);

    const plan = buildCameraPlan(singleDirective(6), plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, terminalPlyAtMs);

    assertAscending(plan.keyframes);
    expect(plan.keyframes[plan.keyframes.length - 1]).toEqual({ atMs: sceneDurationMs, centerX: 4, centerY: 4, zoom: 1 });
  });
});

/**
 * Phase 18D Batch 1 — buildCameraPlan's own tracking overlay. Every test
 * here hand-builds a TrackingDirective directly (the same style the Phase
 * 12B/13B suites above already use for CameraDirective) rather than going
 * through deriveTrackingDirectives, so lowering's own contract is verified
 * independently of subject-selection — see tracking.test.ts for that.
 */
describe('buildCameraPlan — Phase 18D tracking', () => {
  const SETTINGS = DEFAULT_DIRECTOR_SETTINGS;
  const RAMP_MS = SETTINGS.preClimaxRampMs;

  it('empty trackingDirectives (or omitting the parameter entirely) produces byte-identical output to the pre-Phase-18D signature', () => {
    const directives: CameraDirective[] = [{ atPly: 6, untilPly: 6, role: 'critical', zoom: 1.8, squares: ['e4', 'e5'], evidenceRef: { kind: 'beat', id: 'b' } }];
    const plyAtMs = new Map([[6, 1200]]);
    const plyDurationMs = new Map([[6, 2100]]);

    const omitted = buildCameraPlan(directives, plyAtMs, plyDurationMs, 3600, RAMP_MS, null);
    const explicitEmpty = buildCameraPlan(directives, plyAtMs, plyDurationMs, 3600, RAMP_MS, null, []);
    expect(explicitEmpty).toEqual(omitted);
  });

  it('produces one keyframe per tracked ply, each centered on the subject\'s actual square unioned with that ply\'s own move geometry, within existing zoom limits', () => {
    const blackKing = pieceIdFor('b', 'k', 'e8');
    const attacker = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([
      moveRecord(5, 'w', 'q', 'd1', 'd7', 'Qd7+', { pieceId: attacker }),
      moveRecord(6, 'b', 'k', 'e8', 'f8', 'Kf8'),
      moveRecord(7, 'w', 'q', 'd7', 'd8', 'Qd8+', { pieceId: attacker })
    ]);
    const directives: CameraDirective[] = [{ atPly: 5, untilPly: 7, role: 'consequence', zoom: 1.5, squares: ['a1', 'h8'], evidenceRef: { kind: 'beat', id: 'b' } }];
    const tracking: TrackingDirective[] = [
      { fromPly: 5, toPly: 7, subject: { kind: 'piece', pieceId: blackKing }, role: 'consequence', priority: 0, evidenceRef: { kind: 'king-safety', ply: 5 } }
    ];
    const plyAtMs = new Map([
      [5, 1000],
      [6, 1600],
      [7, 2200]
    ]);
    const plyDurationMs = new Map([
      [5, 600],
      [6, 600],
      [7, 600]
    ]);

    const plan = buildCameraPlan(directives, plyAtMs, plyDurationMs, 3500, RAMP_MS, null, tracking, game, SETTINGS);

    // BASE + 3 tracked points + natural hold-end + final reset.
    expect(plan.keyframes).toHaveLength(6);

    const region5 = ['e8', 'd1', 'd7']; // king untouched this ply (still e8) + the checking move's own from/to
    const region6 = ['f8', 'e8']; // king's own move
    const region7 = ['f8', 'd7', 'd8']; // king untouched this ply (now f8) + the checking move's own from/to

    expect(plan.keyframes[1]).toEqual({ atMs: 1000, ...expectedCenter(region5), zoom: zoomForSquares(region5, SETTINGS) });
    expect(plan.keyframes[2]).toEqual({ atMs: 1600, ...expectedCenter(region6), zoom: zoomForSquares(region6, SETTINGS) });
    expect(plan.keyframes[3]).toEqual({ atMs: 2200, ...expectedCenter(region7), zoom: zoomForSquares(region7, SETTINGS) });

    // Natural hold-end holds at the LAST tracked position, not the directive's own static box.
    expect(plan.keyframes[4]).toEqual({ ...plan.keyframes[3], atMs: 2800 });

    for (const k of plan.keyframes) {
      expect(k.zoom).toBeGreaterThanOrEqual(1);
      expect(k.zoom).toBeLessThanOrEqual(SETTINGS.maxZoom);
    }
  });

  it('a capture ends tracking at that ply and falls back to the directive\'s own static region for the remainder — never a frozen shot of an empty square', () => {
    const knight = pieceIdFor('w', 'n', 'g1');
    const game = gameFromMoves([
      moveRecord(5, 'w', 'n', 'g1', 'f3', 'Nf3', { pieceId: knight }),
      moveRecord(6, 'b', 'p', 'g7', 'g5', 'g5'),
      moveRecord(7, 'b', 'b', 'c8', 'f3', 'Bxf3', { capturedPieceId: knight })
    ]);
    const directives: CameraDirective[] = [{ atPly: 5, untilPly: 7, role: 'consequence', zoom: 1.5, squares: ['f3', 'g1'], evidenceRef: { kind: 'beat', id: 'b' } }];
    const tracking: TrackingDirective[] = [
      { fromPly: 5, toPly: 7, subject: { kind: 'piece', pieceId: knight }, role: 'consequence', priority: 1, evidenceRef: { kind: 'move', ply: 5 } }
    ];
    const plyAtMs = new Map([
      [5, 1000],
      [6, 1300],
      [7, 1600]
    ]);
    const plyDurationMs = new Map([
      [5, 300],
      [6, 300],
      [7, 300]
    ]);

    const plan = buildCameraPlan(directives, plyAtMs, plyDurationMs, 2500, RAMP_MS, null, tracking, game, SETTINGS);

    // Only 2 tracked points (ply 7 is the capture ply — the knight is gone, no third point).
    expect(plan.keyframes).toHaveLength(5);
    expect(plan.keyframes[1]!.atMs).toBe(1000);
    expect(plan.keyframes[2]!.atMs).toBe(1300);

    // Fell back to the directive's OWN static region/zoom — not held at the knight's last square.
    const staticCenter = expectedCenter(['f3', 'g1']);
    expect(plan.keyframes[3]).toEqual({ atMs: 1900, ...staticCenter, zoom: 1.5 });
    expect(plan.keyframes[3]).not.toEqual(plan.keyframes[2]);
    expect(plan.keyframes[4]).toEqual({ atMs: 2500, centerX: 4, centerY: 4, zoom: 1 });
  });

  it('continues tracking the same PieceId across a promotion with no interruption', () => {
    const pawn = pieceIdFor('w', 'p', 'a2'); // real starting square — pieceSquareAtPly validates membership
    const game = gameFromMoves([
      moveRecord(5, 'w', 'p', 'a7', 'a8', 'a8=Q', { pieceId: pawn, promotion: 'q' }),
      moveRecord(6, 'b', 'k', 'e8', 'd8', 'Kd8'),
      moveRecord(7, 'w', 'q', 'a8', 'a2', 'Qa2', { pieceId: pawn })
    ]);
    const directives: CameraDirective[] = [{ atPly: 5, untilPly: 7, role: 'consequence', zoom: 1.5, squares: ['a1', 'h8'], evidenceRef: { kind: 'beat', id: 'b' } }];
    const tracking: TrackingDirective[] = [
      { fromPly: 5, toPly: 7, subject: { kind: 'piece', pieceId: pawn }, role: 'consequence', priority: 1, evidenceRef: { kind: 'move', ply: 5 } }
    ];
    const plyAtMs = new Map([
      [5, 1000],
      [6, 1300],
      [7, 1600]
    ]);
    const plyDurationMs = new Map([
      [5, 300],
      [6, 300],
      [7, 300]
    ]);

    const plan = buildCameraPlan(directives, plyAtMs, plyDurationMs, 2500, RAMP_MS, null, tracking, game, SETTINGS);

    // All 3 plies tracked — promotion never interrupts identity resolution.
    expect(plan.keyframes).toHaveLength(6);
    expect(plan.keyframes[1]!.atMs).toBe(1000);
    expect(plan.keyframes[2]!.atMs).toBe(1300);
    expect(plan.keyframes[3]!.atMs).toBe(1600);
  });

  it('a clip-window boundary reached mid-span truncates tracking exactly like a capture — falls back to the static region, never holds a stale position', () => {
    const attacker = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([
      moveRecord(5, 'w', 'q', 'd1', 'd7', 'Qd7', { pieceId: attacker }),
      moveRecord(6, 'b', 'k', 'e8', 'f8', 'Kf8'),
      moveRecord(7, 'w', 'q', 'd7', 'd8', 'Qd8', { pieceId: attacker })
    ]);
    const directives: CameraDirective[] = [{ atPly: 5, untilPly: 7, role: 'consequence', zoom: 1.5, squares: ['a1', 'h8'], evidenceRef: { kind: 'beat', id: 'b' } }];
    const tracking: TrackingDirective[] = [
      { fromPly: 5, toPly: 7, subject: { kind: 'piece', pieceId: attacker }, role: 'consequence', priority: 1, evidenceRef: { kind: 'move', ply: 5 } }
    ];
    // ply 7 has no plyAtMs entry — simulates a windowed clip ending at ply 6.
    const plyAtMs = new Map([
      [5, 1000],
      [6, 1300]
    ]);
    const plyDurationMs = new Map([
      [5, 300],
      [6, 300]
    ]);

    const plan = buildCameraPlan(directives, plyAtMs, plyDurationMs, 2200, RAMP_MS, null, tracking, game, SETTINGS);

    expect(plan.keyframes).toHaveLength(5);
    // untilPly's own timing is unavailable (ply 7 is outside the window), so
    // buildCameraPlan's own pre-existing fallback bounds the dwell by atPly's
    // own duration alone (1000 + 300) — unrelated to tracking, unchanged here.
    const staticCenter = expectedCenter(['a1', 'h8']);
    expect(plan.keyframes[3]).toEqual({ atMs: 1300, ...staticCenter, zoom: 1.5 });
  });

  it('terminal camera wins: tracking supplies WHERE within its own span, but the terminal re-engagement TIMING and shape are exactly the pre-existing gap-case sequence', () => {
    const queen = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([moveRecord(40, 'w', 'q', 'd1', 'e5', 'Qxe5#', { pieceId: queen })]);
    const directives: CameraDirective[] = [{ atPly: 40, untilPly: 40, role: 'critical', zoom: 1.8, squares: ['e4', 'e5'], evidenceRef: { kind: 'beat', id: 'b' } }];
    const tracking: TrackingDirective[] = [
      { fromPly: 40, toPly: 40, subject: { kind: 'piece', pieceId: queen }, role: 'critical', priority: 1, evidenceRef: { kind: 'move', ply: 40 } }
    ];
    const climaxAtMs = 12850;
    const durationMs = 2100;
    const sceneDurationMs = 17050;
    const terminalPlyAtMs = 16750;
    const plyAtMs = new Map([[40, climaxAtMs]]);
    const plyDurationMs = new Map([[40, durationMs]]);

    const plan = buildCameraPlan(directives, plyAtMs, plyDurationMs, sceneDurationMs, RAMP_MS, terminalPlyAtMs, tracking, game, SETTINGS);

    // Exactly the same atMs sequence as the pre-existing (untracked) Evergreen
    // gap-case test above — terminal timing is completely unaffected by tracking.
    expect(plan.keyframes.map((k) => k.atMs)).toEqual([0, 11650, 12850, 14950, 16350, 16750, 16850, 17050]);

    // The pre-climax ramp (index 1) still lands exactly on the first (and only)
    // tracked keyframe (index 2) — same atMs, and now the TRACKED center/zoom.
    const region = ['e5', 'd1']; // queen's own destination + origin (dedupe of [to, from, to])
    const center = expectedCenter(region);
    const zoom = zoomForSquares(region, SETTINGS);
    expect(plan.keyframes[1]).toEqual({ atMs: 11650, centerX: 4, centerY: 4, zoom: 1 });
    expect(plan.keyframes[2]).toEqual({ atMs: 12850, ...center, zoom });

    // Every subsequent terminal-branch keyframe (hold-end, re-engagement dip,
    // re-zoom, final hold) rests on that SAME tracked position — proving the
    // terminal logic itself is untouched, only fed a different center.
    expect(plan.keyframes[3]).toEqual({ atMs: 14950, ...center, zoom });
    expect(plan.keyframes[4]).toEqual({ atMs: 16350, ...center, zoom: 1 });
    expect(plan.keyframes[5]).toEqual({ atMs: 16750, ...center, zoom });
    expect(plan.keyframes[6]).toEqual({ atMs: 16850, ...center, zoom });
    expect(plan.keyframes[7]).toEqual({ atMs: 17050, centerX: 4, centerY: 4, zoom: 1 });
  });

  it('leaves an unmatched directive\'s static framing completely unchanged when tracking applies only to a different directive', () => {
    const queen = pieceIdFor('w', 'q', 'd1');
    const game = gameFromMoves([
      moveRecord(3, 'w', 'p', 'e2', 'e4', 'e4'),
      moveRecord(6, 'w', 'q', 'd1', 'e5', 'Qxe5', { pieceId: queen })
    ]);
    const establishDirective: CameraDirective = { atPly: 3, untilPly: 3, role: 'establish', zoom: 1.2, squares: ['e2', 'e4'], evidenceRef: { kind: 'beat', id: 'setup' } };
    const criticalDirective: CameraDirective = { atPly: 6, untilPly: 6, role: 'critical', zoom: 1.8, squares: ['d1', 'e5'], evidenceRef: { kind: 'beat', id: 'climax' } };
    const tracking: TrackingDirective[] = [
      { fromPly: 6, toPly: 6, subject: { kind: 'piece', pieceId: queen }, role: 'critical', priority: 1, evidenceRef: { kind: 'move', ply: 6 } }
    ];
    const plyAtMs = new Map([
      [3, 500],
      [6, 4000]
    ]);
    const plyDurationMs = new Map([
      [3, 600],
      [6, 2100]
    ]);

    const plan = buildCameraPlan([establishDirective, criticalDirective], plyAtMs, plyDurationMs, 8000, RAMP_MS, null, tracking, game, SETTINGS);

    // The establish directive is entirely untouched: its own static box.
    const establishCenter = expectedCenter(['e2', 'e4']);
    expect(plan.keyframes[1]).toEqual({ atMs: 500, ...establishCenter, zoom: 1.2 });
    expect(plan.keyframes[2]).toEqual({ atMs: 1100, ...establishCenter, zoom: 1.2 });
  });
});

/**
 * Phase 18E-A — the Phase 18 integration review's confirmed game_12 defect:
 * a tracking-driven camera can crop an active tactical annotation's own
 * geometry, because a tracked ply's region was built only from
 * [subject, move.from, move.to], with no awareness of what tactical
 * annotation was being drawn on that same ply. Fixed by
 * activeTacticalSquares in lowerToTimeline.ts — every test here hand-builds
 * the same shape the real game_12 capture showed (a tracked mover whose own
 * move geometry does not include a defender-loss annotation's second
 * square) and verifies the region now safely contains it.
 */
describe('buildCameraPlan — Phase 18E-A tracking/tactical reconciliation', () => {
  const SETTINGS = DEFAULT_DIRECTOR_SETTINGS;
  const RAMP_MS = SETTINGS.preClimaxRampMs;

  function rookScenario() {
    const rook = pieceIdFor('b', 'r', 'h8');
    const game = gameFromMoves([moveRecord(1, 'b', 'r', 'h8', 'f8', 'Rxf8', { pieceId: rook })]);
    const directive: CameraDirective = { atPly: 1, untilPly: 1, role: 'critical', zoom: 1, squares: ['f8', 'a8'], evidenceRef: { kind: 'beat', id: 'b' } };
    const tracking: TrackingDirective = { fromPly: 1, toPly: 1, subject: { kind: 'piece', pieceId: rook }, role: 'critical', priority: 1, evidenceRef: { kind: 'move', ply: 1 } };
    const plyAtMs = new Map([[1, 1000]]);
    const plyDurationMs = new Map([[1, 300]]);
    return { rook, game, directive, tracking, plyAtMs, plyDurationMs };
  }

  function defenderLoss(fromPly: number, toPly: number, squares: readonly string[]): TacticalAnnotationDirective {
    return { fromPly, toPly, kind: 'defender-loss', role: 'critical', squares, priority: 3, evidenceRef: { kind: 'causal-fact', fact: 'defender-lost', ply: fromPly } };
  }

  it('game_12 reproducer: an active defender-loss arrow whose far endpoint is outside the bare subject+move region is pulled into frame', () => {
    const { game, directive, tracking, plyAtMs, plyDurationMs } = rookScenario();
    const tactical = [defenderLoss(1, 1, ['f8', 'a8'])];

    const plan = buildCameraPlan(
      [directive],
      plyAtMs,
      plyDurationMs,
      2000,
      RAMP_MS,
      null,
      [tracking],
      game,
      SETTINGS,
      tactical
    );

    const region = ['f8', 'h8', 'a8']; // subject square (f8) + move geometry (h8->f8) + the active annotation's own squares
    const expected = expectedCenter(region);
    const expectedZoom = zoomForSquares(region, SETTINGS);
    expect(plan.keyframes[1]).toEqual({ atMs: 1000, ...expected, zoom: expectedZoom });
    // a8 is genuinely inside the resulting box — the whole point of the fix.
    const bounds = boundsOfSquares(region)!;
    expect(bounds.minX).toBeLessThanOrEqual(0); // a8's file
    expect(bounds.minY).toBeLessThanOrEqual(0); // a8's rank
  });

  it('tracking-only case (no active tactical annotation) is completely unchanged from Phase 18D', () => {
    const { game, directive, tracking, plyAtMs, plyDurationMs } = rookScenario();

    const withoutTactical = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS);
    const withEmptyTactical = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS, []);
    expect(withEmptyTactical).toEqual(withoutTactical);

    const region = ['f8', 'h8']; // no tactical geometry active — bare subject+move region, exactly as Phase 18D shipped
    const expected = expectedCenter(region);
    expect(withoutTactical.keyframes[1]).toEqual({ atMs: 1000, ...expected, zoom: zoomForSquares(region, SETTINGS) });
  });

  it('tactical-only case (no tracking directive at all) is completely unchanged — the static path never consults tacticalDirectives', () => {
    const directive: CameraDirective = { atPly: 1, untilPly: 1, role: 'critical', zoom: 1.5, squares: ['f8', 'a8'], evidenceRef: { kind: 'beat', id: 'b' } };
    const plyAtMs = new Map([[1, 1000]]);
    const plyDurationMs = new Map([[1, 300]]);
    const tactical = [defenderLoss(1, 1, ['f8', 'a8'])];

    const withTactical = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [], undefined, undefined, tactical);
    const withoutTactical = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null);
    expect(withTactical).toEqual(withoutTactical);
  });

  it('multiple active tactical annotations on the same tracked ply are all contained', () => {
    const { game, directive, tracking, plyAtMs, plyDurationMs } = rookScenario();
    const tactical = [defenderLoss(1, 1, ['f8', 'a8']), { fromPly: 1, toPly: 1, kind: 'check-marker' as const, role: 'critical' as const, squares: ['h1'], priority: 8, evidenceRef: { kind: 'terminal' as const, ply: 1 } }];

    const plan = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS, tactical);

    const region = ['f8', 'h8', 'a8', 'h1'];
    expect(plan.keyframes[1]).toEqual({ atMs: 1000, ...expectedCenter(region), zoom: zoomForSquares(region, SETTINGS) });
  });

  it('widens rather than crops: including tactical geometry never produces a TIGHTER zoom than the bare subject+move region alone', () => {
    const { game, directive, tracking, plyAtMs, plyDurationMs } = rookScenario();
    const bare = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS);
    const widened = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS, [defenderLoss(1, 1, ['f8', 'a8'])]);

    expect(widened.keyframes[1]!.zoom).toBeLessThanOrEqual(bare.keyframes[1]!.zoom);
  });

  it('zoom stays within DirectorSettings bounds even when the active tactical geometry spans the whole board', () => {
    const { game, directive, tracking, plyAtMs, plyDurationMs } = rookScenario();
    const tactical = [defenderLoss(1, 1, ['a1', 'h8'])]; // a corner-to-corner pair, forcing the widest possible union
    const plan = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS, tactical);

    expect(plan.keyframes[1]!.zoom).toBeGreaterThanOrEqual(1);
    expect(plan.keyframes[1]!.zoom).toBeLessThanOrEqual(SETTINGS.maxZoom);
  });

  it('never fabricates geometry: the resulting region is exactly the union of subject square, move geometry, and active tactical squares — nothing else', () => {
    const { game, directive, tracking, plyAtMs, plyDurationMs } = rookScenario();
    const tactical = [defenderLoss(1, 1, ['f8', 'a8'])];
    const plan = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS, tactical);

    // If any extra, undeclared square had leaked in, the bounding box would
    // differ from this exact hand-computed union.
    const exactUnion = ['f8', 'h8', 'a8'];
    expect(plan.keyframes[1]).toEqual({ atMs: 1000, ...expectedCenter(exactUnion), zoom: zoomForSquares(exactUnion, SETTINGS) });
  });

  it('a tactical annotation active on a DIFFERENT ply than the one being tracked is not pulled in', () => {
    const rook = pieceIdFor('b', 'r', 'h8');
    const game = gameFromMoves([
      moveRecord(1, 'b', 'r', 'h8', 'f8', 'Rxf8', { pieceId: rook }),
      moveRecord(2, 'w', 'k', 'e1', 'e2', 'Ke2')
    ]);
    const directive: CameraDirective = { atPly: 1, untilPly: 1, role: 'critical', zoom: 1, squares: ['f8'], evidenceRef: { kind: 'beat', id: 'b' } };
    const tracking: TrackingDirective = { fromPly: 1, toPly: 1, subject: { kind: 'piece', pieceId: rook }, role: 'critical', priority: 1, evidenceRef: { kind: 'move', ply: 1 } };
    const plyAtMs = new Map([[1, 1000], [2, 1300]]);
    const plyDurationMs = new Map([[1, 300], [2, 300]]);
    // This annotation belongs to ply 2 — it must not widen ply 1's own frame.
    const tactical = [defenderLoss(2, 2, ['a8', 'h1'])];

    const plan = buildCameraPlan([directive], plyAtMs, plyDurationMs, 2000, RAMP_MS, null, [tracking], game, SETTINGS, tactical);
    const region = ['f8', 'h8'];
    expect(plan.keyframes[1]).toEqual({ atMs: 1000, ...expectedCenter(region), zoom: zoomForSquares(region, SETTINGS) });
  });
});

/**
 * Phase 18E-B — the Phase 18 integration review's confirmed game_07
 * inconsistency: a CameraDirective's own atPly/untilPly (derived from
 * StoryBeat plies, consequent-anchored) can extend past
 * deriveClipWindow's own endPly (payoff-anchored), silently "rescued" only
 * by an unrelated fallback formula in buildCameraPlan that was never
 * designed for this purpose. lowerToTimeline() now explicitly clamps every
 * camera/tactical/tracking directive to the selected clip window before
 * lowering — see clampCameraDirectivesToWindow/clampSpanDirectivesToWindow.
 *
 * These tests drive the real, exported lowerToTimeline() end to end with a
 * hand-built StoryPlan (via centralConflict/consequenceChain fixtures) that
 * reproduces game_07's exact shape — a consequenceChain whose payoff lands
 * BEFORE its own chain's last consequent ply — scaled to small ply numbers
 * for clarity, with a hand-built CinematicPlan whose directives extend past
 * the resulting window on both ends, to exercise every boundary case in one
 * fixture: before-start clamp, after-end clamp, fully-inside unchanged,
 * fully-outside dropped, and the exact inclusive boundary.
 */
describe('lowerToTimeline — Phase 18E-B clip/directive range reconciliation', () => {
  function clipMismatchGame(): { game: ReturnType<typeof gameFromMoves>; story: StoryPlan } {
    const moves = [
      moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4'),
      moveRecord(2, 'b', 'p', 'e7', 'e5', 'e5'),
      moveRecord(3, 'w', 'n', 'g1', 'f3', 'Nf3'),
      moveRecord(4, 'b', 'n', 'b8', 'c6', 'Nc6'),
      moveRecord(5, 'w', 'b', 'f1', 'c4', 'Bc4'),
      moveRecord(6, 'b', 'b', 'f8', 'c5', 'Bc5'),
      moveRecord(7, 'w', 'q', 'd1', 'h5', 'Qh5'),
      moveRecord(8, 'b', 'n', 'g8', 'f6', 'Nf6')
    ];
    const game = gameFromMoves(moves);
    // triggerPly=4 (critical), one antecedent at ply 3 (=> startPly=3),
    // consequents through ply 7, payoff landing at ply 5 (=> endPly=5) —
    // exactly game_07's own shape: the chain's own consequents (up to 7)
    // outlive the payoff that actually determines the window's own end.
    const chain = consequenceChain(4, {
      antecedents: [{ ply: 3, linkType: 'same-sequence', evidenceId: 'e3' }],
      consequents: [
        { ply: 5, linkType: 'multi-move-consequence', evidenceId: 'e5' },
        { ply: 6, linkType: 'multi-move-consequence', evidenceId: 'e6' },
        { ply: 7, linkType: 'multi-move-consequence', evidenceId: 'e7' }
      ],
      payoff: { kind: 'material-settled', atPly: 5, netMaterialChange: 300 },
      reachesResult: false
    });
    const story = storyPlanFrom({ centralConflict: centralConflict('tp-4', 4, { consequenceChain: chain }) });
    return { game, story };
  }

  function plan(overrides: Partial<CinematicPlan>): CinematicPlan {
    return {
      schemaVersion: 1,
      moveTreatmentPlan: [],
      cameraDirectives: [],
      annotationDirectives: [],
      tacticalDirectives: [],
      trackingDirectives: [],
      transitionDirectives: [],
      finalPositionIsTerminal: false,
      settings: DEFAULT_DIRECTOR_SETTINGS,
      ...overrides
    };
  }

  it("Game 07 exact shape: a CameraDirective starting exactly at the window's own endPly (5) and spanning to ply 8 never references ply 8 at all", () => {
    const { game, story } = clipMismatchGame();
    const cameraDirectives: CameraDirective[] = [
      { atPly: 5, untilPly: 8, role: 'consequence', zoom: 1, squares: ['e7', 'f6'], evidenceRef: { kind: 'beat', id: 'consequence' } }
    ];
    const timeline = lowerToTimeline(game, plan({ cameraDirectives }), story);
    const moveBeatAtMs = new Map(
      timeline.scenes[0]!.beats.filter((b): b is MoveBeat => b.kind === 'move').map((b) => [b.resultingPly, b.atMs])
    );
    // Ply 8 was never part of this Scene at all (windowed out) — its atMs
    // cannot exist anywhere, so no keyframe can reference it either.
    expect(moveBeatAtMs.has(8)).toBe(false);
    for (const k of timeline.scenes[0]!.cameraPlan.keyframes) {
      expect(k.atMs).toBeLessThanOrEqual(timeline.scenes[0]!.durationMs);
    }
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it("a CameraDirective spanning the WHOLE window and beyond (atPly 3..8, window ends at 5) holds through ply 5's own real duration — not cut short by an out-of-window untilPly", () => {
    const { game, story } = clipMismatchGame();
    // Without the Phase 18E-B clamp, untilPly=8 has no plyAtMs entry, so
    // buildCameraPlan's own PRE-EXISTING fallback formula
    // (atMs(atPly) + duration(atPly)) would end the hold right after ply 3
    // alone — 600ms — silently discarding plies 4 and 5 entirely. Clamped
    // to atPly:3, untilPly:5, the SAME formula correctly reaches
    // plyAtMs(5)=1200 + duration(5)=600 = 1800, which Phase 15's own
    // pre-existing reserve-tail logic then caps at
    // sceneDurationMs(1800) - TERMINAL_ZOOM_OUT_MS(200) = 1600. That 1600,
    // not 600, is the proof the fix is actually applied.
    const cameraDirectives: CameraDirective[] = [
      { atPly: 3, untilPly: 8, role: 'consequence', zoom: 1.4, squares: ['g1', 'f3'], evidenceRef: { kind: 'beat', id: 'consequence' } }
    ];
    const timeline = lowerToTimeline(game, plan({ cameraDirectives }), story);
    const keyframes = timeline.scenes[0]!.cameraPlan.keyframes;

    expect(timeline.scenes[0]!.durationMs).toBe(1800); // 3 considered moves (plies 3,4,5) x 600ms
    expect(keyframes).toEqual([
      { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
      { atMs: 0, centerX: 6, centerY: 6.5, zoom: 1.4 }, // g1/f3 bounding-box center, zoom-in at ply 3's own atMs
      { atMs: 1600, centerX: 6, centerY: 6.5, zoom: 1.4 }, // correct hold-end — reaches ply 5, then Phase 15's reserve-tail caps it here
      { atMs: 1800, centerX: 4, centerY: 4, zoom: 1 }
    ]);
  });

  it('clamps a CameraDirective that starts before the window (before-start clamp): the directive is rescued to cover only its real, in-window portion, not silently dropped', () => {
    const { game, story } = clipMismatchGame();
    const cameraDirectives: CameraDirective[] = [
      { atPly: 1, untilPly: 3, role: 'establish', zoom: 1.25, squares: ['e2', 'e4'], evidenceRef: { kind: 'beat', id: 'setup' } }
    ];
    const timeline = lowerToTimeline(game, plan({ cameraDirectives }), story);
    // Window startPly=3: ply 1's own atMs does not exist in this Scene at
    // all (only plies 3-5 are considered). Without the clamp,
    // buildCameraPlan's pre-existing top-level guard
    // (`plyAtMs.get(directive.atPly) === undefined -> continue`) would find
    // no entry for atPly=1 and skip this directive ENTIRELY — keyframes[1]
    // would then be the unconditional final reset ({4,4,1}), not this
    // establish framing at all. Clamped to atPly:3 (ply 3's own real atMs
    // is 0, the first considered move), the directive is rescued and its
    // own zoom (1.25, not 1) genuinely appears.
    const ply3AtMs = timeline.scenes[0]!.beats.find((b): b is MoveBeat => b.kind === 'move' && b.resultingPly === 3)!.atMs;
    expect(ply3AtMs).toBe(0);
    const firstNonBaseKeyframe = timeline.scenes[0]!.cameraPlan.keyframes[1]!;
    expect(firstNonBaseKeyframe.atMs).toBe(ply3AtMs);
    expect(firstNonBaseKeyframe.zoom).toBe(1.25);
  });

  it('a TacticalAnnotationDirective fully outside the window (fromPly > endPly) is dropped entirely — never rendered', () => {
    const { game, story } = clipMismatchGame();
    const tacticalDirectives: TacticalAnnotationDirective[] = [
      { fromPly: 6, toPly: 6, kind: 'check-marker', role: 'consequence', squares: ['e8'], priority: 8, evidenceRef: { kind: 'terminal', ply: 6 } }
    ];
    const timeline = lowerToTimeline(game, plan({ tacticalDirectives }), story);
    const annotationBeats = timeline.scenes[0]!.beats.filter((b) => b.kind === 'annotation');
    expect(annotationBeats).toHaveLength(0);
  });

  it('a TacticalAnnotationDirective fully inside the window (fromPly===toPly===endPly) is rendered unchanged', () => {
    const { game, story } = clipMismatchGame();
    const tacticalDirectives: TacticalAnnotationDirective[] = [
      { fromPly: 5, toPly: 5, kind: 'check-marker', role: 'consequence', squares: ['e8'], priority: 8, evidenceRef: { kind: 'terminal', ply: 5 } }
    ];
    const timeline = lowerToTimeline(game, plan({ tacticalDirectives }), story);
    const annotationBeats = timeline.scenes[0]!.beats.filter((b) => b.kind === 'annotation');
    expect(annotationBeats).toHaveLength(1);
  });

  it('a TrackingDirective is clamped exactly like its own CameraDirective, preserving the fromPly/toPly===atPly/untilPly invariant', () => {
    const { game, story } = clipMismatchGame();
    const attacker = pieceIdFor('w', 'q', 'd1');
    const cameraDirectives: CameraDirective[] = [
      { atPly: 5, untilPly: 8, role: 'consequence', zoom: 1, squares: ['h5', 'f7'], evidenceRef: { kind: 'beat', id: 'consequence' } }
    ];
    const trackingDirectives: TrackingDirective[] = [
      { fromPly: 5, toPly: 8, subject: { kind: 'piece', pieceId: attacker }, role: 'consequence', priority: 1, evidenceRef: { kind: 'move', ply: 5 } }
    ];
    // Should not throw, and should not silently reintroduce ply 8 — the
    // real assertion is that lowering completes and produces a valid Scene
    // whose own last MoveBeat never exceeds the window's own endPly (5).
    const timeline = lowerToTimeline(game, plan({ cameraDirectives, trackingDirectives }), story);
    expect(() => assertValidTimeline(timeline)).not.toThrow();
    const lastResultingPly = Math.max(...timeline.scenes[0]!.beats.filter((b): b is MoveBeat => b.kind === 'move').map((b) => b.resultingPly));
    expect(lastResultingPly).toBe(5);
  });

  it('Full Game (no central conflict) is byte-identical — clamping never applies when clipWindow is abstained', () => {
    const game = gameFromMoves([moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4'), moveRecord(2, 'b', 'p', 'e7', 'e5', 'e5')]);
    const story = storyPlanFrom({ centralConflict: null, noConflictReason: 'no-turning-points' });
    const cameraDirectives: CameraDirective[] = [
      { atPly: 1, untilPly: 2, role: 'critical', zoom: 1.3, squares: ['e4', 'e5'], evidenceRef: { kind: 'beat', id: 'b' } }
    ];
    const cinematicPlan = plan({ cameraDirectives });
    const timeline = lowerToTimeline(game, cinematicPlan, story);
    // Full Game considers every move — nothing was ever out of window to
    // clamp, so the directive's own atPly/untilPly survive completely
    // unchanged into the real keyframes.
    expect(timeline.scenes[0]!.cameraPlan.keyframes[1]!.zoom).toBe(1.3);
    const beats = timeline.scenes[0]!.beats.filter((b): b is MoveBeat => b.kind === 'move');
    expect(beats.map((b) => b.resultingPly)).toEqual([1, 2]);
  });
});

/**
 * Phase 18A — Cinematic Clip Windowing integration coverage. deriveClipWindow
 * itself is covered exhaustively, in isolation, by clipWindow.test.ts; these
 * tests exist only to prove lowerToTimeline actually applies that window to
 * the real MoveBeat/CameraPlan/Scene output, and — the one mandatory
 * regression fix for this batch — that the terminal camera treatment never
 * fires on a ply that is not actually the WINDOW's own last move, even when
 * CinematicPlan.finalPositionIsTerminal is true for the real, unwindowed game.
 */
describe('lowerToTimeline — Phase 18A clip windowing', () => {
  it('produces a Scene covering only the windowed plies (3-7 of a 10-ply game), strictly shorter than the full game', () => {
    const { game, analysis, understanding, story } = windowedMomentScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    const beats = moveBeats(timeline).sort((a, b) => a.atMs - b.atMs);

    expect(beats.map((b) => b.resultingPly)).toEqual([3, 4, 5, 6, 7]);
    expect(timeline.scenes[0]!.startPly).toBe(2); // game.positions index for "just before ply 3"
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('does NOT fire the terminal camera treatment on a truncated/payoff-short window, even though the real, unwindowed game ends in a genuine terminal result', () => {
    const { game, analysis, understanding, story } = windowedMomentScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);

    // Precondition: the real game (all 10 plies) DOES end in a terminal
    // result — if this ever stops holding, the fixture, not the assertions
    // below, needs revisiting.
    expect(plan.finalPositionIsTerminal).toBe(true);
    expect(game.moves[game.moves.length - 1]!.ply).toBe(10);

    const timeline = lowerToTimeline(game, plan, story);
    const beats = moveBeats(timeline);
    // The window's own last move is ply 7, never ply 10.
    expect(Math.max(...beats.map((b) => b.resultingPly))).toBe(7);

    // No keyframe in the resulting CameraPlan reaches the critical
    // directive's own zoom a second time near the end of the scene the way
    // Phase 13B's terminal re-engagement would — the only such keyframes
    // present are the ones the climax beat itself (ply 5) already produces.
    const critical = plan.cameraDirectives.find((d) => d.role === 'critical');
    expect(critical).toBeDefined();
    const keyframes = timeline.scenes[0]!.cameraPlan.keyframes;
    const criticalZoomKeyframes = keyframes.filter((k) => k.zoom === critical!.zoom && k.zoom > 1);
    for (const k of criticalZoomKeyframes) {
      expect(k.atMs).toBeLessThan(timeline.scenes[0]!.durationMs);
    }
    // The scene always resets to full-board framing at its own true end.
    expect(keyframes[keyframes.length - 1]).toEqual({
      atMs: timeline.scenes[0]!.durationMs,
      centerX: 4,
      centerY: 4,
      zoom: 1
    });
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('abstention (centralConflict === null) preserves the pre-Phase-18A Full Game behavior exactly: every move considered, scene starting at ply 0', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    expect(story.centralConflict).toBeNull();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);
    const beats = moveBeats(timeline);
    expect(beats).toHaveLength(game.moves.length);
    expect(timeline.scenes[0]!.startPly).toBe(0);
    expect(timeline.scenes[0]!.startPositionFen).toBe(game.positions[0]!.fen);
  });
});
