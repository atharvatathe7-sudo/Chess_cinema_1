import { describe, expect, it } from 'vitest';
import { buildArchetypeSignals, resolveArchetypeRoles } from './archetypes';
import { DEFAULT_STORY_SETTINGS } from './types';
import type { ArchetypeSignal, CentralConflict, ConsequenceChain } from './types';
import {
  analysisFrom,
  causeConsequence,
  unknownOutcome,
  evidence,
  forcedSequence,
  gameArc,
  gameFrom,
  move,
  plyAnalysis,
  plySemantics,
  plySignals,
  turningPoint,
  understandingFrom
} from './storyFixtures';
import type { StoryBeat } from './types';

const emptyGame = gameFrom([]);
const emptyAnalysis = analysisFrom([]);

describe('buildArchetypeSignals — king-hunt', () => {
  it('passes an existing king-hunt narrativeSignal through unchanged, attaching overlapping beatIds', () => {
    const ev = evidence('chess-rule', [10, 11, 12, 13], 'forced check sequence ending in mate');
    const understanding = understandingFrom({
      plies: [],
      narrativeSignals: [{ archetype: 'king-hunt', supportingEvidence: [ev], confidence: 0.55 }]
    });
    const beat: StoryBeat = { id: 'beat-climax-12', role: 'climax', plies: [12], evidenceRefs: {}, salience: 500 };

    const signals = buildArchetypeSignals(emptyGame, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, [beat]);
    const kingHunt = signals.find((s) => s.archetype === 'king-hunt');
    expect(kingHunt).toBeDefined();
    expect(kingHunt!.plies).toEqual([10, 11, 12, 13]);
    expect(kingHunt!.beatIds).toEqual(['beat-climax-12']);
    expect(kingHunt!.evidence).toBe(ev); // reused directly, not copied
  });

  it('produces no signal when narrativeSignals has no king-hunt entry', () => {
    const understanding = understandingFrom({ plies: [], narrativeSignals: [] });
    const signals = buildArchetypeSignals(emptyGame, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'king-hunt')).toBeUndefined();
  });
});

describe('buildArchetypeSignals — pawn-journey', () => {
  it('detects a pawn that made at least minPawnJourneyPlies moves before promoting', () => {
    const game = gameFrom([
      move(1, { pieceId: 'w-p-e2', from: 'e2', to: 'e4' }),
      move(2, { pieceId: 'w-p-e2', from: 'e4', to: 'e5' }),
      move(3, { pieceId: 'w-p-e2', from: 'e5', to: 'e6', promotion: 'q' })
    ]);
    const understanding = understandingFrom({
      plies: [plySemantics(3, plySignals('w-p-e2', { isPromotion: true, promotionPieceType: 'q' }))]
    });

    const signals = buildArchetypeSignals(game, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    const journey = signals.find((s) => s.archetype === 'pawn-journey');
    expect(journey).toBeDefined();
    expect(journey!.plies).toEqual([1, 2, 3]);
  });

  it('does not flag a bare single-push promotion below minPawnJourneyPlies', () => {
    const game = gameFrom([move(1, { pieceId: 'w-p-e7', from: 'e7', to: 'e8', promotion: 'q' })]);
    const understanding = understandingFrom({
      plies: [plySemantics(1, plySignals('w-p-e7', { isPromotion: true, promotionPieceType: 'q' }))]
    });

    const signals = buildArchetypeSignals(game, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'pawn-journey')).toBeUndefined();
  });
});

