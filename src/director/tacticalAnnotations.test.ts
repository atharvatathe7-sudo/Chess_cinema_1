import { describe, expect, it } from 'vitest';
import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, KingMobilityRecord, TacticalMotif, TacticalMotifInstance } from '../understanding/types';
import {
  analysisFrom,
  causeConsequence,
  centralConflict,
  consequenceChain,
  plyAnalysis,
  plySemantics,
  plySignals,
  threatRecord,
  turningPoint,
  understandingFrom
} from '../story/storyFixtures';
import { gameFromMoves, moveRecord, storyBeat, storyPlanFrom } from './directorFixtures';
import { deriveTacticalDirectives } from './tacticalAnnotations';
import { buildCinematicPlan } from './buildCinematicPlan';
import { lowerToTimeline } from './lowerToTimeline';
import { DEFAULT_DIRECTOR_SETTINGS, type DirectorSettings, type TacticalAnnotationDirective } from './types';

/**
 * Phase 18C — every test here hand-supplies exactly the verified evidence
 * under test (the same "supply only what you care about" discipline
 * story/storyFixtures.ts already establishes) and asserts the geometry that
 * comes back. The point is never that the director can find tactics — it is
 * that it draws ONLY what upstream already verified, and draws it in the
 * right place.
 */

const SETTINGS = DEFAULT_DIRECTOR_SETTINGS;
/** Raises only the per-ply cap, so a test can see the full priority ordering rather than just its top 2. */
const ROOMY: DirectorSettings = { ...DEFAULT_DIRECTOR_SETTINGS, maxTacticalAnnotationsPerPly: 10 };

function motifInstance(id: string, motif: TacticalMotif, squares: TacticalMotifInstance['squares'], ply = 5): TacticalMotifInstance {
  return {
    id,
    ply,
    motif,
    squares,
    motifInstanceKey: `${motif}|${squares.attacker}`,
    firstSeenPly: ply,
    geometryEvidence: { basis: 'chess-rule', sourcePlies: [ply], note: `fixture ${motif}` }
  };
}

interface SceneOptions {
  readonly motifs?: readonly TacticalMotifInstance[];
  readonly mechanismMotifId?: string;
  readonly mechanismVerified?: boolean;
  readonly triggerFacts?: readonly ('defender-lost' | 'escape-square-removed')[];
  readonly consequents?: readonly { ply: number; causalFacts?: readonly ('defender-lost' | 'escape-square-removed')[] }[];
  readonly threats?: readonly ReturnType<typeof threatRecord>[];
  readonly threatIds?: readonly string[];
  readonly sequences?: readonly ForcedSequence[];
  readonly kingMobility?: readonly KingMobilityRecord[];
  readonly analysisPlies?: readonly PlyAnalysis[];
  readonly deliversCheckAtPly?: number;
  readonly extraBeats?: readonly ReturnType<typeof storyBeat>[];
}

/**
 * A 7-ply scene whose critical ply is 5, with a setup beat (plies 3-4), a
 * climax beat (5) and a consequence beat (6-7) — the ordinary beat shape
 * story/beats.ts produces, so role assignment is exercised realistically.
 */
