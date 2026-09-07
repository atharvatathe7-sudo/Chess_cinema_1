import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, TacticalMotifInstance, ThreatRecord } from './types';
import { motifInstanceKeyFor } from './motifs';
import { anchoredToMove, isNecessary, isNovelOnPly, isRealized, verifyMechanism, type MechanismInputs } from './mechanismVerification';

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

describe('V3 realization — battery false-positive guard (Phase 18G)', () => {
  // The real game_10 ply-31 shape: a battery's own `targets` names its own
  // second FRIENDLY piece (geometry.ts's documented representation), not an
  // enemy square. White plays Re1 (f1->e1), forming a battery with the rook
  // already on d1 (attacker=d1, targets=['e1']). Black's OTHER rook then
  // captures on e1 (Rxe1+) — the opponent capturing the battery's OWN front
  // piece, not the battery converting a threat. Before this fix, isRealized's
  // generic "captured" check could not tell the difference and returned
  // true; the corpus showed this had already produced mechanismVerified:
  // true for a battery on three real turning points (game_07 ply 54,
  // game_10 plies 31 and 57), all of them actual material losses for the
  // mover, not a battery achieving anything.
  const battery = motif({ motif: 'battery', ply: 31, attacker: 'd1', targets: ['e1'], throughSquare: 'e1' });
  const trigger = ply({ ply: 31, movePlayedUci: 'f1e1', movePlayedSan: 'Re1' });
  const opponentCapturesFrontPiece: PlyAnalysis = ply({
    ply: 32,
    sideToMove: 'b',
    movePlayedUci: 'e8e1',
    movePlayedSan: 'Rxe1+',
    // e1 is occupied (by the battery's own front rook) going into this reply.
    fenBefore: '4r1k1/8/8/8/8/8/8/3RR2K w - - 0 1'
  });

  it('1. battery + opponent captures the friendly front piece: isRealized is false (was true before this fix)', () => {
    const realized = isRealized(
      battery,
      inputs({
        ply: trigger,
        allPliesByNumber: new Map([
          [31, trigger],
          [32, opponentCapturesFrontPiece]
        ])
      })
    );
    expect(realized).toBe(false);
  });

  it('2. the identical capture shape for a non-battery motif with a genuine enemy target still realizes (existing behaviour preserved)', () => {
    // Same trigger, same reply, same target square — only the motif kind
    // differs. A pin's target is a real enemy piece, so the capture on e1
    // genuinely is realization and must remain true.
    const pin = motif({ motif: 'pin', ply: 31, attacker: 'a1', targets: ['e1'] });
    const realized = isRealized(
      pin,
      inputs({
        ply: trigger,
        allPliesByNumber: new Map([
          [31, trigger],
          [32, opponentCapturesFrontPiece]
        ])
      })
    );
    expect(realized).toBe(true);
  });

  it('3. a battery cannot become mechanismVerified through the captured-target path, even when V1 and V2 both pass', () => {
    // battery.targets includes 'e1', the trigger move's own destination, so
    // V1 anchors and V2 is novel (firstSeenPly === ply) — exactly the real
    // game_10 shape. With no other motif and no independent V4 consequence,
    // this must now withhold rather than name "battery".
    const result = verifyMechanism(
      inputs({
        ply: trigger,
        motifsForPly: [battery],
        allPliesByNumber: new Map([
          [31, trigger],
          [32, opponentCapturesFrontPiece]
        ])
      })
    );
    expect(result.mechanism).toBeNull();
    expect(result.verified).toBe(false);
  });

  it('4. existing forced-sequence realization behaviour is unchanged for non-battery motifs, and the battery guard also holds inside a forced sequence', () => {
    const sequence: ForcedSequence = {
      id: 'seq-battery-guard',
      startPly: 31,
      endPly: 32,
      plies: [31, 32],
      forcingReason: 'material-forced-recapture',
      evidence: { basis: 'chess-rule', sourcePlies: [31, 32], note: 'fixture' }
    };
    const seqInputs = inputs({
      ply: trigger,
      sequence,
      allPliesByNumber: new Map([
        [31, trigger],
        [32, opponentCapturesFrontPiece]
      ])
    });

    // Non-battery: unchanged from pre-existing V3 behaviour.
    const pin = motif({ motif: 'pin', ply: 31, attacker: 'a1', targets: ['e1'] });
    expect(isRealized(pin, seqInputs)).toBe(true);

    // Battery: the guard holds even when the capture happens inside a
    // genuine forced sequence, not just the simple next-ply case.
    expect(isRealized(battery, seqInputs)).toBe(false);
  });

  it('5. V1, V2, and V4 are untouched for battery motifs — only the V3 captured-target branch changed', () => {
    // V1 anchoring: still passes via the existing generic attacker/target
    // rule (battery.targets includes the trigger move's own destination) —
    // nothing about this fix touched anchoredToMove.
    expect(anchoredToMove(battery, trigger.movePlayedUci)).toBe(true);
    // V2 novelty: still the same firstSeenPly === ply check, untouched.
    expect(isNovelOnPly(battery)).toBe(true);
    // V4 necessity: still the same generic threat-set logic, untouched —
    // if a threat happened to target the battery's own square, V4 would
    // still fire exactly as it would have before this change (V4 was never
    // touched by this fix; it structurally never matches real ThreatRecords
    // for a battery only because real threats never target a friendly
    // square, which is a fact about the data, not this code path).
    const necessary = isNecessary(
      battery,
      inputs({
        ply: trigger,
        threatsCreatedHere: [threat('e1', 31)],
        materialNetForMover: 300,
        swingAtConsequence: 0
      })
    );
    expect(necessary).toBe(true);
  });
});

