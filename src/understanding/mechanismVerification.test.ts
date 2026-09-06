import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, TacticalMotifInstance, ThreatRecord } from './types';
import { motifInstanceKeyFor } from './motifs';
import { anchoredToMove, isNovelOnPly, isRealized, verifyMechanism, type MechanismInputs } from './mechanismVerification';

/**
 * Phase 15 (M5) — mechanism verification.
 *
 * The behaviour being replaced: pickMechanism returned motifsForPly[0].motif
 * — whichever pattern came first in board-scan order — with no test that the
 * move had anything to do with it. Real games produced "a battery led to..."
 * for a bishop retreat standing beside four pre-existing batteries, and
 * "a skewer led to..." for a rook move whose skewer was never converted.
 *
 * The scenarios below are modelled on those exact shapes rather than on
 * abstract cases, but nothing here keys on a game number or SAN string —
 * they are structural fixtures.
 */

const QUIET_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const AFTER_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

function ply(overrides: Partial<PlyAnalysis> = {}): PlyAnalysis {
  return {
    ply: 10,
    moveNumber: 5,
    sideToMove: 'w',
    movePlayedSan: 'Bf2',
    movePlayedUci: 'e3f2',
    fenBefore: QUIET_FEN,
    fenAfter: AFTER_FEN,
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter: { kind: 'cp', cp: 0 },
    bestMove: null,
    principalVariation: [],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12,
    ...overrides
  };
}

function motif(
  overrides: Partial<TacticalMotifInstance> &
    Pick<TacticalMotifInstance, 'motif' | 'ply'> & { attacker: string; targets: readonly string[]; throughSquare?: string }
): TacticalMotifInstance {
  const { attacker, targets, throughSquare, ...rest } = overrides;
  return {
    id: `motif-${rest.ply}-${rest.motif}`,
    squares: { attacker, targets, ...(throughSquare !== undefined ? { throughSquare } : {}) },
    motifInstanceKey: motifInstanceKeyFor(rest.motif, attacker, targets, throughSquare),
    firstSeenPly: rest.ply,
    geometryEvidence: { basis: 'chess-rule', sourcePlies: [rest.ply], note: 'fixture' },
    ...rest
  };
}

function threat(square: string, ply: number): ThreatRecord {
  return {
    id: `t-${square}`,
    ply,
    side: 'w',
    kind: 'material-winning-threat',
    targetSquare: square,
    evidence: { basis: 'chess-rule', sourcePlies: [ply], note: 'fixture' }
  };
}

function inputs(overrides: Partial<MechanismInputs> = {}): MechanismInputs {
  const p = overrides.ply ?? ply();
  return {
    motifsForPly: [],
    threatsCreatedHere: [],
    sequence: undefined,
    allPliesByNumber: new Map([[p.ply, p]]),
    deliversCheck: false,
    deliversMate: false,
    materialNetForMover: 0,
    swingAtConsequence: 0,
    ...overrides,
    ply: p
  };
}

