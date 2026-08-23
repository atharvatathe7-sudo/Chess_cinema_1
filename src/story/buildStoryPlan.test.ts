import { describe, expect, it } from 'vitest';
import { buildStoryPlan } from './buildStoryPlan';
import { STORY_SCHEMA_VERSION } from './types';
import { analysisFrom, causeConsequence, gameArc, gameFrom, move, plyAnalysis, plySemantics, plySignals, turningPoint, understandingFrom } from './storyFixtures';

describe('buildStoryPlan', () => {
  it('returns a fully empty StoryPlan for an empty game', () => {
    const game = gameFrom([]);
    const analysis = analysisFrom([]);
    const understanding = understandingFrom({ plies: [] });

    const plan = buildStoryPlan(game, analysis, understanding);
    expect(plan).toEqual({
      schemaVersion: STORY_SCHEMA_VERSION,
      centralConflict: null,
      noConflictReason: 'no-turning-points',
      beats: [],
      moveTreatment: [],
      archetypeSignals: [],
      pieceContributions: [],
      explanationOpportunities: [],
      settings: plan.settings
    });
  });

  it('is a quiet-game plan (no fabricated drama) when there are zero turning points', () => {
    const moves = [move(1, { pieceId: 'w-p-e2', from: 'e2', to: 'e4' }), move(2, { pieceId: 'b-p-e7', from: 'e7', to: 'e5' })];
    const game = gameFrom(moves);
    const analysisPlies = [plyAnalysis(1), plyAnalysis(2)];
    const analysis = analysisFrom(analysisPlies);
    const understanding = understandingFrom({
      plies: [
        plySemantics(1, plySignals('w-p-e2')),
        plySemantics(2, plySignals('b-p-e7'))
      ],
      gameArc: gameArc(2, 2, [])
    });

    const plan = buildStoryPlan(game, analysis, understanding);
    expect(plan.centralConflict).toBeNull();
    expect(plan.noConflictReason).toBe('no-turning-points');
    expect(plan.beats).toEqual([]);
    expect(plan.moveTreatment.every((mt) => mt.treatment === 'theory')).toBe(true);
  });

  it('builds a spine and a resolution beat for a decisive game ending in forced mate', () => {
    const moves = Array.from({ length: 5 }, (_, i) => move(i + 1, { pieceId: `w-p-a${i}`, from: 'a2', to: 'a3' }));
    const game = gameFrom(moves);
    const analysisPlies = Array.from({ length: 5 }, (_, i) => plyAnalysis(i + 1));
    const analysis = analysisFrom(analysisPlies);

    const cc = causeConsequence(5, { resolution: 'forced-mate' });
    const tp = turningPoint(5, 'forced-mate-delivery', cc, 900);
    const understanding = understandingFrom({
      plies: Array.from({ length: 5 }, (_, i) => plySemantics(i + 1, plySignals(`w-p-a${i}`))),
      turningPoints: [tp],
      gameArc: gameArc(5, 5, [])
    });

    const plan = buildStoryPlan(game, analysis, understanding);
    expect(plan.centralConflict).not.toBeNull();
    expect(plan.centralConflict!.primaryTurningPointId).toBe('tp-5');
    expect(plan.noConflictReason).toBeUndefined();
    expect(plan.beats.map((b) => b.role)).toEqual(['climax', 'resolution']);
    expect(plan.moveTreatment.find((mt) => mt.ply === 5)!.treatment).toBe('spine');
  });

  it('throws when understanding references a ply with no matching MoveRecord in game', () => {
    const game = gameFrom([move(1, { pieceId: 'w-p-a2' })]);
    const analysis = analysisFrom([plyAnalysis(1)]);
    const understanding = understandingFrom({ plies: [plySemantics(1, plySignals('w-p-a2')), plySemantics(2, plySignals('w-p-a2'))] });

    expect(() => buildStoryPlan(game, analysis, understanding)).toThrow(/no MoveRecord for ply 2/);
  });

  it('is deterministic: two calls on an identical, tie-heavy input produce byte-identical output', () => {
    const moveCount = 12;
    const moves = Array.from({ length: moveCount }, (_, i) => move(i + 1, { pieceId: `w-p-a${i}`, from: 'a2', to: 'a3' }));
    const game = gameFrom(moves);
    const analysisPlies = Array.from({ length: moveCount }, (_, i) => plyAnalysis(i + 1));
    const analysis = analysisFrom(analysisPlies);

    // Two turning points tied on both score and |netMaterialChange|, to stress the ply-ascending final tie-break.
    const ccA = causeConsequence(3, { materialConsequence: { atPly: 3, netMaterialChange: 300 } });
    const ccB = causeConsequence(9, { materialConsequence: { atPly: 9, netMaterialChange: 300 } });
    const tpA = turningPoint(3, 'decisive-swing', ccA, 300);
    const tpB = turningPoint(9, 'decisive-swing', ccB, 300);

    const understanding = understandingFrom({
      plies: Array.from({ length: moveCount }, (_, i) => plySemantics(i + 1, plySignals(`w-p-a${i}`))),
      turningPoints: [tpB, tpA],
      gameArc: gameArc(4, 4, [])
    });

    const first = buildStoryPlan(game, analysis, understanding);
    const second = buildStoryPlan(game, analysis, understanding);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
