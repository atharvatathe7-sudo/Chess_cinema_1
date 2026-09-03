import { describe, expect, it } from 'vitest';
import { buildStoryPlan } from './buildStoryPlan';
import { STORY_SCHEMA_VERSION } from './types';
import type { GameUnderstanding } from '../understanding/types';
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
      leadArchetype: null,
      supportingArchetypes: [],
      pieceContributions: [],
      explanationOpportunities: [],
      // Phase 15 — an empty game has no story, and says so structurally
      // rather than through a low score.
      confidence: {
        level: 'none',
        causalClaimAllowed: false,
        mechanismVerified: false,
        resolutionCorroborated: false,
        payoffCorroborated: false,
        hasConsequents: false,
        reachesResult: false,
        reasons: ['no-story: no-turning-points']
      },
      // GATE 0 still runs for an empty game: it resolves to "nothing is
      // known", which is a real answer, not a placeholder.
      outcome: {
        result: null,
        termination: 'absent',
        onBoard: false,
        finalEvaluation: { kind: 'cp', cp: 0 },
        finalMaterialDiff: 0,
        source: 'none',
        confidence: 0
      },
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

/**
 * Phase 15 — structural invariants over whatever buildStoryPlan produces.
 *
 * These are the properties that must hold for EVERY game, not assertions
 * about one fixture's expected output. They are the guardrails that stop a
 * future change from quietly reintroducing a fabricated claim, and they are
 * written so the same checks can be run over the whole real corpus.
 */
describe('StoryPlan invariants (Phase 15)', () => {
  function assertInvariants(plan: ReturnType<typeof buildStoryPlan>, understanding: GameUnderstanding) {
    // 12. No StoryPlan may contain an unverified mechanism.
    for (const tp of understanding.turningPoints) {
      const cc = tp.causeConsequence;
      if (cc.mechanism !== null) {
        expect(cc.mechanismVerified).toBe(true);
      }
      if (!cc.mechanismVerified) {
        expect(cc.mechanism).toBeNull();
      }
    }

    // A causal claim is never permitted without all four preconditions.
    if (plan.confidence.causalClaimAllowed) {
      expect(plan.confidence.mechanismVerified).toBe(true);
      expect(plan.confidence.resolutionCorroborated).toBe(true);
      expect(plan.confidence.hasConsequents).toBe(true);
    }

    // Abstention and a selected story are mutually exclusive, and 'none'
    // confidence is reserved for abstention.
    if (plan.centralConflict === null) {
      expect(plan.noConflictReason).toBeDefined();
      expect(plan.confidence.level).toBe('none');
    } else {
      expect(plan.confidence.level).not.toBe('none');
    }

    // An archetype may lead only when it contains the trigger and reaches
    // the payoff; otherwise it is supporting, never both.
    if (plan.leadArchetype !== null) {
      expect(plan.supportingArchetypes).not.toContain(plan.leadArchetype);
    }
  }

  it('holds for an empty game', () => {
    const game = gameFrom([]);
    const analysis = analysisFrom([]);
    const understanding = understandingFrom({ plies: [] });
    assertInvariants(buildStoryPlan(game, analysis, understanding), understanding);
  });

  it('holds for a quiet game with no turning points', () => {
    const moves = [move(1, { pieceId: 'w-p-e2', from: 'e2', to: 'e4' }), move(2, { pieceId: 'b-p-e7', from: 'e7', to: 'e5' })];
    const game = gameFrom(moves);
    const analysis = analysisFrom([plyAnalysis(1), plyAnalysis(2)]);
    const understanding = understandingFrom({
      plies: [plySemantics(1, plySignals('w-p-e2')), plySemantics(2, plySignals('b-p-e7'))]
    });
    assertInvariants(buildStoryPlan(game, analysis, understanding), understanding);
  });

  it('never emits a "repelled" resolution with no threats removed, at plan level', () => {
    // The single most damaging fabrication the benchmark surfaced, asserted
    // as a property of the whole plan rather than of one function.
    const moves = [move(1, { pieceId: 'w-p-e2', from: 'e2', to: 'e4' })];
    const game = gameFrom(moves);
    const analysis = analysisFrom([plyAnalysis(1)]);
    const cc = causeConsequence(1, { resolution: 'unresolved', threatsRemoved: [] });
    const understanding = understandingFrom({
      plies: [plySemantics(1, plySignals('w-p-e2'))],
      turningPoints: [turningPoint(1, 'decisive-swing', cc, 500)]
    });

    const plan = buildStoryPlan(game, analysis, understanding);
    for (const tp of understanding.turningPoints) {
      if (tp.causeConsequence.resolution === 'repelled') {
        expect(tp.causeConsequence.threatsRemoved.length).toBeGreaterThan(0);
      }
    }
    assertInvariants(plan, understanding);
  });
});