describe('V1 anchoring', () => {
  it('accepts a motif whose attacker is the square the move came from or landed on', () => {
    expect(anchoredToMove(motif({ motif: 'battery', ply: 10, attacker: 'e3', targets: ['a7'] }), 'e3f2')).toBe(true);
    expect(anchoredToMove(motif({ motif: 'battery', ply: 10, attacker: 'f2', targets: ['a7'] }), 'e3f2')).toBe(true);
  });

  it('accepts a motif one of whose targets is the square the move landed on', () => {
    expect(anchoredToMove(motif({ motif: 'pin', ply: 10, attacker: 'a1', targets: ['f2'] }), 'e3f2')).toBe(true);
  });

  it('rejects a motif the move never touched', () => {
    expect(anchoredToMove(motif({ motif: 'battery', ply: 10, attacker: 'h1', targets: ['h8'] }), 'e3f2')).toBe(false);
  });

  /**
   * Phase 18F — the discovery/revealed-line-motif fix. Before this, V1 only
   * ever inspected attacker/targets against from/to, so a discovery — whose
   * attacker never moved and whose target is rarely the move's own
   * destination — could never pass V1 at all, regardless of how clean the
   * mechanism was. A discovery's own throughSquare is always exactly the
   * move's own vacated square (motifs.ts sets it to
   * movePlayedUci.slice(0, 2) unconditionally for every discovery
   * instance), so `throughSquare === from` is a hard structural fact, not
   * an inference — this is the real game_04 shape (Bf2 uncovering a
   * discovered attack from e1 through e3 onto e5).
   */
  it('accepts a discovery whose throughSquare equals the move\'s own vacated square (the game_04 shape)', () => {
    const discovery = motif({ motif: 'discovery', ply: 63, attacker: 'e1', targets: ['e5'], throughSquare: 'e3' });
    expect(anchoredToMove(discovery, 'e3f2')).toBe(true);
  });

  it('accepts a line motif (pin/skewer/battery) whose own throughSquare equals the move\'s own vacated square', () => {
    // A rook at a1 was blocked by a piece on c1; c1-d2 just vacated c1,
    // revealing a pin/skewer down the c-file. The attacker (a1) and target
    // (c7) are unrelated to this move's own squares — only throughSquare
    // (c1, the vacated square) ties it to c1d2.
    const revealedPin = motif({ motif: 'pin', ply: 20, attacker: 'a1', targets: ['c7'], throughSquare: 'c1' });
    expect(anchoredToMove(revealedPin, 'c1d2')).toBe(true);
  });

  it('still rejects a line motif whose throughSquare does not correspond to this move — an unrelated nearby pattern is not swept in', () => {
    // Same shape as game_04's own second pin: a genuinely different,
    // unrelated line motif that merely happens to exist on the same ply.
    // Its throughSquare (e5) is not this move's vacated square (e3), so it
    // must remain rejected even under the widened V1 test.
    const unrelatedPin = motif({ motif: 'pin', ply: 63, attacker: 'e1', targets: ['e7'], throughSquare: 'e5' });
    expect(anchoredToMove(unrelatedPin, 'e3f2')).toBe(false);
  });

  it('does not pass merely because a throughSquare is present — attacker/target anchoring is still evaluated independently', () => {
    // A motif with a throughSquare set, but neither attacker/targets nor
    // throughSquare touch this move at all.
    const untouched = motif({ motif: 'skewer', ply: 10, attacker: 'h1', targets: ['h8'], throughSquare: 'h4' });
    expect(anchoredToMove(untouched, 'e3f2')).toBe(false);
  });

  it('existing attacker/target anchoring is unaffected by the throughSquare addition', () => {
    // Re-asserts the three pre-existing V1 cases verbatim, now that
    // throughSquare has been added as a fourth, independent check.
    expect(anchoredToMove(motif({ motif: 'battery', ply: 10, attacker: 'e3', targets: ['a7'] }), 'e3f2')).toBe(true);
    expect(anchoredToMove(motif({ motif: 'battery', ply: 10, attacker: 'f2', targets: ['a7'] }), 'e3f2')).toBe(true);
    expect(anchoredToMove(motif({ motif: 'pin', ply: 10, attacker: 'a1', targets: ['f2'] }), 'e3f2')).toBe(true);
    expect(anchoredToMove(motif({ motif: 'battery', ply: 10, attacker: 'h1', targets: ['h8'] }), 'e3f2')).toBe(false);
  });
});

describe('V2 novelty', () => {
  it('accepts a pattern first seen on this ply and rejects one that was already standing', () => {
    expect(isNovelOnPly(motif({ motif: 'fork', ply: 10, attacker: 'e3', targets: ['a7'] }))).toBe(true);
    expect(isNovelOnPly(motif({ motif: 'fork', ply: 10, attacker: 'e3', targets: ['a7'], firstSeenPly: 4 }))).toBe(false);
  });

  it('gives the same instance key to the same pattern regardless of target order', () => {
    expect(motifInstanceKeyFor('fork', 'b6', ['a8', 'c8'], undefined)).toBe(motifInstanceKeyFor('fork', 'b6', ['c8', 'a8'], undefined));
  });

  it('does not collide a line motif through a square with a fork sharing attacker and targets', () => {
    expect(motifInstanceKeyFor('pin', 'b6', ['c8'], 'b7')).not.toBe(motifInstanceKeyFor('pin', 'b6', ['c8'], undefined));
  });
});