describe('buildArchetypeSignals — stalemate-swindle', () => {
  it('detects a stalemate delivered by a side that was materially behind past the deficit floor', () => {
    const plies = [plyAnalysis(20, { sideToMove: 'b', evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' } })];
    const analysis = analysisFrom(plies);
    // Black delivers the stalemate; White was ahead by 900 just before it (materialDiff is White-relative), so Black's deficit is +900.
    const understanding = understandingFrom({ plies: [], gameArc: gameArc(0, 0, [{ ply: 19, materialDiff: 900 }]) });

    const signals = buildArchetypeSignals(emptyGame, analysis, understanding, DEFAULT_STORY_SETTINGS, []);
    const swindle = signals.find((s) => s.archetype === 'stalemate-swindle');
    expect(swindle).toBeDefined();
    expect(swindle!.plies).toEqual([20]);
  });

  it('does not flag a stalemate reached with only a small material deficit (below the floor)', () => {
    const plies = [plyAnalysis(20, { sideToMove: 'b', evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' } })];
    const analysis = analysisFrom(plies);
    const understanding = understandingFrom({ plies: [], gameArc: gameArc(0, 0, [{ ply: 19, materialDiff: 100 }]) });

    const signals = buildArchetypeSignals(emptyGame, analysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'stalemate-swindle')).toBeUndefined();
  });

  it('does not flag a stalemate delivered by the side that was AHEAD, even by a large margin', () => {
    // Mirrors the real, already-verified '...10. Qe6' stalemate PGN from Phase
    // 2.2.1: White captured two rooks and several pawns before accidentally
    // stalemating Black. White (the stalemating side) was massively ahead,
    // not behind — this is a squandered win, not a swindle, and must not be
    // flagged as one.
    const plies = [plyAnalysis(19, { sideToMove: 'w', evaluationAfter: { kind: 'terminal', result: 'draw', drawReason: 'stalemate' } })];
    const analysis = analysisFrom(plies);
    const understanding = understandingFrom({ plies: [], gameArc: gameArc(0, 0, [{ ply: 18, materialDiff: 1400 }]) });

    const signals = buildArchetypeSignals(emptyGame, analysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'stalemate-swindle')).toBeUndefined();
  });

  it('does not generalize to an ordinary (non-stalemate) draw', () => {
    const plies = [plyAnalysis(20, { sideToMove: 'b', evaluationAfter: { kind: 'terminal', result: 'draw' } })];
    const analysis = analysisFrom(plies);
    const understanding = understandingFrom({ plies: [], gameArc: gameArc(0, 0, [{ ply: 19, materialDiff: 900 }]) });

    const signals = buildArchetypeSignals(emptyGame, analysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'stalemate-swindle')).toBeUndefined();
  });
});

describe('buildArchetypeSignals — forced-trap', () => {
  it('detects an isSacrifice ply whose ForcedSequence resolves decisively', () => {
    const seq = forcedSequence('seq-trap', [7, 8, 9]);
    const cc = causeConsequence(9, { multiMoveConsequence: { sequenceId: 'seq-trap', endPly: 9 }, resolution: 'decisive-advantage' });
    const understanding = understandingFrom({
      plies: [plySemantics(7, plySignals('w-q-d1', { isSacrifice: true, forcedSequenceId: 'seq-trap' }))],
      sequences: [seq],
      turningPoints: [turningPoint(9, 'irreversible-material-loss', cc, 400)]
    });

    const signals = buildArchetypeSignals(emptyGame, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    const trap = signals.find((s) => s.archetype === 'forced-trap');
    expect(trap).toBeDefined();
    expect(trap!.plies).toEqual([7, 8, 9]);
  });

  it('does not flag a sacrifice whose forced sequence resolves to something other than a decisive result', () => {
    const seq = forcedSequence('seq-notrap', [7, 8, 9]);
    const cc = causeConsequence(9, { multiMoveConsequence: { sequenceId: 'seq-notrap', endPly: 9 }, resolution: 'repelled' });
    const understanding = understandingFrom({
      plies: [plySemantics(7, plySignals('w-q-d1', { isSacrifice: true, forcedSequenceId: 'seq-notrap' }))],
      sequences: [seq],
      turningPoints: [turningPoint(9, 'decisive-swing', cc, 200)]
    });

    const signals = buildArchetypeSignals(emptyGame, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'forced-trap')).toBeUndefined();
  });

  it('does not flag an isSacrifice ply that never joined a forced sequence', () => {
    const understanding = understandingFrom({
      plies: [plySemantics(7, plySignals('w-q-d1', { isSacrifice: true }))]
    });

    const signals = buildArchetypeSignals(emptyGame, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.find((s) => s.archetype === 'forced-trap')).toBeUndefined();
  });
});

describe('buildArchetypeSignals — deterministic ordering', () => {
  it('orders multiple detected archetypes alphabetically by name, then by first ply', () => {
    const gameHunt = evidence('chess-rule', [2, 3], 'king hunt');
    const seq = forcedSequence('seq-order', [4, 5]);
    const ccTrap = causeConsequence(5, { multiMoveConsequence: { sequenceId: 'seq-order', endPly: 5 }, resolution: 'forced-mate' });

    const gamePawn = gameFrom([
      move(1, { pieceId: 'w-p-h2', from: 'h2', to: 'h4' }),
      move(6, { pieceId: 'w-p-h2', from: 'h4', to: 'h5' }),
      move(8, { pieceId: 'w-p-h2', from: 'h5', to: 'h6', promotion: 'q' })
    ]);

    const understanding = understandingFrom({
      plies: [
        plySemantics(4, plySignals('w-q-d1', { isSacrifice: true, forcedSequenceId: 'seq-order' })),
        plySemantics(8, plySignals('w-p-h2', { isPromotion: true, promotionPieceType: 'q' }))
      ],
      sequences: [seq],
      turningPoints: [turningPoint(5, 'forced-mate-delivery', ccTrap, 900)],
      narrativeSignals: [{ archetype: 'king-hunt', supportingEvidence: [gameHunt], confidence: 0.55 }]
    });

    const signals = buildArchetypeSignals(gamePawn, emptyAnalysis, understanding, DEFAULT_STORY_SETTINGS, []);
    expect(signals.map((s) => s.archetype)).toEqual(['forced-trap', 'king-hunt', 'pawn-journey']);
  });
});

/**
 * Phase 15 (M9 + R1) — archetype lead/supporting resolution.
 */
describe('resolveArchetypeRoles', () => {
  const chain = (triggerPly: number, payoffPly: number): ConsequenceChain => ({
    triggerPly,
    antecedents: [],
    consequents: [{ ply: payoffPly, linkType: 'terminal-arrival', evidenceId: 't' }],
    payoff: { kind: 'checkmate', atPly: payoffPly },
    reachesResult: true,
    evidence: { basis: 'chess-rule', sourcePlies: [triggerPly], note: 'fixture' }
  });

  const conflict = (triggerPly: number, payoffPly: number): CentralConflict => ({
    primaryTurningPointId: `tp-${triggerPly}`,
    causalChain: [],
    secondaryConflicts: [],
    consequenceChain: chain(triggerPly, payoffPly),
    tier: 'A'
  });

  const signal = (archetype: ArchetypeSignal['archetype'], plies: readonly number[], beatIds: readonly string[]): ArchetypeSignal => ({
    archetype,
    plies,
    beatIds,
    evidence: { basis: 'chess-rule', sourcePlies: plies, note: 'fixture' }
  });

  const decidedOutcome = unknownOutcome({
    result: '1-0',
    termination: 'checkmate',
    onBoard: true,
    finalEvaluation: { kind: 'terminal', result: 'white-wins' },
    source: 'engine-terminal',
    confidence: 1
  });

  it('lets an archetype lead when it contains the trigger and participates in the story beats', () => {
    const roles = resolveArchetypeRoles([signal('forced-trap', [39, 40], ['beat-climax-40'])], conflict(40, 47), decidedOutcome);
    expect(roles.leadArchetype).toBe('forced-trap');
    expect(roles.supportingArchetypes).toEqual([]);
  });

  it('demotes an archetype that does not contain the trigger to supporting', () => {
    // The game-10 shape: a pawn journey running through a game whose
    // decisive moment it never touches.
    const roles = resolveArchetypeRoles([signal('pawn-journey', [3, 13, 41, 57], ['beat-climax-62'])], conflict(62, 118), decidedOutcome);
    expect(roles.leadArchetype).toBeNull();
    expect(roles.supportingArchetypes).toEqual(['pawn-journey']);
  });

  it('demotes an archetype that participates in no beat at all', () => {
    const roles = resolveArchetypeRoles([signal('pawn-journey', [40], [])], conflict(40, 47), decidedOutcome);
    expect(roles.leadArchetype).toBeNull();
  });

  it('resolves ties by the one existing archetype priority order', () => {
    const roles = resolveArchetypeRoles(
      [signal('king-hunt', [40], ['b1']), signal('forced-trap', [40], ['b1'])],
      conflict(40, 47),
      decidedOutcome
    );
    expect(roles.leadArchetype).toBe('forced-trap');
    expect(roles.supportingArchetypes).toEqual(['king-hunt']);
  });

  it('R1 — no archetype leads when the board contradicts the recorded result', () => {
    // A forced mate stood on the board while the game was recorded drawn.
    // The most surprising true thing about the game is how it ended, so the
    // ending owns the headline even though the archetype qualifies.
    const divergent = unknownOutcome({
      result: '1/2-1/2',
      termination: 'timeout-vs-insufficient-material',
      onBoard: false,
      finalEvaluation: { kind: 'mate', mateIn: 2 },
      source: 'termination-tag',
      confidence: 0.9
    });
    const roles = resolveArchetypeRoles([signal('pawn-journey', [111], ['beat-climax-111'])], conflict(111, 118), divergent);
    expect(roles.leadArchetype).toBeNull();
    expect(roles.supportingArchetypes).toEqual(['pawn-journey']);
  });

  it('no archetype leads when there is no central conflict at all', () => {
    const roles = resolveArchetypeRoles([signal('king-hunt', [1], ['b1'])], null, decidedOutcome);
    expect(roles.leadArchetype).toBeNull();
    expect(roles.supportingArchetypes).toEqual(['king-hunt']);
  });
});
