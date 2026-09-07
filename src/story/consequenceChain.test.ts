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
  threatRecord,
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

describe('Phase 23A — single-use unrefuted-threat bridge', () => {
  /**
   * The game_13 shape, reproduced structurally: a queen creates a material-
   * winning threat on b7 (ply 9), the reply doesn't address it (ply 10, the
   * bridge), and the earliest already-established antecedent (ply 11) is
   * exactly the move that cashes the threat in. Ply 11-13 are already
   * antecedents via Phase 22A's own tactical-continuity walk (unchanged from
   * that phase's own test fixture), so this isolates the ONE new thing
   * Phase 23A adds: reaching back through the otherwise-unsupported ply 10.
   */
  const FORK_11 = tacticalMotif('m-11', 11, 'fork', 'b7', ['a8', 'b8']);
  const BATTERY_12 = tacticalMotif('m-12', 12, 'battery', 'a8', ['d8']);
  const FORK_13 = tacticalMotif('m-13', 13, 'fork', 'b7', ['a8', 'd7']);
  const SKEWER_14 = tacticalMotif('m-14', 14, 'skewer', 'b8', ['b5'], {
    squares: { attacker: 'b8', targets: ['b5'], throughSquare: 'b7' }
  });

  function bridgeFixture(overrides: {
    threats?: readonly ReturnType<typeof threatRecord>[];
    analysisOverrides?: Partial<Record<number, Partial<PlyAnalysis>>>;
  }) {
    const understanding = understandingFrom({
      plies: [],
      motifs: [FORK_11, BATTERY_12, FORK_13, SKEWER_14],
      threats: overrides.threats ?? [],
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const base: Record<number, { movePlayedUci: string }> = {
      9: { movePlayedUci: 'd1b3' },
      10: { movePlayedUci: 'g8f6' },
      11: { movePlayedUci: 'b3b7' },
      12: { movePlayedUci: 'b8d7' },
      13: { movePlayedUci: 'd7b5' },
      14: { movePlayedUci: 'a8b8' }
    };
    const analysis = analysisFrom(
      Object.entries(base).map(([n, spec]) =>
        plyAnalysis(Number(n), { fenBefore: FEN, ...spec, ...(overrides.analysisOverrides?.[Number(n)] ?? {}) })
      )
    );
    return { understanding, analysis };
  }

  it('1-5. positive: unrefuted threat survives the one quiet ply and is realized by the existing antecedent boundary', () => {
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const { understanding, analysis } = bridgeFixture({ threats: [threat] });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([9, 10, 11, 12, 13]);
    const bridge = chain.antecedents.filter((l) => l.linkType === 'unrefuted-threat-bridge');
    expect(bridge.map((l) => l.ply)).toEqual([9, 10]);
    expect(bridge.every((l) => l.evidenceId === 'threat-9-0')).toBe(true);
  });

  it('6. negative: threat refuted on the quiet ply itself blocks the bridge', () => {
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', {
      targetPiece: 'p',
      netMaterialIfExecuted: 100,
      refutedBy: { ply: 10, moveUci: 'g8f6' }
    });
    const { understanding, analysis } = bridgeFixture({ threats: [threat] });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([11, 12, 13]);
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(false);
  });

  it('7. negative: the boundary move does not realize the threat (different destination square) blocks the bridge', () => {
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const { understanding, analysis } = bridgeFixture({
      threats: [threat],
      analysisOverrides: { 11: { movePlayedUci: 'b3c4' } }
    });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([11, 12, 13]);
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(false);
  });

  it('8. negative: threat/target mismatch (wrong target square) blocks the bridge', () => {
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'c6', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const { understanding, analysis } = bridgeFixture({ threats: [threat] });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([11, 12, 13]);
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(false);
  });

  it('9. negative: square overlap alone (no ThreatRecord at all) never fires the bridge', () => {
    const { understanding, analysis } = bridgeFixture({ threats: [] });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    // Phase 22A's own tactical-continuity walk still applies (unchanged),
    // but nothing reaches ply 9 or 10 without an actual ThreatRecord.
    expect(chain.antecedents.map((l) => l.ply)).toEqual([11, 12, 13]);
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(false);
  });

  it('10. negative: temporal adjacency alone (a move exists, but no threat and no motif) never invents a bridge', () => {
    // A single forced-sequence antecedent, nothing else nearby at all.
    const seq = forcedSequence('seq-a', [10, 11], 'check');
    const understanding = understandingFrom({
      plies: [],
      sequences: [seq],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([
      plyAnalysis(9, { movePlayedUci: 'e2e4', fenBefore: FEN }),
      plyAnalysis(10, { movePlayedUci: 'e7e5', fenBefore: FEN }),
      plyAnalysis(11, { movePlayedUci: 'g1f3', fenBefore: FEN })
    ]);

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([10]);
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(false);
  });

  it('11. negative: a threat two plies further back than the one candidate quiet ply is never bridged', () => {
    // The threat sits at ply 8 — one ply too early for this boundary (11),
    // which would require crossing TWO quiet plies (9 and 10), not one.
    const threat = threatRecord('threat-8-0', 8, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const { understanding, analysis } = bridgeFixture({ threats: [threat] });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([11, 12, 13]);
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(false);
  });

  it('12. negative: multiple qualifying threats at the same origin ply still produce only ONE bridge (2 links, never more)', () => {
    const threatA = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const threatB = threatRecord('threat-9-1', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 50 });
    const { understanding, analysis } = bridgeFixture({ threats: [threatA, threatB] });

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    const bridge = chain.antecedents.filter((l) => l.linkType === 'unrefuted-threat-bridge');
    expect(bridge).toHaveLength(2);
    expect(bridge.map((l) => l.ply)).toEqual([9, 10]);
  });

  it('13. negative: the bridge does not re-arm — nothing before the origin ply is ever considered, even with more qualifying evidence there', () => {
    // A second, independently-qualifying-looking threat/motif pair sits
    // immediately before the origin ply (7-8). If the mechanism re-armed,
    // it would chain straight through to ply 7; it must not.
    const earlierMotif = tacticalMotif('m-7', 7, 'battery', 'b3', ['e6']);
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const earlierThreat = threatRecord('threat-7-0', 7, 'w', 'material-winning-threat', 'e6', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const understanding = understandingFrom({
      plies: [],
      motifs: [earlierMotif, FORK_11, BATTERY_12, FORK_13, SKEWER_14],
      threats: [threat, earlierThreat],
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom([
      plyAnalysis(7, { movePlayedUci: 'f1b5', fenBefore: FEN }),
      plyAnalysis(8, { movePlayedUci: 'c6b5' }), // would "realize" threat-7-0 on e6 if it were even checked — it isn't
      plyAnalysis(9, { movePlayedUci: 'd1b3', fenBefore: FEN }),
      plyAnalysis(10, { movePlayedUci: 'g8f6', fenBefore: FEN }),
      plyAnalysis(11, { movePlayedUci: 'b3b7', fenBefore: FEN }),
      plyAnalysis(12, { movePlayedUci: 'b8d7', fenBefore: FEN }),
      plyAnalysis(13, { movePlayedUci: 'd7b5', fenBefore: FEN }),
      plyAnalysis(14, { movePlayedUci: 'a8b8', fenBefore: FEN })
    ]);

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());

    expect(chain.antecedents.map((l) => l.ply)).toEqual([9, 10, 11, 12, 13]);
    expect(chain.antecedents.some((l) => l.ply <= 8)).toBe(false);
  });

  it('does not touch mechanism, confidence, or causal-claim gating (context evidence ≠ verified causal claim)', () => {
    const cc = causeConsequence(14, { mechanism: null, mechanismVerified: false, resolution: 'unresolved' });
    const tp = turningPoint(14, 'decisive-swing', cc, 400);
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const { analysis } = bridgeFixture({ threats: [threat] });
    const understandingWithThreat = understandingFrom({
      plies: [],
      motifs: [FORK_11, BATTERY_12, FORK_13, SKEWER_14],
      threats: [threat],
      turningPoints: [tp]
    });

    const chain = buildConsequenceChain(14, understandingWithThreat, analysis, unknownOutcome());
    expect(chain.antecedents.some((l) => l.linkType === 'unrefuted-threat-bridge')).toBe(true);

    const sparse = centralConflictFixture('tp-14', 14, { consequenceChain: consequenceChainFixture(14) });
    const rich = centralConflictFixture('tp-14', 14, { consequenceChain: consequenceChainFixture(14, { antecedents: chain.antecedents }) });
    const confSparse = buildConfidence(sparse, understandingWithThreat, undefined);
    const confRich = buildConfidence(rich, understandingWithThreat, undefined);
    expect(confRich.causalClaimAllowed).toBe(false);
    expect(confRich).toEqual(confSparse);
    expect(cc.mechanism).toBeNull();
    expect(cc.mechanismVerified).toBe(false);
  });
});

describe('Phase 23C — continuous forced-sequence consequents (forward mirror of Phase 22A)', () => {
  function evalPly(n: number, cp: number, overrides: Partial<PlyAnalysis> = {}): PlyAnalysis {
    return plyAnalysis(n, { evaluationBefore: { kind: 'cp', cp }, evaluationAfter: { kind: 'cp', cp }, ...overrides });
  }

  it('1-4. positive: a ForcedSequence starting exactly at trigger.endPly+1 becomes consequent evidence, tagged adjacent-forced-sequence', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check'); // touches the trigger (11)
    const seqB = forcedSequence('seq-b', [12, 13], 'check'); // 11 + 1 === 12
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA, seqB],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([10, 11, 12, 13].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());

    expect(chain.consequents.map((l) => l.ply)).toEqual([12, 13]);
    expect(chain.consequents.every((l) => l.linkType === 'adjacent-forced-sequence')).toBe(true);
    expect(chain.consequents.every((l) => l.evidenceId === 'seq-b')).toBe(true);
  });

  it('5. multiple immediately adjacent sequences continue forward, each contributing its own evidenceId', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check');
    const seqB = forcedSequence('seq-b', [12, 13], 'check');
    const seqC = forcedSequence('seq-c', [14, 15], 'check');
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA, seqB, seqC],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([10, 11, 12, 13, 14, 15].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());

    expect(chain.consequents.map((l) => l.ply)).toEqual([12, 13, 14, 15]);
    expect(chain.consequents.find((l) => l.ply === 12)!.evidenceId).toBe('seq-b');
    expect(chain.consequents.find((l) => l.ply === 14)!.evidenceId).toBe('seq-c');
  });

  it('6. negative: a sequence starting at trigger.endPly+2 is not connected', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check');
    const seqB = forcedSequence('seq-b', [13, 14], 'check'); // 11 + 2, not +1
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA, seqB],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([10, 11, 12, 13, 14].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
  });

  it('7. negative: a sequence starting at trigger.endPly+3 is not connected', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check');
    const seqB = forcedSequence('seq-b', [14, 15], 'check'); // 11 + 3
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA, seqB],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([10, 11, 12, 13, 14, 15].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
  });

  it('8. negative: no ForcedSequence at all touches the trigger — stop, exactly Phase 23A baseline behaviour', () => {
    const understanding = understandingFrom({
      plies: [],
      sequences: [],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([11, 12].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
  });

  it('9. negative: an unrelated nearby motif is irrelevant to this extension', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check');
    const unrelatedMotif = tacticalMotif('m-12', 12, 'fork', 'h3', ['h7']);
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA],
      motifs: [unrelatedMotif],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([10, 11, 12].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
  });

  it('10. negative: square overlap alone (no adjacent ForcedSequence) does not trigger this extension — no forward tactical-continuity exists', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check');
    // ply 12's motif shares the trigger's own move-destination square, but no
    // ForcedSequence covers ply 12 at all.
    const triggerMotif = tacticalMotif('m-11', 11, 'skewer', 'b8', ['b5']);
    const laterMotif = tacticalMotif('m-12', 12, 'fork', 'b8', ['a1', 'h1']);
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA],
      motifs: [triggerMotif, laterMotif],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([
      evalPly(10, 0),
      plyAnalysis(11, { movePlayedUci: 'a8b8', evaluationBefore: { kind: 'cp', cp: 0 }, evaluationAfter: { kind: 'cp', cp: 0 } }),
      evalPly(12, 0)
    ]);

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
  });

  it('11. negative: tactical motif continuity alone, without ForcedSequence adjacency, does not trigger this extension', () => {
    // No ForcedSequence touches the trigger at all — only a geometrically
    // connected motif follows it. Mirrors the game_15-style shape Phase 23B
    // flagged as NOT safe to fold into a generic rule; this extension must
    // never reach it regardless.
    const triggerMotif = tacticalMotif('m-11', 11, 'fork', 'e4', ['f2', 'd6']);
    const followingMotif = tacticalMotif('m-12', 12, 'discovery', 'e2', ['e6'], { squares: { attacker: 'e2', targets: ['e6'], throughSquare: 'e4' } });
    const understanding = understandingFrom({
      plies: [],
      sequences: [],
      motifs: [triggerMotif, followingMotif],
      turningPoints: [turningPoint(11, 'decisive-swing', causeConsequence(11), 400)]
    });
    const analysis = analysisFrom([evalPly(11, 0), evalPly(12, 0)]);

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
  });

  it('12. game_15-style final-ply consequence is never pulled in by this rule absent real ForcedSequence adjacency', () => {
    const understanding = understandingFrom({
      plies: [],
      sequences: [],
      turningPoints: [turningPoint(42, 'decisive-swing', causeConsequence(42, { evaluationConsequence: { atPly: 42, swingCp: -659 } }), 400)]
    });
    const analysis = analysisFrom([evalPly(42, -659), evalPly(43, -659)]);

    const chain = buildConsequenceChain(42, understanding, analysis, unknownOutcome());
    expect(chain.consequents).toEqual([]);
    expect(chain.payoff).toEqual({ kind: 'eval-settled', atPly: 42, finalSwingCp: -659 });
  });

  it('13. game_11 shape regression: sequence 85-86 (trigger) + adjacent sequence 87-88 → consequents [87,88], payoff untouched', () => {
    const seq1 = forcedSequence('sequence-11', [85, 86], 'check');
    const seq2 = forcedSequence('sequence-12', [87, 88], 'check');
    const cc = causeConsequence(86, { evaluationConsequence: { atPly: 86, swingCp: -307 } });
    const understanding = understandingFrom({
      plies: [],
      sequences: [seq1, seq2],
      turningPoints: [turningPoint(86, 'mate-appeared', cc, 907)]
    });
    // lastPly is 90 — well past the merged run's own end (88) — exactly
    // game_11's own shape, so arrivedAtLastPly must stay false.
    const analysis = analysisFrom([85, 86, 87, 88, 89, 90].map((p) => evalPly(p, 700)));

    const chain = buildConsequenceChain(86, understanding, analysis, unknownOutcome());

    expect(chain.consequents.map((l) => l.ply)).toEqual([87, 88]);
    expect(chain.consequents.every((l) => l.linkType === 'adjacent-forced-sequence')).toBe(true);
    expect(chain.reachesResult).toBe(false);
    expect(chain.payoff).toEqual({ kind: 'eval-settled', atPly: 86, finalSwingCp: -307 });
  });

  it('13b. game_14 regression: a candidate whose OWN sequence merely happens to reach the true last ply via this extension must not gain reachesResult/payoff-arrival — an earlier version of this code let this flip which turning point storyCandidates.ts selects', () => {
    // The exact shape that broke game_14: this trigger's own ForcedSequence
    // is immediately adjacent to a LATER one that runs all the way to the
    // game's actual last ply. Before the fix, that made chainEndPly reach
    // lastPly and flipped arrivedAtLastPly/reachesResult/payoff to the
    // terminal branch for a candidate that never should have gotten it.
    const seqAtTrigger = forcedSequence('seq-4', [10, 11], 'material-forced-recapture'); // touches the trigger (11)
    const laterAdjacentSeq = forcedSequence('seq-5', [12, 13], 'check'); // reaches lastPly (13)
    const cc = causeConsequence(11, { evaluationConsequence: { atPly: 11, swingCp: -42 }, materialConsequence: { atPly: 11, netMaterialChange: 500 } });
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqAtTrigger, laterAdjacentSeq],
      turningPoints: [turningPoint(11, 'irreversible-material-loss', cc, 392)]
    });
    const outcome = unknownOutcome({ result: '0-1', termination: 'resignation', source: 'termination-tag', confidence: 0.9 });
    const analysis = analysisFrom([10, 11, 12, 13].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, outcome);

    // The richer display context is still there...
    expect(chain.consequents.map((l) => l.ply)).toEqual([12, 13]);
    expect(chain.consequents.some((l) => l.linkType === 'adjacent-forced-sequence')).toBe(true);
    // ...but it must NOT have promoted this chain into "reached the result".
    // Before the fix this was true and payoff.kind was 'off-board-result'.
    expect(chain.reachesResult).toBe(false);
    expect(chain.payoff).toEqual({ kind: 'material-settled', atPly: 11, netMaterialChange: 500 });
  });

  it('13c. game_14 regression at the selection level: a lower-significance candidate must not out-rank a higher-significance one merely because this extension reaches the true last ply', () => {
    // tp-45-shape: lower significance, its own sequence is adjacent to one
    // reaching the actual last ply. tp-47-shape: higher significance, is
    // itself the last forced sequence and already reaches the result
    // honestly. Before the fix, tp-45-shape's chain.reachesResult flipped to
    // true, tying it with tp-47-shape on tier, and materialMagnitude (500 vs
    // 0) then won the tie-break — selecting the WRONG turning point.
    const seqAtLowSig = forcedSequence('seq-4', [8, 9], 'material-forced-recapture'); // touches tp-A (9)
    const seqReachingEnd = forcedSequence('seq-5', [10, 11], 'check'); // adjacent, reaches lastPly (11)
    const lowSigCc = causeConsequence(9, {
      evaluationConsequence: { atPly: 9, swingCp: -42 },
      materialConsequence: { atPly: 9, netMaterialChange: 500 },
      resolution: 'material-gain'
    });
    const highSigCc = causeConsequence(11, {
      evaluationConsequence: { atPly: 11, swingCp: -211 },
      materialConsequence: { atPly: 11, netMaterialChange: 0 },
      resolution: 'repelled'
    });
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqAtLowSig, seqReachingEnd],
      turningPoints: [
        turningPoint(9, 'irreversible-material-loss', lowSigCc, 392), // lower significance, like tp-45
        turningPoint(11, 'decisive-swing', highSigCc, 411) // higher significance, like tp-47
      ],
      // Gate 1 admissibility needs a real, persisting advantage for each
      // candidate: material for tp-9 (matching its own materialConsequence),
      // evaluation for tp-11 (it is the game's own last ply, so nothing need
      // persist beyond it).
      gameArc: {
        openingEndPly: 0,
        middlegameEndPly: 0,
        materialTrajectory: [8, 9, 10, 11].map((p) => ({ ply: p, materialDiff: p >= 9 ? 500 : 0 })),
        evidence: { basis: 'chess-rule', sourcePlies: [8, 9, 10, 11], note: 'fixture arc' }
      }
    });
    const outcome = unknownOutcome({ result: '0-1', termination: 'resignation', source: 'termination-tag', confidence: 0.9 });
    const analysis = analysisFrom([
      evalPly(8, 0),
      evalPly(9, 0),
      evalPly(10, 0),
      plyAnalysis(11, { evaluationBefore: { kind: 'cp', cp: 0 }, evaluationAfter: { kind: 'cp', cp: -211 } })
    ]);

    const result = selectCentralConflict(understanding, analysis, outcome, DEFAULT_STORY_SETTINGS);

    expect(result.centralConflict?.primaryTurningPointId).toBe('tp-11');
  });

  it('14. Phase 23A antecedent threat-bridge behaviour is unaffected by this consequent-side change', () => {
    const FORK_11 = tacticalMotif('m-11', 11, 'fork', 'b7', ['a8', 'b8']);
    const BATTERY_12 = tacticalMotif('m-12', 12, 'battery', 'a8', ['d8']);
    const FORK_13 = tacticalMotif('m-13', 13, 'fork', 'b7', ['a8', 'd7']);
    const SKEWER_14 = tacticalMotif('m-14', 14, 'skewer', 'b8', ['b5'], {
      squares: { attacker: 'b8', targets: ['b5'], throughSquare: 'b7' }
    });
    const threat = threatRecord('threat-9-0', 9, 'w', 'material-winning-threat', 'b7', { targetPiece: 'p', netMaterialIfExecuted: 100 });
    const understanding = understandingFrom({
      plies: [],
      motifs: [FORK_11, BATTERY_12, FORK_13, SKEWER_14],
      threats: [threat],
      turningPoints: [turningPoint(14, 'decisive-swing', causeConsequence(14, { mechanism: null, mechanismVerified: false }), 400)]
    });
    const analysis = analysisFrom(
      [
        { n: 9, uci: 'd1b3' },
        { n: 10, uci: 'g8f6' },
        { n: 11, uci: 'b3b7' },
        { n: 12, uci: 'b8d7' },
        { n: 13, uci: 'd7b5' },
        { n: 14, uci: 'a8b8' }
      ].map(({ n, uci }) => plyAnalysis(n, { movePlayedUci: uci, fenBefore: FEN }))
    );

    const chain = buildConsequenceChain(14, understanding, analysis, unknownOutcome());
    expect(chain.antecedents.map((l) => l.ply)).toEqual([9, 10, 11, 12, 13]);
    expect(chain.antecedents.filter((l) => l.linkType === 'unrefuted-threat-bridge').map((l) => l.ply)).toEqual([9, 10]);
  });

  it('15. mechanism verification stays completely untouched by richer consequent evidence', () => {
    const seqA = forcedSequence('seq-a', [10, 11], 'check');
    const seqB = forcedSequence('seq-b', [12, 13], 'check');
    const cc = causeConsequence(11, { mechanism: null, mechanismVerified: false });
    const understanding = understandingFrom({
      plies: [],
      sequences: [seqA, seqB],
      turningPoints: [turningPoint(11, 'decisive-swing', cc, 400)]
    });
    const analysis = analysisFrom([10, 11, 12, 13].map((p) => evalPly(p, 0)));

    const chain = buildConsequenceChain(11, understanding, analysis, unknownOutcome());
    expect(chain.consequents.length).toBeGreaterThan(0);
    expect(cc.mechanism).toBeNull();
    expect(cc.mechanismVerified).toBe(false);
  });
});
