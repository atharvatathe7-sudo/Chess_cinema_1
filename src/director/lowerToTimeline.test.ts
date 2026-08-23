import { describe, expect, it } from 'vitest';
import { assertValidTimeline } from '../timeline/invariants';
import type { MoveBeat } from '../timeline/types';
import { buildCinematicPlan } from './buildCinematicPlan';
import { lowerToTimeline } from './lowerToTimeline';
import { prunedPlyScenario, quietGameScenario, richMateEndingScenario, zeroMoveScenario } from './directorFixtures';
import { DEFAULT_DIRECTOR_SETTINGS } from './types';

function moveBeats(timeline: ReturnType<typeof lowerToTimeline>): MoveBeat[] {
  return timeline.scenes[0]!.beats.filter((b): b is MoveBeat => b.kind === 'move');
}

describe('lowerToTimeline', () => {
  it('passes assertValidTimeline with zero violations for a rich, multi-beat plan', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan);
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('passes assertValidTimeline for a quiet game', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan);
    expect(() => assertValidTimeline(timeline)).not.toThrow();
  });

  it('produces a valid, static, zero-duration Scene for a zero-move game', () => {
    const { game, analysis, understanding, story } = zeroMoveScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan);
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

    const timeline = lowerToTimeline(game, plan);
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
    const timeline = lowerToTimeline(game, plan);
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
    const timeline = lowerToTimeline(game, plan);
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
    const first = lowerToTimeline(game, plan);
    const second = lowerToTimeline(game, plan);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it('produces a camera plan with a single static full-board keyframe when there is no climax beat', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan);
    expect(timeline.scenes[0]!.cameraPlan.keyframes).toEqual([{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }]);
  });

  it('produces a zoom-in/hold/zoom-out camera plan anchored on the climax ply', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan);
    const keyframes = timeline.scenes[0]!.cameraPlan.keyframes;
    expect(keyframes.length).toBeGreaterThanOrEqual(4);
    expect(keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });
    expect(keyframes.some((k) => k.zoom === DEFAULT_DIRECTOR_SETTINGS.climaxZoom)).toBe(true);
    expect(keyframes[keyframes.length - 1]).toEqual({
      atMs: timeline.scenes[0]!.durationMs,
      centerX: 4,
      centerY: 4,
      zoom: 1
    });
  });
});
