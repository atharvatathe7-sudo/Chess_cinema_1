import { describe, expect, it } from 'vitest';
import { DEFAULT_DIRECTOR_SETTINGS } from './types';
import { buildCinematicPlan, pacingForPly } from './buildCinematicPlan';
import { quietGameScenario, richMateEndingScenario, storyBeat, zeroMoveScenario } from './directorFixtures';

describe('pacingForPly', () => {
  const settings = DEFAULT_DIRECTOR_SETTINGS;
  const noOpportunities = new Set<number>();

  it('maps setup beat role to linear pacing', () => {
    const beats = [storyBeat('b-setup', 'setup', [1])];
    expect(pacingForPly(1, 'setup', beats, noOpportunities, settings)).toEqual({ ply: 1, pacing: 'linear', durationMultiplier: 1 });
  });

  it('maps building-sequence beat role to held pacing', () => {
    const beats = [storyBeat('b-seq', 'building-sequence', [2])];
    expect(pacingForPly(2, 'spine', beats, noOpportunities, settings)).toEqual({
      ply: 2,
      pacing: 'held',
      durationMultiplier: settings.heldMultiplier
    });
  });

  it('maps climax beat role to held pacing', () => {
    const beats = [storyBeat('b-climax', 'climax', [3])];
    expect(pacingForPly(3, 'spine', beats, noOpportunities, settings)).toEqual({
      ply: 3,
      pacing: 'held',
      durationMultiplier: settings.heldMultiplier
    });
  });

  it('maps consequence beat role to linear pacing', () => {
    const beats = [storyBeat('b-cons', 'consequence', [4])];
    expect(pacingForPly(4, 'spine', beats, noOpportunities, settings)).toEqual({ ply: 4, pacing: 'linear', durationMultiplier: 1 });
  });

  it('maps resolution beat role to held pacing', () => {
    const beats = [storyBeat('b-res', 'resolution', [5])];
    expect(pacingForPly(5, 'spine', beats, noOpportunities, settings)).toEqual({
      ply: 5,
      pacing: 'held',
      durationMultiplier: settings.heldMultiplier
    });
  });

  it('maps compressible MoveTreatment (no owning beat) to compressed pacing', () => {
    expect(pacingForPly(6, 'compressible', [], noOpportunities, settings)).toEqual({
      ply: 6,
      pacing: 'compressed',
      durationMultiplier: settings.compressedMultiplier
    });
  });

  it('maps theory MoveTreatment (no owning beat) to compressed pacing at the theory multiplier', () => {
    expect(pacingForPly(7, 'theory', [], noOpportunities, settings)).toEqual({
      ply: 7,
      pacing: 'compressed',
      durationMultiplier: settings.theoryMultiplier
    });
  });

  it('maps pruned MoveTreatment to skipped pacing with a zero multiplier', () => {
    expect(pacingForPly(8, 'pruned', [], noOpportunities, settings)).toEqual({ ply: 8, pacing: 'skipped', durationMultiplier: 0 });
  });

  it('applies the explanation-opportunity bonus only to spine plies that have one', () => {
    const beats = [storyBeat('b-climax', 'climax', [3])];
    const withOpportunity = pacingForPly(3, 'spine', beats, new Set([3]), settings);
    expect(withOpportunity.durationMultiplier).toBe(settings.heldMultiplier * settings.explanationOpportunityBonusMultiplier);

    // Same ply, but 'setup' treatment (never 'spine') — bonus must not apply even with an opportunity flagged.
    const setupBeats = [storyBeat('b-setup', 'setup', [3])];
    const setupPly = pacingForPly(3, 'setup', setupBeats, new Set([3]), settings);
    expect(setupPly.durationMultiplier).toBe(1);
  });
});

describe('buildCinematicPlan', () => {
  it('produces an empty plan for a zero-move game', () => {
    const { game, analysis, understanding, story } = zeroMoveScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    expect(plan.moveTreatmentPlan).toEqual([]);
    expect(plan.cameraDirectives).toEqual([]);
    expect(plan.annotationDirectives).toEqual([]);
    expect(plan.transitionDirectives).toEqual([]);
  });

  it('produces full ply coverage with no camera directives and no beat-scoped transitions for a quiet game', () => {
    const { game, analysis, understanding, story } = quietGameScenario();
    expect(story.centralConflict).toBeNull();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    expect(plan.moveTreatmentPlan.map((t) => t.ply)).toEqual(story.moveTreatment.map((t) => t.ply));
    expect(plan.cameraDirectives).toEqual([]);
    expect(plan.transitionDirectives).toEqual([]);
  });

  it('covers every ply exactly once, matching StoryPlan.moveTreatment 1:1', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    expect(plan.moveTreatmentPlan).toHaveLength(story.moveTreatment.length);
    expect(plan.moveTreatmentPlan.map((t) => t.ply)).toEqual(story.moveTreatment.map((t) => t.ply));
  });

  it('applies the explanation-opportunity bonus at the climax ply produced by the real StoryPlan pipeline', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const opportunity = story.explanationOpportunities.find((eo) => eo.ply === 4);
    expect(opportunity).toBeDefined(); // fixture's default BestAlternativeRecord.bestMoveUniqueness is 'unknown' -> 'insufficient-data'

    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const entry = plan.moveTreatmentPlan.find((t) => t.ply === 4)!;
    expect(entry.durationMultiplier).toBe(DEFAULT_DIRECTOR_SETTINGS.heldMultiplier * DEFAULT_DIRECTOR_SETTINGS.explanationOpportunityBonusMultiplier);
  });

  it('produces one transition directive per beat boundary, excluding the first beat', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    expect(plan.transitionDirectives).toHaveLength(story.beats.length - 1);
    expect(plan.transitionDirectives.every((t) => t.pauseMs === DEFAULT_DIRECTOR_SETTINGS.beatBoundaryPauseMs)).toBe(true);
  });

  it('is deterministic: two calls on the same inputs match byte-for-byte', () => {
    const { game, analysis, understanding, story } = richMateEndingScenario();
    const first = buildCinematicPlan(game, analysis, understanding, story);
    const second = buildCinematicPlan(game, analysis, understanding, story);
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });
});