function scene(options: SceneOptions = {}) {
  const moves = [
    moveRecord(1, 'w', 'p', 'e2', 'e4', 'e4'),
    moveRecord(2, 'b', 'p', 'e7', 'e5', 'e5'),
    moveRecord(3, 'w', 'n', 'g1', 'f3', 'Nf3'),
    moveRecord(4, 'b', 'n', 'b8', 'c6', 'Nc6'),
    moveRecord(5, 'w', 'b', 'f1', 'b5', 'Bb5'),
    moveRecord(6, 'b', 'p', 'a7', 'a6', 'a6'),
    moveRecord(7, 'w', 'q', 'd1', 'd5', 'Qd5')
  ];
  const game = gameFromMoves(moves);

  const analysis = analysisFrom(
    options.analysisPlies ?? moves.map((m) => plyAnalysis(m.ply, { sideToMove: m.color, movePlayedSan: m.san }))
  );

  const cc = causeConsequence(5, {
    ...(options.mechanismMotifId
      ? { mechanism: 'fork' as const, mechanismVerified: options.mechanismVerified ?? true, mechanismMotifId: options.mechanismMotifId }
      : {})
  });
  const tp = turningPoint(5, 'decisive-swing', cc, 600);

  const understanding = understandingFrom({
    plies: moves.map((m) =>
      plySemantics(m.ply, plySignals(m.pieceId, m.ply === options.deliversCheckAtPly ? { deliversCheck: true } : {}))
    ),
    motifs: [...(options.motifs ?? [])],
    threats: [...(options.threats ?? [])],
    sequences: [...(options.sequences ?? [])],
    turningPoints: [tp],
    kingMobility: [...(options.kingMobility ?? [])]
  });

  const chain = consequenceChain(5, {
    ...(options.triggerFacts ? { triggerFacts: options.triggerFacts } : {}),
    consequents: (options.consequents ?? []).map((c) => ({
      ply: c.ply,
      linkType: 'same-sequence' as const,
      evidenceId: 'seq-a',
      ...(c.causalFacts ? { causalFacts: c.causalFacts } : {})
    }))
  });

  const story = storyPlanFrom({
    centralConflict: centralConflict(tp.id, 5, { consequenceChain: chain }),
    noConflictReason: undefined,
    beats: [
      storyBeat('beat-setup-3', 'setup', [3, 4], { evidenceRefs: { threatIds: [...(options.threatIds ?? [])] } }),
      storyBeat('beat-climax-5', 'climax', [5], { evidenceRefs: { turningPointId: tp.id } }),
      storyBeat('beat-consequence-6', 'consequence', [6, 7], {}),
      ...(options.extraBeats ?? [])
    ],
    moveTreatment: moves.map((m) => ({ ply: m.ply, treatment: 'spine' as const }))
  });

  return { game, analysis, understanding, story };
}

function derive(options: SceneOptions = {}, settings: DirectorSettings = ROOMY): readonly TacticalAnnotationDirective[] {
  const { game, analysis, understanding, story } = scene(options);
  return deriveTacticalDirectives(game, analysis, understanding, story, settings);
}

function ofKind(directives: readonly TacticalAnnotationDirective[], kind: TacticalAnnotationDirective['kind']) {
  return directives.filter((d) => d.kind === kind);
}

describe('deriveTacticalDirectives — verified mechanism geometry', () => {
  it('a verified fork draws one attack arrow per verified target, from the motif\'s own attacker square', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    const attacks = ofKind(derive({ motifs: [motif], mechanismMotifId: motif.id }), 'mechanism-attack');

    expect(attacks.map((d) => d.squares)).toEqual([
      ['b5', 'c6'],
      ['b5', 'e8']
    ]);
    expect(attacks.every((d) => d.role === 'critical' && d.fromPly === 5)).toBe(true);
    expect(attacks[0]!.evidenceRef).toEqual({ kind: 'motif', motif: 'fork', motifId: 'm-fork' });
  });

  it('a verified pin draws the attack plus a distinct line marker on its own throughSquare', () => {
    const motif = motifInstance('m-pin', 'pin', { attacker: 'b5', targets: ['e8'], throughSquare: 'c6' });
    const directives = derive({ motifs: [motif], mechanismMotifId: motif.id });

    expect(ofKind(directives, 'mechanism-attack')[0]!.squares).toEqual(['b5', 'e8']);
    expect(ofKind(directives, 'mechanism-line')[0]!.squares).toEqual(['c6']);
    // A pin's through-square is a pinned piece, never a vacated origin.
    expect(ofKind(directives, 'mechanism-origin')).toEqual([]);
  });

  it('a verified discovery marks its throughSquare as the vacated ORIGIN, not a pinned piece', () => {
    const motif = motifInstance('m-disc', 'discovery', { attacker: 'd1', targets: ['d8'], throughSquare: 'd4' });
    const directives = derive({ motifs: [motif], mechanismMotifId: motif.id });

    expect(ofKind(directives, 'mechanism-origin')[0]!.squares).toEqual(['d4']);
    expect(ofKind(directives, 'mechanism-line')).toEqual([]);
  });

  it('a battery, whose detector reports through === target === the second attacker, never yields a zero-length arrow', () => {
    // findLineMotifs sets both `through` and `target` to the second piece; an
    // arrow to the attacker's own square would draw a dot.
    const motif = motifInstance('m-bat', 'battery', { attacker: 'd1', targets: ['d1'], throughSquare: 'd1' });
    const directives = derive({ motifs: [motif], mechanismMotifId: motif.id });

    expect(ofKind(directives, 'mechanism-attack')).toEqual([]);
    expect(ofKind(directives, 'mechanism-line')).toEqual([]);
  });
});

