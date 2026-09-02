import { describe, expect, it } from 'vitest';
import type { Evaluation, GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameUnderstanding, TurningPoint } from '../understanding/types';
import { DEFAULT_STORY_SETTINGS } from './types';
import { analysisFrom, causeConsequence, gameArc, plyAnalysis, plySemantics, plySignals, turningPoint, understandingFrom, unknownOutcome } from './storyFixtures';
import { buildStoryCandidates, compareCandidates, selectStoryCandidate } from './storyCandidates';

/**
 * Phase 15 (M8) — story candidate construction and the five-gate cascade.
 *
 * These are structural fixtures. None keys on a game number or SAN string;
 * each reproduces a SHAPE the benchmark exposed:
 *
 *   - an early exchange that briefly moves the evaluation and is immediately
 *     given back, in a long game that ends level
 *   - a large swing that is cancelled by the very next move
 *   - an ending that nothing in the game corroborates
 *   - a mate that arrives several plies after the move that forced it
 */

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function evalPly(ply: number, before: number, after: number, overrides: Partial<PlyAnalysis> = {}): PlyAnalysis {
  return plyAnalysis(ply, {
    fenAfter: FEN,
    evaluationBefore: { kind: 'cp', cp: before },
    evaluationAfter: { kind: 'cp', cp: after },
    swingCp: after - before,
    swingForMoverCp: overrides.sideToMove === 'b' ? -(after - before) : after - before,
    ...overrides
  });
}

/** A long, level game: the evaluation hovers near zero for its whole length. */
function levelGame(length: number, exceptions: ReadonlyMap<number, { before: number; after: number }> = new Map()): GameAnalysis {
  const plies: PlyAnalysis[] = [];
  for (let p = 1; p <= length; p++) {
    const e = exceptions.get(p);
    plies.push(evalPly(p, e?.before ?? 0, e?.after ?? 0, { sideToMove: p % 2 === 1 ? 'w' : 'b' }));
  }
  return analysisFrom(plies);
}

function flatTrajectory(length: number): GameUnderstanding['gameArc'] {
  return gameArc(24, length, Array.from({ length }, (_, i) => ({ ply: i + 1, materialDiff: 0 })));
}

describe('GATE 1 — admissibility', () => {
  it('rejects an event whose advantage is immediately given back (the game-05 shape)', () => {
    // A brief exchange around ply 12 of a 131-ply game that returns to level
    // and stays there. Locally it looks like something happened; nothing
    // survived it.
    const analysis = levelGame(131, new Map([[12, { before: 0, after: 320 }]]));
    const tp = turningPoint(
      12,
      'irreversible-material-loss',
      causeConsequence(12, { materialConsequence: { atPly: 12, netMaterialChange: 320 } }),
      507
    );
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(131) });

    const [candidate] = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidate!.admissible).toBe(false);
    expect(candidate!.notes.join(' ')).toContain('gate1');
  });

  it('rejects a large swing that the very next move cancels', () => {
    const analysis = levelGame(120, new Map([
      [61, { before: 516, after: -69 }],
      [62, { before: -69, after: 583 }]
    ]));
    const tp = turningPoint(62, 'decisive-swing', causeConsequence(62), 752);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(120) });

    const [candidate] = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidate!.admissible).toBe(false);
  });

  it('admits an advantage that actually persists', () => {
    const exceptions = new Map([[30, { before: 0, after: 600 }]]);
    for (let p = 31; p <= 60; p++) exceptions.set(p, { before: 600, after: 600 });
    const analysis = levelGame(60, exceptions);
    const tp = turningPoint(
      30,
      'irreversible-material-loss',
      causeConsequence(30, { materialConsequence: { atPly: 30, netMaterialChange: 500 } }),
      500
    );
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(60) });

    const [candidate] = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidate!.admissible).toBe(true);
    expect(candidate!.persistencePlies).toBeGreaterThanOrEqual(6);
  });

  it('never asks a terminal event to persist for six plies', () => {
    // A mate at the very end of a game has no plies left to persist across.
    const analysis = analysisFrom([
      evalPly(1, 0, 0),
      evalPly(2, 0, 0),
      plyAnalysis(3, { fenAfter: FEN, evaluationAfter: { kind: 'terminal', result: 'white-wins' } })
    ]);
    const tp = turningPoint(3, 'forced-mate-delivery', causeConsequence(3, { resolution: 'forced-mate' }), 900);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(3) });

    const [candidate] = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidate!.admissible).toBe(true);
  });

  it('rejects an optimal move that is not itself a payoff event', () => {
    const exceptions = new Map([[10, { before: 0, after: 400 }]]);
    for (let p = 11; p <= 40; p++) exceptions.set(p, { before: 400, after: 400 });
    const analysis = levelGame(40, exceptions);
    const tp = turningPoint(
      10,
      'irreversible-material-loss',
      causeConsequence(10, { materialConsequence: { atPly: 10, netMaterialChange: 400 } }),
      400
    );
    const understanding = understandingFrom({
      plies: [plySemantics(10, plySignals('w-p-e2'), { qualityClass: 'optimal' })],
      turningPoints: [tp],
      gameArc: flatTrajectory(40)
    });

    const [candidate] = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidate!.admissible).toBe(false);
    expect(candidate!.notes.join(' ')).toContain('optimal');
  });
});