describe('verifyMechanism — withholding fabricated mechanisms', () => {
  it('withholds a battery that was already standing before the move (the game-04 shape)', () => {
    // A bishop retreat beside several pre-existing batteries. Anchored, but
    // not novel: the move did not create the pattern.
    const preExisting = [
      motif({ motif: 'battery', ply: 10, attacker: 'e3', targets: ['a7'], firstSeenPly: 6 }),
      motif({ motif: 'battery', ply: 10, attacker: 'f2', targets: ['b6'], firstSeenPly: 8 })
    ];
    const result = verifyMechanism(inputs({ motifsForPly: preExisting, swingAtConsequence: -358 }));

    expect(result.mechanism).toBeNull();
    expect(result.verified).toBe(false);
  });

  it('withholds a skewer that was never realized and is not the only explanation (the game-08 shape)', () => {
    // Novel and anchored, but nothing on the skewer's line is ever captured
    // or compelled, and no consequence attaches to its target set.
    const skewer = motif({ motif: 'skewer', ply: 10, attacker: 'f2', targets: ['h4'] });
    const result = verifyMechanism(inputs({ motifsForPly: [skewer], materialNetForMover: 0, swingAtConsequence: -502 }));

    expect(result.mechanism).toBeNull();
    expect(result.verified).toBe(false);
  });

  it('withholds a motif when another threat could equally explain the consequence (the game-01 shape)', () => {
    // A rook capture with a real pin nearby. The pin is novel and anchored,
    // but a threat outside its target set means it is not the necessary
    // explanation — and nothing realizes it.
    const pin = motif({ motif: 'pin', ply: 10, attacker: 'f2', targets: ['d4'] });
    const result = verifyMechanism(
      inputs({
        motifsForPly: [pin],
        threatsCreatedHere: [threat('d4', 10), threat('h7', 10)],
        materialNetForMover: 330,
        swingAtConsequence: 200
      })
    );

    expect(result.mechanism).toBeNull();
    expect(result.verified).toBe(false);
  });

  it('names a motif whose target is actually captured inside the forced window (V3)', () => {
    const capturingReply: PlyAnalysis = ply({
      ply: 11,
      sideToMove: 'b',
      // The reply captures on d4, one of the motif's target squares, and d4
      // was genuinely occupied beforehand.
      movePlayedUci: 'c5d4',
      fenBefore: 'rnbqkbnr/pppppppp/8/2p5/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'
    });
    const sequence: ForcedSequence = {
      id: 'seq-1',
      startPly: 10,
      endPly: 11,
      plies: [10, 11],
      forcingReason: 'material-forced-recapture',
      evidence: { basis: 'chess-rule', sourcePlies: [10, 11], note: 'fixture' }
    };
    const trigger = ply();
    const pin = motif({ motif: 'pin', ply: 10, attacker: 'f2', targets: ['d4'] });

    const result = verifyMechanism(
      inputs({
        ply: trigger,
        motifsForPly: [pin],
        sequence,
        allPliesByNumber: new Map([
          [10, trigger],
          [11, capturingReply]
        ])
      })
    );

    expect(result.mechanism).toBe('pin');
    expect(result.verified).toBe(true);
    expect(result.passedTests).toContain('V3');
    expect(result.motifId).toBe(pin.id);
  });

  it('names a motif that is the only available explanation for a real consequence (V4)', () => {
    const fork = motif({ motif: 'fork', ply: 10, attacker: 'f2', targets: ['d4', 'h4'] });
    const result = verifyMechanism(
      inputs({
        motifsForPly: [fork],
        threatsCreatedHere: [threat('d4', 10)],
        materialNetForMover: 330,
        swingAtConsequence: 300
      })
    );

    expect(result.mechanism).toBe('fork');
    expect(result.verified).toBe(true);
    expect(result.passedTests).toContain('V4');
  });

  it('does not use ply proximity as causal proof', () => {
    // A motif on this very ply, with a huge consequence, still fails when it
    // is neither anchored to the move nor novel.
    const bystander = motif({ motif: 'battery', ply: 10, attacker: 'h1', targets: ['h8'], firstSeenPly: 2 });
    const result = verifyMechanism(
      inputs({ motifsForPly: [bystander], materialNetForMover: 900, swingAtConsequence: 900, threatsCreatedHere: [threat('h8', 10)] })
    );
    expect(result.mechanism).toBeNull();
  });
});