describe('deriveTacticalDirectives — unsupported claims never draw', () => {
  it('a motif that is merely present on the ply, without being the VERIFIED mechanism, draws nothing', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    // Present in understanding.motifs, but cc.mechanismMotifId is unset.
    const directives = derive({ motifs: [motif] });

    expect(ofKind(directives, 'mechanism-attack')).toEqual([]);
    // The honest fallback is the critical move's own geometry.
    expect(ofKind(directives, 'critical-move')[0]!.squares).toEqual(['f1', 'b5']);
  });

  it('a motif named as the mechanism but NOT verified draws nothing', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6'] });
    const directives = derive({ motifs: [motif], mechanismMotifId: motif.id, mechanismVerified: false });

    expect(ofKind(directives, 'mechanism-attack')).toEqual([]);
  });

  it('deflection and overload can never be annotated: no detector upstream produces either, so nothing references one', () => {
    // Both labels exist in the TacticalMotif union, but understanding/motifs.ts
    // only ever emits fork / pin / skewer / battery / discovery. This asserts
    // the director does not invent geometry for the two it can never receive.
    const directives = derive({ motifs: [], mechanismMotifId: 'm-deflection-that-does-not-exist' });

    expect(ofKind(directives, 'mechanism-attack')).toEqual([]);
    expect(directives.every((d) => d.evidenceRef.kind !== 'motif')).toBe(true);
  });

  it('abstention: a StoryPlan with no central conflict produces no tactical annotations at all', () => {
    const { game, analysis, understanding } = scene();
    const story = storyPlanFrom({ centralConflict: null, noConflictReason: 'no-admissible-candidate' });
    expect(deriveTacticalDirectives(game, analysis, understanding, story, SETTINGS)).toEqual([]);
  });
});