describe('GATE 2 — tiering', () => {
  function matingAnalysis(): GameAnalysis {
    return analysisFrom([
      evalPly(1, 0, 0),
      evalPly(2, 0, 0),
      plyAnalysis(3, { fenAfter: FEN, evaluationAfter: { kind: 'mate', mateIn: 2 } }),
      plyAnalysis(4, { fenAfter: FEN, evaluationAfter: { kind: 'mate', mateIn: 1 } }),
      plyAnalysis(5, { fenAfter: FEN, evaluationAfter: { kind: 'terminal', result: 'white-wins' } })
    ]);
  }

  it('places a candidate whose chain reaches the result in Tier A', () => {
    const tp = turningPoint(3, 'mate-appeared', causeConsequence(3), 900);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(5) });
    const outcome = unknownOutcome({
      result: '1-0',
      termination: 'checkmate',
      onBoard: true,
      finalEvaluation: { kind: 'terminal', result: 'white-wins' },
      source: 'engine-terminal',
      confidence: 1
    });

    const [candidate] = buildStoryCandidates(understanding, matingAnalysis(), outcome);
    expect(candidate!.tier).toBe('A');
    expect(candidate!.chain.reachesResult).toBe(true);
  });

  it('places a decisive, never-reversed transition toward the actual winner in Tier A (the resignation shape)', () => {
    // Nothing forcibly links the losing move to the moment the player
    // resigned, but it is still why the game ended that way.
    const exceptions = new Map([[45, { before: 294, after: -283 }]]);
    for (let p = 46; p <= 70; p++) exceptions.set(p, { before: -283, after: -544 });
    const analysis = levelGame(70, exceptions);
    const tp = turningPoint(45, 'decisive-swing', causeConsequence(45, { evaluationConsequence: { atPly: 46, swingCp: -577 } }), 677);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(70) });
    const outcome = unknownOutcome({
      result: '0-1',
      termination: 'resignation',
      finalEvaluation: { kind: 'cp', cp: -544 },
      source: 'termination-tag',
      confidence: 0.9
    });

    const [candidate] = buildStoryCandidates(understanding, analysis, outcome);
    expect(candidate!.tier).toBe('A');
  });

  it('places a locally striking event with no downstream consequence in Tier C', () => {
    const analysis = levelGame(120, new Map([[62, { before: -69, after: 583 }]]));
    const tp = turningPoint(62, 'decisive-swing', causeConsequence(62), 752);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(120) });
    const outcome = unknownOutcome({ result: '1/2-1/2', termination: 'timeout-vs-insufficient-material', source: 'termination-tag' });

    const [candidate] = buildStoryCandidates(understanding, analysis, outcome);
    expect(candidate!.tier).toBe('C');
  });
});

describe('GATE 3 — ordering', () => {
  const base = {
    ply: 1,
    admissible: true,
    persistencePlies: 0,
    mateStrength: 0,
    materialMagnitude: 0,
    significanceScore: 0,
    notes: [] as readonly string[],
    turningPoint: turningPoint(1, 'decisive-swing', causeConsequence(1), 0),
    chain: { triggerPly: 1, antecedents: [], consequents: [], payoff: { kind: 'unresolved' as const }, reachesResult: false, evidence: { basis: 'chess-rule' as const, sourcePlies: [1], note: '' } }
  };

  it('tier ALWAYS outranks significance, however large the score', () => {
    const tierC = { ...base, tier: 'C' as const, significanceScore: 100000 };
    const tierB = { ...base, tier: 'B' as const, significanceScore: 1 };
    const tierA = { ...base, tier: 'A' as const, significanceScore: 0 };

    const sorted = [tierC, tierB, tierA].sort(compareCandidates);
    expect(sorted.map((c) => c.tier)).toEqual(['A', 'B', 'C']);
  });

  it('is lexicographic, not additive: a lower criterion never rescues a higher one', () => {
    const reachesResult = { ...base, tier: 'A' as const, chain: { ...base.chain, reachesResult: true }, significanceScore: 0 };
    const hugeScore = { ...base, tier: 'A' as const, significanceScore: 99999 };
    expect([hugeScore, reachesResult].sort(compareCandidates)[0]).toBe(reachesResult);
  });

  it('falls through to significance only once every earlier criterion ties', () => {
    const low = { ...base, tier: 'B' as const, significanceScore: 100 };
    const high = { ...base, tier: 'B' as const, significanceScore: 900 };
    expect([low, high].sort(compareCandidates)[0]).toBe(high);
  });

  it('is deterministic, breaking a full tie by ply ascending', () => {
    const later = { ...base, tier: 'B' as const, ply: 40 };
    const earlier = { ...base, tier: 'B' as const, ply: 4 };
    expect([later, earlier].sort(compareCandidates)[0]).toBe(earlier);
  });
});

