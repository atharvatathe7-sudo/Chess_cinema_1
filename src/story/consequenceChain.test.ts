import { describe, expect, it } from 'vitest';
import type { Evaluation, GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import {
  analysisFrom,
  causeConsequence,
  centralConflict as centralConflictFixture,
  consequenceChain as consequenceChainFixture,
  forcedSequence,
  plyAnalysis,
  tacticalMotif,
  turningPoint,
  understandingFrom,
  unknownOutcome
} from './storyFixtures';
import { buildConsequenceChain } from './consequenceChain';
import { buildConfidence } from './confidence';
import { selectCentralConflict } from './centralConflict';
import { DEFAULT_STORY_SETTINGS } from './types';

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

describe('Phase 22A — antecedent context expansion', () => {
  /**
   * A minimal move-record shim: every ply here only ever needs
   * movePlayedUci, which is all continuousForcedSequenceAntecedents and
   * tacticalContinuityAntecedents actually read off PlyAnalysis.
   */
  function ply(n: number, uci: string, overrides: Partial<PlyAnalysis> = {}): PlyAnalysis {
    return plyAnalysis(n, { movePlayedUci: uci, evaluationAfter: { kind: 'cp', cp: 0 }, evaluationBefore: { kind: 'cp', cp: 0 }, ...overrides });
  }

  it('1. a continuous run of adjacent ForcedSequences expands backward through the whole run', () => {
    // Six separate 2-ply check sequences, each ending exactly where the next
    // begins (the game_11 shape) — no gap anywhere between ply 75 and 86.
    const seqs = [
      forcedSequence('s75', [75, 76], 'check'),
      forcedSequence('s77', [77, 78], 'check'),
      forcedSequence('s79', [79, 80], 'check'),
      forcedSequence('s81', [81, 82], 'check'),
      forcedSequence('s83', [83, 84], 'check'),
      forcedSequence('s85', [85, 86], 'check')
    ];
    const understanding = understandingFrom({
      plies: [],
      sequences: seqs,
      turningPoints: [turningPoint(86, 'mate-appeared', causeConsequence(86), 900)]
    });
    const analysis = analysisFrom(Array.from({ length: 12 }, (_, i) => ply(75 + i, 'e1e2')));

    const chain = buildConsequenceChain(86, understanding, analysis, unknownOutcome());
    expect(chain.antecedents.map((l) => l.ply)).toEqual([75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85]);
    expect(chain.antecedents.every((l) => l.linkType === 'same-sequence')).toBe(true);
  });

  it('2. the merge stops the instant one ply escapes every ForcedSequence', () => {
    // Same shape, but ply 79-80's sequence is missing: 78 -> 81 is a real gap.
    const seqs = [
      forcedSequence('s75', [75, 76], 'check'),
      forcedSequence('s77', [77, 78], 'check'),
      // gap: no sequence covers 79-80
      forcedSequence('s81', [81, 82], 'check'),
      forcedSequence('s83', [83, 84], 'check'),
      forcedSequence('s85', [85, 86], 'check')
    ];
    const understanding = understandingFrom({
      plies: [],
      sequences: seqs,
      turningPoints: [turningPoint(86, 'mate-appeared', causeConsequence(86), 900)]
    });
    const analysis = analysisFrom(Array.from({ length: 12 }, (_, i) => ply(75 + i, 'e1e2')));

    const chain = buildConsequenceChain(86, understanding, analysis, unknownOutcome());
    // Only the run touching the trigger (81-86) merges; 75-78 is unreachable.
    expect(chain.antecedents.map((l) => l.ply)).toEqual([81, 82, 83, 84, 85]);
  });

  it('3. a relevant tactical motif (sharing a square with the trigger) becomes antecedent context', () => {
    // Trigger: a rook lands on b8 (skewer, attacker=b8). One ply earlier, a
    // fork's own attacker square is b7 — not touching b8 directly — but its
    // target set includes b8 itself, the exact square the trigger's motif
    // and move share.
    const triggerMotif = tacticalMotif('m-14', 14, 'skewer', 'b8', ['b5'], { squares: { attacker: 'b8', targets: ['b5'], throughSquare: 'b7' } });
    const earlierMotif = tacticalMotif('m-13', 13, 'fork', 'b7', ['a8', 'b8']);
    const understanding = understandingFrom({
      plies: [],
      motifs: [earlierMotif, triggerMotif],
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([ply(13, 'b3b5'), ply(14, 'a8b8')]);

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());
    expect(chain.antecedents.map((l) => l.ply)).toEqual([13]);
    expect(chain.antecedents[0]!.linkType).toBe('tactical-continuity');
  });

  it('4. a nearby but geometrically unrelated tactical motif is rejected', () => {
    // Same trigger as above, but the earlier motif lives entirely on the
    // other side of the board (h-file) and shares no square with anything
    // the trigger touches.
    const triggerMotif = tacticalMotif('m-14', 14, 'skewer', 'b8', ['b5'], { squares: { attacker: 'b8', targets: ['b5'], throughSquare: 'b7' } });
    const unrelatedMotif = tacticalMotif('m-13', 13, 'pin', 'h3', ['h7'], { squares: { attacker: 'h3', targets: ['h7'], throughSquare: 'h5' } });
    const understanding = understandingFrom({
      plies: [],
      motifs: [unrelatedMotif, triggerMotif],
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([ply(13, 'g2h3'), ply(14, 'a8b8')]);

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());
    expect(chain.antecedents).toEqual([]);
  });

  it('5. continuity through a piece that stays on its own square until the trigger move itself', () => {
    // A battery's attacker square (a8) is exactly the square the trigger's
    // OWN move departs from one ply later — the same piece sitting still,
    // then finally moving. This is how a lingering rook/queen becomes
    // legitimate antecedent context without ever needing a general
    // occupancy-by-square resolver: the trigger's own "from" square already
    // tells us who was standing there.
    const earlierMotif = tacticalMotif('m-13', 13, 'battery', 'a8', ['d8']);
    const understanding = understandingFrom({
      plies: [],
      motifs: [earlierMotif],
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([ply(13, 'a1a8'), ply(14, 'a8b8')]);

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());
    // ply 13's battery shares square a8 with the trigger's own move (a8->b8).
    expect(chain.antecedents.map((l) => l.ply)).toContain(13);
  });

  it('6. a shared target square alone (no shared attacker) is sufficient continuity', () => {
    const triggerMotif = tacticalMotif('m-20', 20, 'fork', 'd5', ['e7']);
    const earlierMotif = tacticalMotif('m-19', 19, 'pin', 'c6', ['e7'], { squares: { attacker: 'c6', targets: ['e7'], throughSquare: 'd7' } });
    const understanding = understandingFrom({
      plies: [],
      motifs: [earlierMotif, triggerMotif],
      turningPoints: [turningPoint(20, 'decisive-swing', causeConsequence(20, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([ply(19, 'b5c6'), ply(20, 'c3d5')]);

    const chain = buildConsequenceChain(20, understanding, analysis, unknownOutcome());
    expect(chain.antecedents.map((l) => l.ply)).toEqual([19]);
  });

  it('7. richer antecedent context never changes mechanism verification', () => {
    const richMotifs = [
      tacticalMotif('m-11', 11, 'fork', 'b7', ['a8', 'b8']),
      tacticalMotif('m-12', 12, 'battery', 'a8', ['d8']),
      tacticalMotif('m-13', 13, 'fork', 'b7', ['a8', 'd7']),
      tacticalMotif('m-14', 14, 'skewer', 'b8', ['b5'], { squares: { attacker: 'b8', targets: ['b5'], throughSquare: 'b7' } })
    ];
    const cc = causeConsequence(14, { mechanism: null, mechanismVerified: false });
    const understanding = understandingFrom({
      plies: [],
      motifs: richMotifs,
      turningPoints: [turningPoint(14, 'decisive-swing', cc, 400)]
    });
    const analysis = analysisFrom([ply(11, 'b3b7'), ply(12, 'b8d7'), ply(13, 'd7b5'), ply(14, 'a8b8')]);

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());
    // The chain grew richer antecedents, but the turningPoint's own mechanism
    // fixture (untouched by this module) is still exactly what was given.
    expect(chain.antecedents.length).toBeGreaterThan(0);
    expect(cc.mechanism).toBeNull();
    expect(cc.mechanismVerified).toBe(false);
  });

  it('8. richer antecedent context never creates causalClaimAllowed', () => {
    const cc = causeConsequence(14, { mechanism: null, mechanismVerified: false, resolution: 'unresolved' });
    const tp = turningPoint(14, 'decisive-swing', cc, 400);
    const sparse = centralConflictFixture('tp-14', 14, { consequenceChain: consequenceChainFixture(14) });
    const rich = centralConflictFixture('tp-14', 14, {
      consequenceChain: consequenceChainFixture(14, {
        antecedents: [
          { ply: 11, linkType: 'tactical-continuity', evidenceId: 'm-11' },
          { ply: 12, linkType: 'tactical-continuity', evidenceId: 'm-12' },
          { ply: 13, linkType: 'tactical-continuity', evidenceId: 'm-13' }
        ]
      })
    });
    const understanding = understandingFrom({ plies: [], turningPoints: [tp] });

    const confSparse = buildConfidence(sparse, understanding, undefined);
    const confRich = buildConfidence(rich, understanding, undefined);
    expect(confRich.causalClaimAllowed).toBe(false);
    expect(confRich).toEqual(confSparse);
  });

  it('9. game_11-style continuous forcing run combined with one extra tactical-continuity ply', () => {
    const seqs = [
      forcedSequence('s75', [75, 76], 'check'),
      forcedSequence('s77', [77, 78], 'check'),
      forcedSequence('s79', [79, 80], 'check'),
      forcedSequence('s81', [81, 82], 'check'),
      forcedSequence('s83', [83, 84], 'check'),
      forcedSequence('s85', [85, 86], 'check')
    ];
    const motifAt74 = tacticalMotif('m-74', 74, 'battery', 'a8', ['b8']);
    const motifAt75 = tacticalMotif('m-75', 75, 'battery', 'b8', ['a8']);
    const understanding = understandingFrom({
      plies: [],
      sequences: seqs,
      motifs: [motifAt74, motifAt75],
      turningPoints: [turningPoint(86, 'mate-appeared', causeConsequence(86), 900)]
    });
    const analysis = analysisFrom(Array.from({ length: 13 }, (_, i) => ply(74 + i, 'e1e2')));

    const chain = buildConsequenceChain(86, understanding, analysis, unknownOutcome());
    expect(chain.antecedents.map((l) => l.ply)).toEqual([74, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85]);
    expect(chain.antecedents.find((l) => l.ply === 74)!.linkType).toBe('tactical-continuity');
  });

  it('10. game_13-style tactical buildup: a chain of forks/skewers/batteries sharing squares expands the window', () => {
    const motifs = [
      tacticalMotif('m-11', 11, 'fork', 'b7', ['a8', 'b8']),
      tacticalMotif('m-12', 12, 'battery', 'a8', ['d8']),
      tacticalMotif('m-13', 13, 'fork', 'b7', ['a8', 'd7']),
      tacticalMotif('m-14', 14, 'skewer', 'b8', ['b5'], { squares: { attacker: 'b8', targets: ['b5'], throughSquare: 'b7' } })
    ];
    const understanding = understandingFrom({
      plies: [],
      motifs,
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([ply(11, 'b3b7'), ply(12, 'b8d7'), ply(13, 'd7b5'), ply(14, 'a8b8')]);

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());
    expect(chain.antecedents.map((l) => l.ply)).toEqual([11, 12, 13]);
  });

  it('11. game_14-style dense-but-mostly-irrelevant motif environment stays selective', () => {
    // A long-lived, unrelated back-rank battery re-detected on every ply from
    // 6 through 40 (queenside), plus the real, square-connected combination
    // immediately before the trigger (42-46). Only the connected run must
    // survive, never the persistent unrelated one.
    const distractionMotifs = Array.from({ length: 35 }, (_, i) => {
      const p = 6 + i;
      return tacticalMotif(`m-distraction-${p}`, p, 'battery', 'a1', ['d1'], { firstSeenPly: 6 });
    });
    const realMotifs = [
      tacticalMotif('m-42', 42, 'pin', 'd8', ['d2'], { squares: { attacker: 'd8', targets: ['d2'], throughSquare: 'd4' } }),
      tacticalMotif('m-43', 43, 'battery', 'e2', ['e1'], { squares: { attacker: 'e2', targets: ['e1'], throughSquare: 'e1' } }),
      tacticalMotif('m-44', 44, 'skewer', 'd2', ['g2'], { squares: { attacker: 'd2', targets: ['g2'], throughSquare: 'e2' } })
    ];
    const seqs = [forcedSequence('s44', [44, 45], 'material-forced-recapture'), forcedSequence('s46', [46, 47], 'check')];
    const understanding = understandingFrom({
      plies: [],
      sequences: seqs,
      motifs: [...distractionMotifs, ...realMotifs],
      turningPoints: [turningPoint(47, 'decisive-swing', causeConsequence(47), 400)]
    });
    const analysis = analysisFrom(Array.from({ length: 42 }, (_, i) => ply(6 + i, 'e1f1')));

    const chain = buildConsequenceChain(47, understanding, analysis, unknownOutcome());
    const plies = chain.antecedents.map((l) => l.ply);
    expect(plies).toEqual([42, 43, 44, 45, 46]);
    // None of the distraction plies (6-41) leaked in, despite sharing
    // squares with each other for the whole game.
    expect(plies.some((p) => p < 42)).toBe(false);
  });

  it('12. no-conflict abstention is unaffected by antecedent-context expansion', () => {
    const result = selectCentralConflict(understandingFrom({ plies: [] }), analysisFrom([]), unknownOutcome(), DEFAULT_STORY_SETTINGS);
    expect(result.centralConflict).toBeNull();
    expect(result.noConflictReason).toBe('no-turning-points');
  });
});