describe('deriveTacticalDirectives — verified causal facts', () => {
  // The same real, legal position understanding/defenders.test.ts validates:
  // the black knight on d5 is defended once by the bishop on e6; Bxe6 removes
  // that defender and d5 becomes winnable.
  const FEN_BEFORE = '4k3/8/4b3/3n4/8/7B/8/3RK3 w - - 0 1';
  const FEN_AFTER = '4k3/8/4B3/3n4/8/8/8/3RK3 b - - 0 1';

  function defenderLossPlies(): PlyAnalysis[] {
    return [1, 2, 3, 4, 5, 6, 7].map((ply) =>
      ply === 5
        ? { ...plyAnalysis(5), sideToMove: 'w' as const, movePlayedUci: 'h3e6', movePlayedSan: 'Bxe6', fenBefore: FEN_BEFORE, fenAfter: FEN_AFTER }
        : plyAnalysis(ply)
    );
  }

  it('defender-lost draws the real detectDefenderLoss pair: departed defender -> the target whose defence collapsed', () => {
    const directives = derive({ triggerFacts: ['defender-lost'], analysisPlies: defenderLossPlies() });
    const loss = ofKind(directives, 'defender-loss');

    expect(loss).toHaveLength(1);
    expect(loss[0]!.squares).toEqual(['e6', 'd5']);
    expect(loss[0]!.evidenceRef).toEqual({ kind: 'causal-fact', fact: 'defender-lost', ply: 5 });
    expect(loss[0]!.role).toBe('critical');
  });

  it('a defender-lost fact recorded on a CONSEQUENT ply is drawn there, in the consequence role', () => {
    const plies = defenderLossPlies();
    const directives = derive({
      consequents: [{ ply: 6, causalFacts: ['defender-lost'] }],
      // Move the real defender-loss position onto ply 6.
      analysisPlies: plies.map((p) =>
        p.ply === 6
          ? { ...p, sideToMove: 'w' as const, movePlayedUci: 'h3e6', movePlayedSan: 'Bxe6', fenBefore: FEN_BEFORE, fenAfter: FEN_AFTER }
          : p.ply === 5
            ? plyAnalysis(5)
            : p
      )
    });

    const loss = ofKind(directives, 'defender-loss');
    expect(loss).toHaveLength(1);
    expect(loss[0]!.fromPly).toBe(6);
    expect(loss[0]!.role).toBe('consequence');
  });

  it('a defender-lost fact whose position yields no real record draws nothing', () => {
    // Facts are claimed, but the ply's own FENs are the fixture defaults, so
    // the pure detector finds nothing — and nothing is drawn.
    expect(ofKind(derive({ triggerFacts: ['defender-lost'] }), 'defender-loss')).toEqual([]);
  });

  it('escape-square-removed marks the king plus exactly the escape squares that disappeared', () => {
    const before: KingMobilityRecord = { ply: 4, color: 'b', legalEscapeSquares: ['b7', 'b8', 'a7'], legalEscapeSquareCount: 3 };
    const after: KingMobilityRecord = { ply: 6, color: 'b', legalEscapeSquares: ['b8'], legalEscapeSquareCount: 1 };
    const plies = [1, 2, 3, 4, 5, 6, 7].map((ply) =>
      // ply 3 fixes where the king stood when the BEFORE record was measured;
      // ply 5 is the annotated ply itself. Same square in both: a stationary king.
      ply === 3 || ply === 5 ? { ...plyAnalysis(ply), fenAfter: 'k7/8/8/8/8/8/8/K7 w - - 0 1' } : plyAnalysis(ply)
    );

    const directives = derive({ triggerFacts: ['escape-square-removed'], kingMobility: [before, after], analysisPlies: plies });
    const escape = ofKind(directives, 'escape-square-removed');

    expect(escape).toHaveLength(1);
    expect(escape[0]!.squares).toEqual(['a8', 'b7', 'a7']); // king first, then exactly the removed squares
    expect(escape[0]!.evidenceRef).toEqual({ kind: 'causal-fact', fact: 'escape-square-removed', ply: 5 });
  });

  it('escape-square-removed never claims the square the king itself moved to', () => {
    // The king ends on a8. A raw set difference reports a8 as "removed"
    // purely because the after-record is measured from a8 — highlighting it
    // would put a marker under a king standing there safely, and would also
    // duplicate the king square the directive already leads with.
    const before: KingMobilityRecord = { ply: 4, color: 'b', legalEscapeSquares: ['a8', 'b7'], legalEscapeSquareCount: 2 };
    const after: KingMobilityRecord = { ply: 6, color: 'b', legalEscapeSquares: [], legalEscapeSquareCount: 0 };
    const plies = [1, 2, 3, 4, 5, 6, 7].map((ply) =>
      // ply 3 fixes where the king stood when the BEFORE record was measured;
      // ply 5 is the annotated ply itself. Same square in both: a stationary king.
      ply === 3 || ply === 5 ? { ...plyAnalysis(ply), fenAfter: 'k7/8/8/8/8/8/8/K7 w - - 0 1' } : plyAnalysis(ply)
    );

    const escape = ofKind(
      derive({ triggerFacts: ['escape-square-removed'], kingMobility: [before, after], analysisPlies: plies }),
      'escape-square-removed'
    );

    expect(escape).toHaveLength(1);
    expect(escape[0]!.squares).toEqual(['a8', 'b7']);
  });

  it('escape-square-removed draws nothing when the king square is the only apparent removal', () => {
    // Nothing was actually taken away, so the verified count-based fact
    // stands unillustrated rather than mis-illustrated.
    const before: KingMobilityRecord = { ply: 4, color: 'b', legalEscapeSquares: ['a8'], legalEscapeSquareCount: 1 };
    const after: KingMobilityRecord = { ply: 6, color: 'b', legalEscapeSquares: [], legalEscapeSquareCount: 0 };
    const plies = [1, 2, 3, 4, 5, 6, 7].map((ply) =>
      // ply 3 fixes where the king stood when the BEFORE record was measured;
      // ply 5 is the annotated ply itself. Same square in both: a stationary king.
      ply === 3 || ply === 5 ? { ...plyAnalysis(ply), fenAfter: 'k7/8/8/8/8/8/8/K7 w - - 0 1' } : plyAnalysis(ply)
    );

    expect(
      ofKind(derive({ triggerFacts: ['escape-square-removed'], kingMobility: [before, after], analysisPlies: plies }), 'escape-square-removed')
    ).toEqual([]);
  });

  it('escape-square-removed draws nothing when the king itself relocated between the bracketing records', () => {
    // The before-record was measured from b8, the king now stands on a8, so
    // the two escape lists are not comparable square-by-square and none of
    // the apparent removals can be honestly attributed to this move.
    const before: KingMobilityRecord = { ply: 4, color: 'b', legalEscapeSquares: ['c8', 'b7'], legalEscapeSquareCount: 2 };
    const after: KingMobilityRecord = { ply: 6, color: 'b', legalEscapeSquares: [], legalEscapeSquareCount: 0 };
    const plies = [1, 2, 3, 4, 5, 6, 7].map((ply) =>
      ply === 3
        ? { ...plyAnalysis(3), fenAfter: '1k6/8/8/8/8/8/8/K7 w - - 0 1' }
        : ply === 5
          ? { ...plyAnalysis(5), fenAfter: 'k7/8/8/8/8/8/8/K7 w - - 0 1' }
          : plyAnalysis(ply)
    );

    expect(
      ofKind(derive({ triggerFacts: ['escape-square-removed'], kingMobility: [before, after], analysisPlies: plies }), 'escape-square-removed')
    ).toEqual([]);
  });

  it('escape-square-removed draws nothing when no square actually disappeared', () => {
    const before: KingMobilityRecord = { ply: 4, color: 'b', legalEscapeSquares: ['b7'], legalEscapeSquareCount: 1 };
    const after: KingMobilityRecord = { ply: 6, color: 'b', legalEscapeSquares: ['b7'], legalEscapeSquareCount: 1 };
    expect(ofKind(derive({ triggerFacts: ['escape-square-removed'], kingMobility: [before, after] }), 'escape-square-removed')).toEqual([]);
  });
});

