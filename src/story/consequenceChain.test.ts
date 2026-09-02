import { describe, expect, it } from 'vitest';
import type { Evaluation, GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import { analysisFrom, causeConsequence, forcedSequence, plyAnalysis, turningPoint, understandingFrom, unknownOutcome } from './storyFixtures';
import { buildConsequenceChain } from './consequenceChain';

/**
 * Phase 15 (M6) — directional consequence chains.
 *
 * These reproduce the structural shapes the benchmark surfaced, without
 * keying on any game number or SAN string: a climax whose mate lands three
 * plies later, a check that forces a reply into a stalemate, and a game
 * whose board and recorded result disagree.
 */

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function plies(specs: readonly { ply: number; evaluationAfter: Evaluation }[]): PlyAnalysis[] {
  return specs.map((s) => plyAnalysis(s.ply, { fenAfter: FEN, evaluationAfter: s.evaluationAfter }));
}

function understandingWith(triggerPly: number, overrides: Parameters<typeof causeConsequence>[1] = {}): GameUnderstanding {
  return understandingFrom({
    plies: [],
    turningPoints: [turningPoint(triggerPly, 'mate-appeared', causeConsequence(triggerPly, overrides), 900)]
  });
}

describe('mate-transition continuity', () => {
  /**
   * The shape: a move after which a forced mate stands for one side, and the
   * mate is then delivered a few plies later. The old model could not link
   * these at all, so the mate arrived as an unrelated terminal annotation.
   */
  it('carries a chain from a mate-appeared trigger through to the mate that delivers it', () => {
    const analysis = analysisFrom(
      plies([
        { ply: 52, evaluationAfter: { kind: 'mate', mateIn: 3 } },
        { ply: 53, evaluationAfter: { kind: 'mate', mateIn: 2 } },
        { ply: 54, evaluationAfter: { kind: 'mate', mateIn: 1 } },
        { ply: 55, evaluationAfter: { kind: 'terminal', result: 'white-wins' } }
      ])
    );
    const outcome = unknownOutcome({
      result: '1-0',
      termination: 'checkmate',
      onBoard: true,
      finalEvaluation: { kind: 'terminal', result: 'white-wins' },
      source: 'engine-terminal',
      confidence: 1
    });

    const chain = buildConsequenceChain(52, understandingWith(52), analysis, outcome);

    expect(chain.triggerPly).toBe(52);
    expect(chain.consequents.map((l) => l.ply)).toEqual([53, 54, 55]);
    expect(chain.payoff).toEqual({ kind: 'checkmate', atPly: 55 });
    expect(chain.reachesResult).toBe(true);
  });

  it('stops the moment the mate changes hands, rather than walking to the end regardless', () => {
    const analysis = analysisFrom(
      plies([
        { ply: 52, evaluationAfter: { kind: 'mate', mateIn: 3 } },
        { ply: 53, evaluationAfter: { kind: 'mate', mateIn: 2 } },
        // The mate flips to the other side: nothing after this followed from
        // the trigger.
        { ply: 54, evaluationAfter: { kind: 'mate', mateIn: -4 } },
        { ply: 55, evaluationAfter: { kind: 'mate', mateIn: -1 } }
      ])
    );

    const chain = buildConsequenceChain(52, understandingWith(52), analysis, unknownOutcome());
    expect(chain.consequents.map((l) => l.ply)).toEqual([53]);
    expect(chain.reachesResult).toBe(false);
  });
});

describe('terminal arrival', () => {
  /**
   * The shape: a check forces a reply, and the position immediately after
   * that reply is a stalemate. The stalemate is outside the forcing
   * sequence, so only terminal arrival can reach it.
   */
  it('reaches a stalemate that sits one ply past the forced sequence', () => {
    const analysis = analysisFrom(
      plies([
        { ply: 116, evaluationAfter: { kind: 'cp', cp: 0 } },
        { ply: 117, evaluationAfter: { kind: 'cp', cp: 0 } },
        { ply: 118, evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' } }
      ])
    );
    const seq = forcedSequence('sequence-20', [116, 117], 'check');
    const understanding = understandingFrom({
      plies: [],
      sequences: [seq],
      turningPoints: [
        turningPoint(116, 'decisive-swing', causeConsequence(116, { multiMoveConsequence: { sequenceId: 'sequence-20', endPly: 117 } }), 1100)
      ]
    });
    const outcome = unknownOutcome({
      result: '1/2-1/2',
      termination: 'stalemate',
      onBoard: true,
      finalEvaluation: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' },
      source: 'engine-terminal',
      confidence: 1
    });

    const chain = buildConsequenceChain(116, understanding, analysis, outcome);

    expect(chain.consequents.map((l) => l.ply)).toEqual([117, 118]);
    expect(chain.payoff).toEqual({ kind: 'stalemate', atPly: 118 });
    expect(chain.reachesResult).toBe(true);
  });
});

describe('off-board result arrival', () => {
  /**
   * The shape: the board says one thing and the recorded result says
   * another. Both must survive into the payoff, or the ending cannot be
   * narrated honestly.
   */
  it('represents a board/result divergence rather than dropping either fact', () => {
    const analysis = analysisFrom(
      plies([
        { ply: 111, evaluationAfter: { kind: 'mate', mateIn: 5 } },
        { ply: 112, evaluationAfter: { kind: 'mate', mateIn: 4 } },
        { ply: 113, evaluationAfter: { kind: 'mate', mateIn: 2 } }
      ])
    );
    const outcome = unknownOutcome({
      result: '1/2-1/2',
      termination: 'timeout-vs-insufficient-material',
      onBoard: false,
      finalEvaluation: { kind: 'mate', mateIn: 2 },
      source: 'termination-tag',
      confidence: 0.9
    });

    const chain = buildConsequenceChain(111, understandingWith(111), analysis, outcome);

    expect(chain.reachesResult).toBe(true);
    expect(chain.payoff).toEqual({
      kind: 'off-board-result',
      result: '1/2-1/2',
      termination: 'timeout-vs-insufficient-material'
    });
  });

  it('does NOT let an off-board ending make an unrelated trigger reach the result', () => {
    // An early, self-contained event in a game that later ended by
    // resignation. Nothing links it to the ending, so it must not be
    // credited with explaining one — otherwise every candidate in every
    // resigned game would tie at the top tier.
    const analysis = analysisFrom(
      plies([
        { ply: 12, evaluationAfter: { kind: 'cp', cp: 10 } },
        { ply: 13, evaluationAfter: { kind: 'cp', cp: 5 } },
        { ply: 40, evaluationAfter: { kind: 'cp', cp: -500 } }
      ])
    );
    const outcome = unknownOutcome({ result: '0-1', termination: 'resignation', source: 'termination-tag', confidence: 0.9 });

    const chain = buildConsequenceChain(12, understandingFrom({
      plies: [],
      turningPoints: [turningPoint(12, 'decisive-swing', causeConsequence(12), 507)]
    }), analysis, outcome);

    expect(chain.reachesResult).toBe(false);
    expect(chain.payoff.kind).not.toBe('off-board-result');
  });
});

describe('direction', () => {
  it('splits links strictly into antecedents (before) and consequents (after)', () => {
    const seq = forcedSequence('seq-x', [8, 9, 10, 11], 'check');
    const understanding = understandingFrom({
      plies: [],
      sequences: [seq],
      turningPoints: [turningPoint(10, 'decisive-swing', causeConsequence(10), 400)]
    });
    const analysis = analysisFrom(plies([8, 9, 10, 11].map((p) => ({ ply: p, evaluationAfter: { kind: 'cp', cp: 0 } as Evaluation }))));

    const chain = buildConsequenceChain(10, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.every((l) => l.ply < 10)).toBe(true);
    expect(chain.consequents.every((l) => l.ply > 10)).toBe(true);
    expect(chain.antecedents.map((l) => l.ply)).toEqual([8, 9]);
    expect(chain.consequents.map((l) => l.ply)).toEqual([11]);
  });

  it('settles on a material payoff when a real consequence exists but the result is not reached', () => {
    const analysis = analysisFrom(plies([{ ply: 20, evaluationAfter: { kind: 'cp', cp: 300 } }, { ply: 40, evaluationAfter: { kind: 'cp', cp: 300 } }]));
    const understanding = understandingFrom({
      plies: [],
      turningPoints: [
        turningPoint(20, 'irreversible-material-loss', causeConsequence(20, { materialConsequence: { atPly: 20, netMaterialChange: 900 } }), 500)
      ]
    });

    const chain = buildConsequenceChain(20, understanding, analysis, unknownOutcome());
    expect(chain.reachesResult).toBe(false);
    expect(chain.payoff).toEqual({ kind: 'material-settled', atPly: 20, netMaterialChange: 900 });
  });

  it('reports unresolved when nothing followed and nothing settled', () => {
    const analysis = analysisFrom(plies([{ ply: 5, evaluationAfter: { kind: 'cp', cp: 5 } }, { ply: 40, evaluationAfter: { kind: 'cp', cp: 5 } }]));
    const understanding = understandingFrom({ plies: [], turningPoints: [turningPoint(5, 'decisive-swing', causeConsequence(5), 200)] });

    const chain = buildConsequenceChain(5, understanding, analysis, unknownOutcome());
    expect(chain.payoff).toEqual({ kind: 'unresolved' });
    expect(chain.consequents).toEqual([]);
  });
});

describe('an unsupported ending is not a payoff', () => {
  it('does not claim an off-board result when nothing says how the game ended', () => {
    // Running out of plies is not the same as arriving at a result. A PGN
    // that records "1-0" with no terminal position and no termination reason
    // is indistinguishable from a truncated import, so the chain must not
    // acquire an 'off-board-result' payoff — nor count as explaining one.
    const analysis = analysisFrom(
      plies([
        { ply: 21, evaluationAfter: { kind: 'cp', cp: -58 } },
        { ply: 22, evaluationAfter: { kind: 'cp', cp: -30 } },
        { ply: 23, evaluationAfter: { kind: 'cp', cp: -20 } }
      ])
    );
    const seq = forcedSequence('seq-u', [21, 22, 23], 'check');
    const understanding = understandingFrom({
      plies: [],
      sequences: [seq],
      turningPoints: [turningPoint(21, 'decisive-swing', causeConsequence(21), 500)]
    });
    const outcome = unknownOutcome({ result: '1-0', termination: 'absent', source: 'result-header', confidence: 0.4 });

    const chain = buildConsequenceChain(21, understanding, analysis, outcome);
    expect(chain.payoff.kind).not.toBe('off-board-result');
    expect(chain.reachesResult).toBe(false);
  });

  it('still claims an off-board result when the termination IS known', () => {
    // Same shape, but the chain genuinely carries to the last ply (a forced
    // sequence) AND the PGN says how the game ended.
    const analysis = analysisFrom(
      plies([
        { ply: 21, evaluationAfter: { kind: 'cp', cp: -58 } },
        { ply: 22, evaluationAfter: { kind: 'cp', cp: -30 } },
        { ply: 23, evaluationAfter: { kind: 'cp', cp: -20 } }
      ])
    );
    const seq = forcedSequence('seq-r', [21, 22, 23], 'check');
    const understanding = understandingFrom({
      plies: [],
      sequences: [seq],
      turningPoints: [turningPoint(21, 'decisive-swing', causeConsequence(21), 500)]
    });
    const outcome = unknownOutcome({ result: '1-0', termination: 'resignation', source: 'termination-tag', confidence: 0.9 });

    const chain = buildConsequenceChain(21, understanding, analysis, outcome);
    expect(chain.payoff.kind).toBe('off-board-result');
    expect(chain.reachesResult).toBe(true);
  });
});