describe('V3 realization — destroyed-motif forced-sequence guard (Phase 18I)', () => {
  // The real game_10 shape: White promotes c8=Q, forming a pin (attacker=c8,
  // through=e8, target=f8 — queen, black rook, black king all on rank 8).
  // Black's rook captures the pinning queen one ply later (destroying the
  // pin), White's OTHER rook recaptures on c8 giving a brand-new, unrelated
  // check, and the king's escape from THAT check was being wrongly credited
  // as "realization" of the long-dead pin, purely because it's a member of
  // the same ForcedSequence and moves off the pin's own target square.
  const pin = motif({ motif: 'pin', ply: 57, attacker: 'c8', targets: ['f8'], throughSquare: 'e8' });
  const trigger57 = ply({
    ply: 57,
    sideToMove: 'w',
    movePlayedUci: 'c7c8q',
    movePlayedSan: 'c8=Q',
    // The board exactly as it stood the moment the pin was created: White
    // queen c8, Black rook e8, Black king f8 — nothing between them.
    fenAfter: '1RQ1rk2/8/8/8/8/8/8/6K1 b - - 0 1'
  });
  const pinSequence: ForcedSequence = {
    id: 'seq-pin-destroyed',
    startPly: 57,
    endPly: 60,
    plies: [57, 58, 59, 60],
    forcingReason: 'material-forced-recapture',
    evidence: { basis: 'chess-rule', sourcePlies: [57, 58, 59, 60], note: 'fixture' }
  };

  it('1. pin destroyed before the credited ply: isRealized is false (the game_10 regression)', () => {
    const capturesThePinningQueen = ply({
      ply: 58,
      sideToMove: 'b',
      movePlayedUci: 'e8c8',
      movePlayedSan: 'Rxc8',
      fenBefore: '1RQ1rk2/8/8/8/8/8/8/6K1 b - - 0 1'
    });
    const recapturesWithTheOtherRook = ply({
      ply: 59,
      sideToMove: 'w',
      movePlayedUci: 'b8c8',
      movePlayedSan: 'Rxc8+',
      fenBefore: '1Rr2k2/8/8/8/8/8/8/6K1 w - - 0 1'
    });
    const kingFleesTheNewCheck = ply({
      ply: 60,
      sideToMove: 'b',
      movePlayedUci: 'f8e7',
      movePlayedSan: 'Ke7',
      // c8 now holds a WHITE ROOK — the same colour as the original queen,
      // but a different piece entirely. A colour-only survival check would
      // be fooled by this; the fix must compare the actual piece.
      fenBefore: '2R2k2/8/8/8/8/8/8/6K1 b - - 0 1'
    });

    const realized = isRealized(
      pin,
      inputs({
        ply: trigger57,
        sequence: pinSequence,
        allPliesByNumber: new Map([
          [57, trigger57],
          [58, capturesThePinningQueen],
          [59, recapturesWithTheOtherRook],
          [60, kingFleesTheNewCheck]
        ])
      })
    );

    expect(realized).toBe(false);
  });

  it('2. end-to-end: verifyMechanism no longer names "pin" for the destroyed game_10 shape', () => {
    const capturesThePinningQueen = ply({
      ply: 58,
      sideToMove: 'b',
      movePlayedUci: 'e8c8',
      fenBefore: '1RQ1rk2/8/8/8/8/8/8/6K1 b - - 0 1'
    });
    const recapturesWithTheOtherRook = ply({
      ply: 59,
      sideToMove: 'w',
      movePlayedUci: 'b8c8',
      fenBefore: '1Rr2k2/8/8/8/8/8/8/6K1 w - - 0 1'
    });
    const kingFleesTheNewCheck = ply({
      ply: 60,
      sideToMove: 'b',
      movePlayedUci: 'f8e7',
      fenBefore: '2R2k2/8/8/8/8/8/8/6K1 b - - 0 1'
    });

    const result = verifyMechanism(
      inputs({
        ply: trigger57,
        motifsForPly: [pin],
        sequence: pinSequence,
        allPliesByNumber: new Map([
          [57, trigger57],
          [58, capturesThePinningQueen],
          [59, recapturesWithTheOtherRook],
          [60, kingFleesTheNewCheck]
        ])
      })
    );

    expect(result.mechanism).toBeNull();
    expect(result.verified).toBe(false);
  });

  it('3. the pin still realizes when the credited ply is the immediate reply and the attacker is untouched (positive control, same geometry)', () => {
    // Identical starting geometry, but the king flees on the very next ply —
    // no intervening capture ever touches the queen. This must remain true.
    const kingFleesImmediately = ply({
      ply: 58,
      sideToMove: 'b',
      movePlayedUci: 'f8e7',
      fenBefore: '1RQ1rk2/8/8/8/8/8/8/6K1 b - - 0 1'
    });
    const immediateSequence: ForcedSequence = {
      id: 'seq-pin-immediate',
      startPly: 57,
      endPly: 58,
      plies: [57, 58],
      forcingReason: 'material-forced-recapture',
      evidence: { basis: 'chess-rule', sourcePlies: [57, 58], note: 'fixture' }
    };

    const realized = isRealized(
      pin,
      inputs({
        ply: trigger57,
        sequence: immediateSequence,
        allPliesByNumber: new Map([
          [57, trigger57],
          [58, kingFleesImmediately]
        ])
      })
    );

    expect(realized).toBe(true);
  });

  // The real game_04 shape: a black pawn advance (g2+) forks White's rook
  // (f1) and king (h1) while delivering check. White's rook captures the
  // checking pawn, Black's other rook recaptures, and the king's own
  // eventual recapture on g2 (moving off h1, one of the fork's own targets)
  // was being wrongly credited as realizing a fork whose attacking pawn had
  // been captured two plies earlier.
  const fork = motif({ motif: 'fork', ply: 56, attacker: 'g2', targets: ['f1', 'h1'] });
  const trigger56 = ply({
    ply: 56,
    sideToMove: 'b',
    movePlayedUci: 'g3g2',
    movePlayedSan: 'g2+',
    // Black pawn just landed on g2, forking Rf1 and Kh1. A white rook sits
    // on a2 (about to capture the pawn), a black rook on g8 (about to
    // recapture).
    fenAfter: '1k4r1/8/8/8/8/8/R5p1/5R1K b - - 0 1'
  });
  const forkSequence: ForcedSequence = {
    id: 'seq-fork-destroyed',
    startPly: 56,
    endPly: 59,
    plies: [56, 57, 58, 59],
    forcingReason: 'check',
    evidence: { basis: 'chess-rule', sourcePlies: [56, 57, 58, 59], note: 'fixture' }
  };

  it('4. fork destroyed before the credited ply: isRealized is false (the game_04 regression)', () => {
    const whiteRookCapturesTheForkingPawn = ply({
      ply: 57,
      sideToMove: 'w',
      movePlayedUci: 'a2g2',
      movePlayedSan: 'Rxg2',
      fenBefore: '1k4r1/8/8/8/8/8/R5p1/5R1K b - - 0 1'
    });
    const blackRookRecaptures = ply({
      ply: 58,
      sideToMove: 'b',
      movePlayedUci: 'g8g2',
      movePlayedSan: 'Rxg2',
      fenBefore: '1k4r1/8/8/8/8/8/6R1/5R1K w - - 0 1'
    });
    const kingRecapturesUnrelatedToTheFork = ply({
      ply: 59,
      sideToMove: 'w',
      movePlayedUci: 'h1g2',
      movePlayedSan: 'Kxg2',
      // g2 now holds a BLACK ROOK — same colour as the original forking
      // pawn, but a different piece. Again, a colour-only check would miss
      // this; the fix compares the actual piece against the trigger board.
      fenBefore: '1k6/8/8/8/8/8/6r1/5R1K w - - 0 1'
    });

    const realized = isRealized(
      fork,
      inputs({
        ply: trigger56,
        allPliesByNumber: new Map([
          [56, trigger56],
          [57, whiteRookCapturesTheForkingPawn],
          [58, blackRookRecaptures],
          [59, kingRecapturesUnrelatedToTheFork]
        ]),
        sequence: forkSequence
      })
    );

    expect(realized).toBe(false);
  });

  it('5. the fork still realizes immediately when its own attacker delivers check and the king has to move right away (positive control, e.g. game_02/game_12 shape)', () => {
    const kingMovesImmediatelyOffCheck = ply({
      ply: 57,
      sideToMove: 'w',
      movePlayedUci: 'h1g1',
      fenBefore: '1k4r1/8/8/8/8/8/R5p1/5R1K b - - 0 1'
    });
    const immediateForkSequence: ForcedSequence = {
      id: 'seq-fork-immediate',
      startPly: 56,
      endPly: 57,
      plies: [56, 57],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [56, 57], note: 'fixture' }
    };

    const realized = isRealized(
      fork,
      inputs({
        ply: trigger56,
        sequence: immediateForkSequence,
        allPliesByNumber: new Map([
          [56, trigger56],
          [57, kingMovesImmediatelyOffCheck]
        ])
      })
    );

    expect(realized).toBe(true);
  });

  // A discovery's throughSquare names the square the mover vacated to open
  // the line — always empty by construction (V1's own comment) — never a
  // piece. The new geometry-survival check must not mistake that emptiness
  // for "destroyed," or every discovery realization would incorrectly break.
  it('6. a discovery still realizes immediately — its own empty throughSquare is correctly excluded from the piece-survival check', () => {
    const discovery = motif({ motif: 'discovery', ply: 63, attacker: 'e1', targets: ['e5'], throughSquare: 'e3' });
    const trigger63 = ply({
      ply: 63,
      sideToMove: 'w',
      movePlayedUci: 'e3f2',
      // White queen e1, Black queen e5, e3 empty (just vacated) — the
      // discovered attack this move opened.
      fenAfter: '4k3/8/8/4q3/8/8/8/4Q1K1 b - - 0 1'
    });
    const blackQueenFleesImmediately = ply({
      ply: 64,
      sideToMove: 'b',
      movePlayedUci: 'e5d4',
      fenBefore: '4k3/8/8/4q3/8/8/8/4Q1K1 b - - 0 1'
    });
    const discoverySequence: ForcedSequence = {
      id: 'seq-discovery-immediate',
      startPly: 63,
      endPly: 64,
      plies: [63, 64],
      forcingReason: 'material-forced-recapture',
      evidence: { basis: 'chess-rule', sourcePlies: [63, 64], note: 'fixture' }
    };

    const realized = isRealized(
      discovery,
      inputs({
        ply: trigger63,
        sequence: discoverySequence,
        allPliesByNumber: new Map([
          [63, trigger63],
          [64, blackQueenFleesImmediately]
        ])
      })
    );

    expect(realized).toBe(true);
  });

  it('7. battery still cannot realize through its captured-target path — the Phase 18G guard remains intact alongside this new guard', () => {
    // Unchanged from the Phase 18G fixture: the opponent capturing the
    // battery's own friendly front piece must still never count, regardless
    // of this phase's additional geometry-survival check.
    const battery = motif({ motif: 'battery', ply: 31, attacker: 'd1', targets: ['e1'], throughSquare: 'e1' });
    const batteryTrigger = ply({ ply: 31, movePlayedUci: 'f1e1', fenAfter: '4r1k1/8/8/8/8/8/8/3RR2K b - - 0 1' });
    const opponentCapturesFrontPiece = ply({
      ply: 32,
      sideToMove: 'b',
      movePlayedUci: 'e8e1',
      fenBefore: '4r1k1/8/8/8/8/8/8/3RR2K b - - 0 1'
    });

    const realized = isRealized(
      battery,
      inputs({
        ply: batteryTrigger,
        allPliesByNumber: new Map([
          [31, batteryTrigger],
          [32, opponentCapturesFrontPiece]
        ])
      })
    );

    expect(realized).toBe(false);
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