describe('deriveTacticalDirectives — threat, refutation, forced response, check', () => {
  it('a refuted threat draws the threatened square and an arrow from the refuting move to it', () => {
    const threat = threatRecord('threat-1', 3, 'w', 'mate-threat', 'c6', { refutedBy: { ply: 4, moveUci: 'b8c6' } });
    const directives = derive({ threats: [threat], threatIds: ['threat-1'] });

    const target = ofKind(directives, 'threat-target')[0]!;
    expect(target.squares).toEqual(['c6']);
    expect(target.role).toBe('establish');
    // The threat marker lasts from the threat until the move that answers it.
    expect([target.fromPly, target.toPly]).toEqual([3, 4]);

    const refutation = ofKind(directives, 'refutation')[0]!;
    // Nc6 refutes by TAKING the threatened square, so destination === target;
    // the arrow shows the piece's own journey onto it rather than a dot.
    expect(refutation.squares).toEqual(['b8', 'c6']);
    expect(refutation.pieceId).toBe('b-n-b8');
    expect(refutation.evidenceRef).toEqual({ kind: 'threat', threatId: 'threat-1' });
  });

  it('a refutation that answers a threat from elsewhere keeps the ordinary destination -> threatened-square geometry', () => {
    // Nf3 (ply 3) lands on f3 while the threat is against c6 — the refuting
    // piece covers the square from a distance, so the arrow runs f3 -> c6.
    const threat = threatRecord('threat-1', 2, 'b', 'material-winning-threat', 'c6', { refutedBy: { ply: 3, moveUci: 'g1f3' } });
    const refutation = ofKind(derive({ threats: [threat], threatIds: ['threat-1'] }), 'refutation')[0]!;

    expect(refutation.squares).toEqual(['f3', 'c6']);
  });

  it('never emits a zero-length arrow, whatever the source geometry', () => {
    const threat = threatRecord('threat-1', 3, 'w', 'mate-threat', 'c6', { refutedBy: { ply: 4, moveUci: 'b8c6' } });
    const motif = motifInstance('m-bat', 'battery', { attacker: 'd1', targets: ['d1'] });
    const directives = derive({ threats: [threat], threatIds: ['threat-1'], motifs: [motif], mechanismMotifId: motif.id });

    for (const d of directives) {
      if (d.squares.length >= 2) expect(d.squares[0]).not.toBe(d.squares[1]);
    }
  });

  it('an unrefuted threat draws only the threatened square — never an arrow from a refutation that never happened', () => {
    const threat = threatRecord('threat-1', 3, 'w', 'mate-threat', 'c6');
    const directives = derive({ threats: [threat], threatIds: ['threat-1'] });

    expect(ofKind(directives, 'threat-target')[0]!.toPly).toBe(3);
    expect(ofKind(directives, 'refutation')).toEqual([]);
  });

  it('a reply inside a ForcedSequence is drawn on its own from -> to; the sequence\'s opening move is not "forced"', () => {
    const sequence: ForcedSequence = {
      id: 'seq-a',
      startPly: 5,
      endPly: 7,
      plies: [5, 6, 7],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [5, 6, 7], note: 'fixture' }
    };
    const directives = derive({ sequences: [sequence], consequents: [{ ply: 6 }, { ply: 7 }] });
    const forced = ofKind(directives, 'forced-response');

    expect(forced.map((d) => d.squares)).toEqual([
      ['a7', 'a6'],
      ['d1', 'd5']
    ]);
    expect(forced.every((d) => d.role === 'consequence')).toBe(true);
    expect(forced[0]!.evidenceRef).toEqual({ kind: 'forced-sequence', sequenceId: 'seq-a' });
    // Ply 5 is the sequence's own startPly — the move that forced, not a forced reply.
    expect(forced.some((d) => d.fromPly === 5)).toBe(false);
  });

  it('a checking move marks the checked king\'s own square, read from that ply\'s real board', () => {
    const plies = [1, 2, 3, 4, 5, 6, 7].map((ply) =>
      ply === 5 ? { ...plyAnalysis(5), fenAfter: 'k7/8/8/8/8/8/8/K7 w - - 0 1' } : plyAnalysis(ply)
    );
    const check = ofKind(derive({ deliversCheckAtPly: 5, analysisPlies: plies }), 'check-marker');

    expect(check).toHaveLength(1);
    expect(check[0]!.squares).toEqual(['a8']); // White moved at ply 5, so Black's king is the checked one
    expect(check[0]!.evidenceRef).toEqual({ kind: 'terminal', ply: 5 });
  });

  it('a ply whose own signals claim no check draws no check marker', () => {
    expect(ofKind(derive(), 'check-marker')).toEqual([]);
  });
});

