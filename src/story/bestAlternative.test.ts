import { describe, expect, it } from 'vitest';
import { buildExplanationOpportunities } from './bestAlternative';
import { bestAlternative, causeConsequence, turningPoint, understandingFrom } from './storyFixtures';

describe('buildExplanationOpportunities', () => {
  it('reports clear-best-move when a unique alternative existed and the player did not play it', () => {
    const ba = bestAlternative({ bestMoveUniqueness: 'unique', playedMoveWasTopMove: false });
    const cc = causeConsequence(3, { bestAlternative: ba });
    const tp = turningPoint(3, 'decisive-swing', cc, 200);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = buildExplanationOpportunities(understanding);
    expect(result).toEqual([{ ply: 3, kind: 'clear-best-move', causeConsequenceId: 'cc-3' }]);
  });

  it('reports only-good-move when the unique best move was played under pressure', () => {
    const ba = bestAlternative({ bestMoveUniqueness: 'unique', playedMoveWasTopMove: true });
    const cc = causeConsequence(4, { bestAlternative: ba });
    const tp = turningPoint(4, 'decisive-swing', cc, 200, ['only-move-under-pressure']);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = buildExplanationOpportunities(understanding);
    expect(result).toEqual([{ ply: 4, kind: 'only-good-move', causeConsequenceId: 'cc-4' }]);
  });

  it('reports nothing for a unique, played, non-pressured move rather than mislabeling it', () => {
    const ba = bestAlternative({ bestMoveUniqueness: 'unique', playedMoveWasTopMove: true });
    const cc = causeConsequence(5, { bestAlternative: ba });
    const tp = turningPoint(5, 'decisive-swing', cc, 200, []);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    expect(buildExplanationOpportunities(understanding)).toEqual([]);
  });

  it('reports multiple-equivalent-options for shared uniqueness, never singling out topMove as uniquely correct', () => {
    const ba = bestAlternative({
      bestMoveUniqueness: 'shared',
      playedMoveWasTopMove: false,
      alternativesConsidered: [
        { rank: 1, moveUci: 'a2a3', principalVariation: ['a2a3'], evaluation: { kind: 'cp', cp: 50 }, deltaFromTopCp: 0 },
        { rank: 2, moveUci: 'b2b3', principalVariation: ['b2b3'], evaluation: { kind: 'cp', cp: 40 }, deltaFromTopCp: 10 }
      ]
    });
    const cc = causeConsequence(6, { bestAlternative: ba });
    const tp = turningPoint(6, 'decisive-swing', cc, 200);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = buildExplanationOpportunities(understanding);
    expect(result).toEqual([{ ply: 6, kind: 'multiple-equivalent-options', causeConsequenceId: 'cc-6' }]);
  });

  it('reports insufficient-data for unknown uniqueness, never inferring uniqueness either way', () => {
    const ba = bestAlternative({ bestMoveUniqueness: 'unknown' });
    const cc = causeConsequence(7, { bestAlternative: ba });
    const tp = turningPoint(7, 'decisive-swing', cc, 200);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const result = buildExplanationOpportunities(understanding);
    expect(result).toEqual([{ ply: 7, kind: 'insufficient-data', causeConsequenceId: 'cc-7' }]);
  });

  it('orders results by ply ascending regardless of turningPoints input order', () => {
    const tp9 = turningPoint(9, 'decisive-swing', causeConsequence(9, { bestAlternative: bestAlternative({ bestMoveUniqueness: 'shared' }) }), 100);
    const tp2 = turningPoint(2, 'decisive-swing', causeConsequence(2, { bestAlternative: bestAlternative({ bestMoveUniqueness: 'shared' }) }), 100);
    const understanding = understandingFrom({ plies: [], turningPoints: [tp9, tp2] });

    const result = buildExplanationOpportunities(understanding);
    expect(result.map((r) => r.ply)).toEqual([2, 9]);
  });
});