describe('V3 realization window — sequence-tail fallback (Phase 18F)', () => {
  // game_12's real shape: the forced sequence's own last ply IS the
  // mechanism's trigger ply (`sequence.plies = [47, 48]`, trigger = 48).
  // `sequence.plies.filter(p => p > 48)` is empty by construction — the
  // trigger sits at the tail of its own sequence, not before it — so before
  // this fix isRealized had no window to inspect at all and V3 always
  // failed here regardless of what actually happened next.
  const tailSequence: ForcedSequence = {
    id: 'seq-tail',
    startPly: 47,
    endPly: 48,
    plies: [47, 48],
    forcingReason: 'material-forced-recapture',
    evidence: { basis: 'chess-rule', sourcePlies: [47, 48], note: 'fixture' }
  };

  it('falls back to the single real next ply and passes V3 when it captures the target (the game_12 shape)', () => {
    const trigger = ply({ ply: 48 });
    const realizingReply: PlyAnalysis = ply({
      ply: 49,
      sideToMove: 'b',
      movePlayedUci: 'c5d4',
      fenBefore: 'rnbqkbnr/pppppppp/8/2p5/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'
    });
    const pin = motif({ motif: 'pin', ply: 48, attacker: 'f2', targets: ['d4'] });

    const verified = isRealized(
      pin,
      inputs({
        ply: trigger,
        sequence: tailSequence,
        allPliesByNumber: new Map([
          [47, ply({ ply: 47 })],
          [48, trigger],
          [49, realizingReply]
        ])
      })
    );

    expect(verified).toBe(true);
  });

  it('falls back to the single real next ply and still fails V3 when it does not realize the target', () => {
    const trigger = ply({ ply: 48 });
    const quietReply: PlyAnalysis = ply({ ply: 49, sideToMove: 'b', movePlayedUci: 'g8f6', fenBefore: QUIET_FEN });
    const pin = motif({ motif: 'pin', ply: 48, attacker: 'f2', targets: ['d4'] });

    const verified = isRealized(
      pin,
      inputs({
        ply: trigger,
        sequence: tailSequence,
        allPliesByNumber: new Map([
          [47, ply({ ply: 47 })],
          [48, trigger],
          [49, quietReply]
        ])
      })
    );

    expect(verified).toBe(false);
  });

  it('does not treat the fallback ply as "forced" — a piece merely leaving the target square does not count, unlike a genuine sequence member', () => {
    // The reply moves FROM the target square (d4) without capturing
    // anything. Under "compelled to move" this would satisfy V3 for a ply
    // that is actually a member of the sequence, but ply 49 is NOT a
    // member of tailSequence.plies (that's exactly why the forward filter
    // came back empty), so it must not count here.
    const trigger = ply({ ply: 48 });
    const leavingReply: PlyAnalysis = ply({ ply: 49, sideToMove: 'b', movePlayedUci: 'd4d3', fenBefore: QUIET_FEN });
    const pin = motif({ motif: 'pin', ply: 48, attacker: 'f2', targets: ['d4'] });

    const verified = isRealized(
      pin,
      inputs({
        ply: trigger,
        sequence: tailSequence,
        allPliesByNumber: new Map([
          [47, ply({ ply: 47 })],
          [48, trigger],
          [49, leavingReply]
        ])
      })
    );

    expect(verified).toBe(false);
  });

  it('a genuine sequence member being compelled to move off the target still counts — the fallback did not weaken this', () => {
    // Contrast case: identical "leaves the target square" shape as above,
    // but ply 49 IS itself part of the forced sequence this time, so the
    // forward filter is non-empty and the fallback path never engages.
    const memberSequence: ForcedSequence = {
      id: 'seq-member',
      startPly: 47,
      endPly: 49,
      plies: [47, 48, 49],
      forcingReason: 'material-forced-recapture',
      evidence: { basis: 'chess-rule', sourcePlies: [47, 48, 49], note: 'fixture' }
    };
    const trigger = ply({ ply: 48 });
    const leavingReply: PlyAnalysis = ply({ ply: 49, sideToMove: 'b', movePlayedUci: 'd4d3', fenBefore: QUIET_FEN });
    const pin = motif({ motif: 'pin', ply: 48, attacker: 'f2', targets: ['d4'] });

    const verified = isRealized(
      pin,
      inputs({
        ply: trigger,
        sequence: memberSequence,
        allPliesByNumber: new Map([
          [47, ply({ ply: 47 })],
          [48, trigger],
          [49, leavingReply]
        ])
      })
    );

    expect(verified).toBe(true);
  });

  it('leaves the pre-existing non-empty sequence window behaviour unchanged (forward filter has plies, fallback never engages)', () => {
    // Identical shape to the pre-existing 'names a motif whose target is
    // actually captured inside the forced window (V3)' test above — the
    // forward filter is non-empty (trigger=10, sequence tail=11), so the
    // fallback path added in this phase must never be reached.
    const capturingReply: PlyAnalysis = ply({
      ply: 11,
      sideToMove: 'b',
      movePlayedUci: 'c5d4',
      fenBefore: 'rnbqkbnr/pppppppp/8/2p5/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'
    });
    const normalSequence: ForcedSequence = {
      id: 'seq-normal',
      startPly: 10,
      endPly: 11,
      plies: [10, 11],
      forcingReason: 'material-forced-recapture',
      evidence: { basis: 'chess-rule', sourcePlies: [10, 11], note: 'fixture' }
    };
    const trigger = ply();
    const pin = motif({ motif: 'pin', ply: 10, attacker: 'f2', targets: ['d4'] });

    const verified = isRealized(
      pin,
      inputs({
        ply: trigger,
        sequence: normalSequence,
        allPliesByNumber: new Map([
          [10, trigger],
          [11, capturingReply]
        ])
      })
    );

    expect(verified).toBe(true);
  });

  it('end-to-end: verifyMechanism now names the mechanism when the trigger is the sequence tail and the fallback ply realizes it', () => {
    const trigger = ply({ ply: 48 });
    const realizingReply: PlyAnalysis = ply({
      ply: 49,
      sideToMove: 'b',
      movePlayedUci: 'c5d4',
      fenBefore: 'rnbqkbnr/pppppppp/8/2p5/3P4/8/PPP1PPPP/RNBQKBNR b KQkq - 0 1'
    });
    const pin = motif({ motif: 'pin', ply: 48, attacker: 'f2', targets: ['d4'] });

    const result = verifyMechanism(
      inputs({
        ply: trigger,
        motifsForPly: [pin],
        sequence: tailSequence,
        allPliesByNumber: new Map([
          [47, ply({ ply: 47 })],
          [48, trigger],
          [49, realizingReply]
        ])
      })
    );

    expect(result.mechanism).toBe('pin');
    expect(result.verified).toBe(true);
    expect(result.passedTests).toContain('V3');
  });

  it('end-to-end: verifyMechanism still withholds the mechanism when the sequence-tail fallback ply does not realize it and nothing else explains the consequence', () => {
    const trigger = ply({ ply: 48 });
    const quietReply: PlyAnalysis = ply({ ply: 49, sideToMove: 'b', movePlayedUci: 'g8f6', fenBefore: QUIET_FEN });
    const pin = motif({ motif: 'pin', ply: 48, attacker: 'f2', targets: ['d4'] });

    const result = verifyMechanism(
      inputs({
        ply: trigger,
        motifsForPly: [pin],
        sequence: tailSequence,
        allPliesByNumber: new Map([
          [47, ply({ ply: 47 })],
          [48, trigger],
          [49, quietReply]
        ])
      })
    );

    expect(result.mechanism).toBeNull();
    expect(result.verified).toBe(false);
  });
});

describe('verifyMechanism — the non-motif ladder is unchanged', () => {
  it('reports king-safety for a checking move with no motif, on a hard chess fact', () => {
    const result = verifyMechanism(inputs({ deliversCheck: true }));
    expect(result.mechanism).toBe('king-safety');
    expect(result.verified).toBe(true);
  });

  it('reports positional for a swinging move with no motif at all', () => {
    const result = verifyMechanism(inputs({ ply: ply({ swingForMoverCp: -300 }) }));
    expect(result.mechanism).toBe('positional');
  });

  it('reports nothing for a quiet move with no motif and no swing', () => {
    expect(verifyMechanism(inputs()).mechanism).toBeNull();
  });

  it('does NOT fall back to "positional" when motifs existed and were disproved', () => {
    // Substituting a vaguer claim for a disproved one is still an
    // unsupported claim. Having looked and found nothing, we say nothing.
    const disproved = motif({ motif: 'battery', ply: 10, attacker: 'e3', targets: ['a7'], firstSeenPly: 2 });
    const result = verifyMechanism(inputs({ motifsForPly: [disproved], ply: ply({ swingForMoverCp: -400 }) }));
    expect(result.mechanism).toBeNull();
  });
});