describe('deriveTacticalDirectives — conflict handling', () => {
  it('suppresses the plain critical-move arrow when a stronger mechanism already runs between the same squares', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'f1', targets: ['b5'] });
    const directives = derive({ motifs: [motif], mechanismMotifId: motif.id });

    // The critical move IS f1->b5; the verified mechanism already says it.
    expect(ofKind(directives, 'mechanism-attack')[0]!.squares).toEqual(['f1', 'b5']);
    expect(ofKind(directives, 'critical-move')).toEqual([]);
  });

  it('keeps the critical-move arrow when the mechanism explains different squares', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    const directives = derive({ motifs: [motif], mechanismMotifId: motif.id });
    expect(ofKind(directives, 'critical-move')).toHaveLength(1);
  });

  it('caps how many annotations may share a ply, keeping the strongest by fixed priority', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8', 'g8'] });
    const capped = derive({ motifs: [motif], mechanismMotifId: motif.id }, DEFAULT_DIRECTOR_SETTINGS);

    const onCritical = capped.filter((d) => d.fromPly === 5);
    expect(onCritical).toHaveLength(DEFAULT_DIRECTOR_SETTINGS.maxTacticalAnnotationsPerPly);
    // Both survivors are the top-priority kind, not a mix that dropped an attack for a weaker marker.
    expect(onCritical.every((d) => d.kind === 'mechanism-attack')).toBe(true);
  });

  it('is deterministic and ordered by ply, then by fixed priority', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    const options: SceneOptions = {
      motifs: [motif],
      mechanismMotifId: motif.id,
      threats: [threatRecord('threat-1', 3, 'w', 'mate-threat', 'c6', { refutedBy: { ply: 4, moveUci: 'b8c6' } })],
      threatIds: ['threat-1']
    };
    const first = derive(options);
    const second = derive(options);

    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
    for (let i = 1; i < first.length; i++) {
      const prev = first[i - 1]!;
      const cur = first[i]!;
      expect(prev.fromPly < cur.fromPly || (prev.fromPly === cur.fromPly && prev.priority <= cur.priority)).toBe(true);
    }
  });
});

