import { describe, expect, it } from 'vitest';
import { buildPieceContributions } from './pieceContribution';
import { gameFrom, move, tacticalMotif, understandingFrom } from './storyFixtures';
import type { ArchetypeSignal, StoryBeat } from './types';

describe('buildPieceContributions', () => {
  it('tallies spine events, motifs, capture and promotion flags, and includes archetype-only pieces at spineEventCount 0', () => {
    const game = gameFrom([
      move(1, { pieceId: 'w-n-g1', from: 'g1', to: 'f3' }),
      move(3, { pieceId: 'w-n-g1', from: 'f3', to: 'e5', capturedPieceId: 'b-p-e7' }),
      move(5, { pieceId: 'w-p-h2', from: 'h2', to: 'h4' })
    ]);

    const motif = tacticalMotif('motif-3-0', 3, 'fork', 'e5', ['d7', 'f7']);
    const understanding = understandingFrom({ plies: [], motifs: [motif] });

    const climaxBeat: StoryBeat = { id: 'beat-climax-3', role: 'climax', plies: [3], evidenceRefs: {}, salience: 400 };
    const archetypeSignal: ArchetypeSignal = {
      archetype: 'pawn-journey',
      plies: [5],
      beatIds: [],
      evidence: { basis: 'chess-rule', sourcePlies: [5], note: 'fixture' }
    };

    const result = buildPieceContributions(game, understanding, [climaxBeat], [archetypeSignal]);

    expect(result.map((p) => p.pieceId)).toEqual(['b-p-e7', 'w-n-g1', 'w-p-h2']);

    const knight = result.find((p) => p.pieceId === 'w-n-g1')!;
    expect(knight.spineEventCount).toBe(1);
    expect(knight.motifIds).toEqual(['motif-3-0']);
    expect(knight.wasCaptured).toBe(false);
    expect(knight.wasPromoted).toBe(false);

    const capturedPawn = result.find((p) => p.pieceId === 'b-p-e7')!;
    expect(capturedPawn.spineEventCount).toBe(1);
    expect(capturedPawn.wasCaptured).toBe(true);

    const journeyPawn = result.find((p) => p.pieceId === 'w-p-h2')!;
    expect(journeyPawn.spineEventCount).toBe(0);
    expect(journeyPawn.motifIds).toEqual([]);
  });

  it('flags wasPromoted from the full game history, not just spine/archetype plies', () => {
    const game = gameFrom([
      move(1, { pieceId: 'w-p-e2', from: 'e2', to: 'e4' }),
      move(2, { pieceId: 'w-p-e2', from: 'e4', to: 'e5' }),
      move(3, { pieceId: 'w-p-e2', from: 'e5', to: 'e6', promotion: 'q' })
    ]);
    const understanding = understandingFrom({ plies: [] });
    const climaxBeat: StoryBeat = { id: 'beat-climax-1', role: 'climax', plies: [1], evidenceRefs: {}, salience: 100 };

    const result = buildPieceContributions(game, understanding, [climaxBeat], []);
    const pawn = result.find((p) => p.pieceId === 'w-p-e2')!;
    expect(pawn.wasPromoted).toBe(true);
  });

  it('excludes pieces with no spine event and no archetype reference entirely', () => {
    const game = gameFrom([move(1, { pieceId: 'w-n-g1', from: 'g1', to: 'f3' }), move(2, { pieceId: 'b-n-b8', from: 'b8', to: 'c6' })]);
    const understanding = understandingFrom({ plies: [] });
    // Neither move is a spine ply and there are no archetype signals — nothing should appear.
    const result = buildPieceContributions(game, understanding, [], []);
    expect(result).toEqual([]);
  });

  it('no PieceContribution field named isHero, heroScore, or protagonistScore exists on the output', () => {
    const game = gameFrom([move(1, { pieceId: 'w-n-g1', from: 'g1', to: 'f3' })]);
    const understanding = understandingFrom({ plies: [] });
    const climaxBeat: StoryBeat = { id: 'beat-climax-1', role: 'climax', plies: [1], evidenceRefs: {}, salience: 100 };

    const result = buildPieceContributions(game, understanding, [climaxBeat], []);
    const keys = Object.keys(result[0]!);
    expect(keys).not.toContain('isHero');
    expect(keys).not.toContain('heroScore');
    expect(keys).not.toContain('protagonistScore');
    expect(keys.sort()).toEqual(['motifIds', 'pieceId', 'spineEventCount', 'wasCaptured', 'wasPromoted'].sort());
  });
});