describe('GATE 4 — abstention', () => {
  it('abstains with unsupported-outcome when a result is asserted that nothing corroborates (the game-06 shape)', () => {
    // A short fragment stopping in a level position, headed with a decisive
    // result, no termination, no terminal position.
    const analysis = levelGame(23, new Map([[21, { before: 125, after: -58 }]]));
    const tp = turningPoint(23, 'irreversible-material-loss', causeConsequence(23), 513);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(23) });
    const outcome = unknownOutcome({ result: '1-0', termination: 'absent', source: 'result-header', confidence: 0.4 });

    const selection = selectStoryCandidate(understanding, analysis, outcome, DEFAULT_STORY_SETTINGS);
    expect(selection.kind).toBe('abstain');
    if (selection.kind === 'abstain') expect(selection.reason).toBe('unsupported-outcome');
  });

  it('abstains with no-turning-points when there were no events at all', () => {
    const selection = selectStoryCandidate(understandingFrom({ plies: [] }), analysisFrom([]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    expect(selection.kind).toBe('abstain');
    if (selection.kind === 'abstain') expect(selection.reason).toBe('no-turning-points');
  });

  it('abstains with no-admissible-candidate when events existed but none survived Gate 1', () => {
    const analysis = levelGame(131, new Map([[12, { before: 0, after: 320 }]]));
    const tp = turningPoint(12, 'irreversible-material-loss', causeConsequence(12), 507);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(131) });
    // A KNOWN ending, so the unsupported-outcome branch does not apply.
    const outcome = unknownOutcome({ result: '1/2-1/2', termination: 'insufficient-material', source: 'termination-tag', confidence: 0.9 });

    const selection = selectStoryCandidate(understanding, analysis, outcome, DEFAULT_STORY_SETTINGS);
    expect(selection.kind).toBe('abstain');
    if (selection.kind === 'abstain') expect(selection.reason).toBe('no-admissible-candidate');
  });

  it('does not abstain on an unsupported outcome when a substantive candidate does exist', () => {
    // Abstention is about having nothing to say, not about the header being
    // weak. A real, persisting, material event still gets told.
    const exceptions = new Map([[10, { before: 0, after: 800 }]]);
    for (let p = 11; p <= 40; p++) exceptions.set(p, { before: 800, after: 800 });
    const analysis = levelGame(40, exceptions);
    const tp = turningPoint(
      10,
      'irreversible-material-loss',
      causeConsequence(10, { materialConsequence: { atPly: 10, netMaterialChange: 900 } }),
      600
    );
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(40) });
    const outcome = unknownOutcome({ result: '1-0', termination: 'absent', source: 'result-header', confidence: 0.4 });

    const selection = selectStoryCandidate(understanding, analysis, outcome, DEFAULT_STORY_SETTINGS);
    expect(selection.kind).toBe('selected');
  });
});

describe('separation of detection from selection', () => {
  it('never suppresses a genuine event at detection time, even one it will reject', () => {
    // Recall lost at detection is lost forever. The big swing is still a
    // candidate — it just does not win.
    const analysis = levelGame(120, new Map([[62, { before: -69, after: 583 }]]));
    const tp = turningPoint(62, 'decisive-swing', causeConsequence(62), 752);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp], gameArc: flatTrajectory(120) });

    const candidates = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.ply).toBe(62);
    expect(candidates[0]!.significanceScore).toBe(752);
    expect(candidates[0]!.admissible).toBe(false);
  });

  it('builds every candidate its chain BEFORE selecting, so chain quality can inform the choice', () => {
    const analysis = levelGame(30);
    const understanding = understandingFrom({
      plies: [],
      turningPoints: [
        turningPoint(5, 'decisive-swing', causeConsequence(5), 100),
        turningPoint(15, 'decisive-swing', causeConsequence(15), 200)
      ],
      gameArc: flatTrajectory(30)
    });

    const candidates = buildStoryCandidates(understanding, analysis, unknownOutcome());
    expect(candidates.map((c) => c.chain.triggerPly)).toEqual([5, 15]);
  });
});