describe('tactical annotations — beat timing and clip window', () => {
  it('attaches each annotation to the beat phase it explains', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    const sequence: ForcedSequence = {
      id: 'seq-a',
      startPly: 5,
      endPly: 7,
      plies: [5, 6, 7],
      forcingReason: 'check',
      evidence: { basis: 'chess-rule', sourcePlies: [5], note: 'fixture' }
    };
    const directives = derive({
      motifs: [motif],
      mechanismMotifId: motif.id,
      threats: [threatRecord('threat-1', 3, 'w', 'mate-threat', 'c6', { refutedBy: { ply: 4, moveUci: 'b8c6' } })],
      threatIds: ['threat-1'],
      sequences: [sequence],
      consequents: [{ ply: 6 }]
    });

    const roleByPly = new Map(directives.map((d) => [d.fromPly, d.role]));
    expect(roleByPly.get(3)).toBe('establish');
    expect(roleByPly.get(4)).toBe('establish');
    expect(roleByPly.get(5)).toBe('critical');
    expect(roleByPly.get(6)).toBe('consequence');
    // Every directive's own span stays within the plies it explains.
    expect(directives.every((d) => d.toPly >= d.fromPly)).toBe(true);
  });

  it('lowers into ordinary AnnotationBeats on the existing timeline, timed on their own plies', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    const { game, analysis, understanding, story } = scene({ motifs: [motif], mechanismMotifId: motif.id });
    const plan = buildCinematicPlan(game, analysis, understanding, story);
    const timeline = lowerToTimeline(game, plan, story);

    expect(plan.tacticalDirectives.length).toBeGreaterThan(0);
    const moveBeats = timeline.scenes[0]!.beats.filter((b) => b.kind === 'move');
    const criticalBeat = moveBeats.find((b) => b.kind === 'move' && b.resultingPly === 5)!;

    const arrows = timeline.scenes[0]!.beats.filter((b) => b.kind === 'annotation' && b.annotation.type === 'arrow');
    const mechanismArrow = arrows.find((b) => b.kind === 'annotation' && b.annotation.squares[0] === 'b5');
    expect(mechanismArrow).toBeDefined();
    expect(mechanismArrow!.atMs).toBe(criticalBeat.atMs);
  });

  it('annotations for plies outside the selected clip window are never emitted into the Scene', () => {
    const motif = motifInstance('m-fork', 'fork', { attacker: 'b5', targets: ['c6', 'e8'] });
    const { game, analysis, understanding, story } = scene({
      motifs: [motif],
      mechanismMotifId: motif.id,
      threats: [threatRecord('threat-1', 3, 'w', 'mate-threat', 'c6', { refutedBy: { ply: 4, moveUci: 'b8c6' } })],
      threatIds: ['threat-1']
    });
    const plan = buildCinematicPlan(game, analysis, understanding, story);

    // The chain has no antecedents, so the window starts at the critical ply
    // (5): the setup-beat annotations on plies 3-4 are genuinely outside it.
    expect(plan.tacticalDirectives.some((d) => d.fromPly < 5)).toBe(true);

    const timeline = lowerToTimeline(game, plan, story);
    const windowedPlies = new Set(timeline.scenes[0]!.beats.filter((b) => b.kind === 'move').map((b) => (b.kind === 'move' ? b.resultingPly : -1)));
    expect(windowedPlies.has(3)).toBe(false);

    // Nothing in the Scene points at the pre-window threat square pair.
    const annotations = timeline.scenes[0]!.beats.filter((b) => b.kind === 'annotation');
    for (const beat of annotations) {
      if (beat.kind !== 'annotation') continue;
      expect(beat.atMs).toBeGreaterThanOrEqual(0);
      expect(beat.untilMs).toBeLessThanOrEqual(timeline.scenes[0]!.durationMs);
    }
  });
});
