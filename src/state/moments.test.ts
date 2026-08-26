import { describe, expect, it } from 'vitest';
import { ChessJsEngine } from '../chess/ChessJsEngine';
import { parsePgn } from '../pgn/parsePgn';
import { DEFAULT_DIRECTOR_SETTINGS, DIRECTOR_SCHEMA_VERSION, type AnnotationDirective, type AnnotationDirectiveKind, type CinematicPlan } from '../director/types';
import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import { DEFAULT_ANALYSIS_SETTINGS } from '../analysis/types';
import {
  DEFAULT_UNDERSTANDING_SETTINGS,
  UNDERSTANDING_SCHEMA_VERSION,
  type CauseConsequenceRecord,
  type Evidence,
  type GameUnderstanding,
  type TacticalMotif,
  type TacticalMotifInstance,
  type ThreatRecord,
  type TurningPoint
} from '../understanding/types';
import { DEFAULT_STORY_SETTINGS, STORY_SCHEMA_VERSION, type StoryBeat, type StoryPlan } from '../story/types';
import type { MoveBeat, Timeline } from '../timeline/types';
import { createInitialState, type AppState } from './AppState';
import { Store } from './store';
import { deriveCinematicMoments, goToNextMoment, goToPreviousMoment } from './moments';

/**
 * Fixture builders. director/annotations.ts and director/lowerToTimeline.ts
 * are already independently tested elsewhere (director/annotations.test.ts,
 * director/lowerToTimeline.test.ts) for producing correct
 * AnnotationDirective/AnnotationBeat data in the first place — these tests
 * are about moments.ts's own derivation/merge/navigation/reason logic given
 * that data, so the fixtures below are hand-built directly rather than run
 * through the real pipeline (same "ScriptedEngine"-style precedent already
 * established in analysis/analyzeGame.test.ts and understanding/
 * understandGame.test.ts).
 */

function moveBeat(ply: number, atMs: number, durationMs: number): MoveBeat {
  return {
    kind: 'move',
    san: `move${ply}`,
    pieceId: `w-p-${ply}` as never,
    from: 'e2',
    to: 'e4',
    atMs,
    durationMs,
    isEnPassant: false,
    resultingPly: ply
  };
}

/** Builds a single-scene Timeline whose moves have the given durations, back to back with no gaps. */
function timelineFromDurations(durationsMs: readonly number[]): Timeline {
  const beats: MoveBeat[] = [];
  let cursor = 0;
  for (let i = 0; i < durationsMs.length; i++) {
    const ply = i + 1;
    beats.push(moveBeat(ply, cursor, durationsMs[i]!));
    cursor += durationsMs[i]!;
  }
  return {
    scenes: [
      {
        id: 'scene-0',
        startPositionFen: 'startpos',
        startPly: 0,
        beats,
        cameraPlan: { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] },
        durationMs: cursor
      }
    ]
  };
}

function directive(
  kind: AnnotationDirectiveKind,
  fromPly: number,
  toPly: number,
  evidenceRef: AnnotationDirective['evidenceRef'] = { kind: 'move', ply: fromPly }
): AnnotationDirective {
  return { fromPly, toPly, kind, squares: ['e2', 'e4'], evidenceRef };
}

function cinematicPlan(annotationDirectives: readonly AnnotationDirective[]): CinematicPlan {
  return {
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
    moveTreatmentPlan: [],
    cameraDirectives: [],
    annotationDirectives,
    transitionDirectives: [],
    finalPositionIsTerminal: false,
    settings: DEFAULT_DIRECTOR_SETTINGS
  };
}

function plyAnalysis(ply: number, evaluationAfter: PlyAnalysis['evaluationAfter']): PlyAnalysis {
  return {
    ply,
    moveNumber: Math.ceil(ply / 2),
    sideToMove: ply % 2 === 1 ? 'w' : 'b',
    movePlayedSan: `m${ply}`,
    movePlayedUci: 'e2e4',
    fenBefore: 'startpos',
    fenAfter: 'startpos',
    evaluationBefore: { kind: 'cp', cp: 0 },
    evaluationAfter,
    bestMove: null,
    principalVariation: [],
    swingCp: 0,
    swingForMoverCp: 0,
    mateTransition: 'none',
    depth: 12
  };
}

function analysisEndingWith(plyCount: number, finalEvaluationAfter: PlyAnalysis['evaluationAfter']): GameAnalysis {
  const plies: PlyAnalysis[] = [];
  for (let ply = 1; ply <= plyCount; ply++) {
    const isLast = ply === plyCount;
    plies.push(plyAnalysis(ply, isLast ? finalEvaluationAfter : { kind: 'cp', cp: 0 }));
  }
  return { plies, candidates: [], settings: DEFAULT_ANALYSIS_SETTINGS };
}

const QUIET_ANALYSIS = analysisEndingWith(6, { kind: 'cp', cp: 10 });

function emptyEvidence(sourcePlies: readonly number[]): Evidence {
  return { basis: 'chess-rule', sourcePlies, note: '' };
}

/** A GameUnderstanding with only the fields Phase 2.7/Phase 3's reason-derivation actually reads populated; everything else is a valid, empty placeholder. */
function understandingFixture(overrides: {
  threats?: readonly ThreatRecord[];
  turningPoints?: readonly TurningPoint[];
  motifs?: readonly TacticalMotifInstance[];
} = {}): GameUnderstanding {
  return {
    schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
    plies: [],
    motifs: overrides.motifs ?? [],
    threats: overrides.threats ?? [],
    sequences: [],
    turningPoints: overrides.turningPoints ?? [],
    kingMobility: [],
    gameArc: { openingEndPly: 0, middlegameEndPly: 0, materialTrajectory: [], evidence: emptyEvidence([]) },
    narrativeSignals: [],
    settings: DEFAULT_UNDERSTANDING_SETTINGS
  };
}

/** A StoryPlan with only `beats` populated — Phase 2.7's reason-derivation reads no other field. */
function storyFixture(overrides: { beats?: readonly StoryBeat[] } = {}): StoryPlan {
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    centralConflict: null,
    noConflictReason: 'no-turning-points',
    beats: overrides.beats ?? [],
    moveTreatment: [],
    archetypeSignals: [],
    pieceContributions: [],
    explanationOpportunities: [],
    settings: DEFAULT_STORY_SETTINGS
  };
}

const EMPTY_UNDERSTANDING = understandingFixture();
const EMPTY_STORY = storyFixture();

function threatRecord(kind: ThreatRecord['kind'], ply: number, refutedByPly: number): ThreatRecord {
  return {
    id: `threat-${ply}`,
    ply,
    side: 'w',
    kind,
    targetSquare: 'e4',
    refutedBy: { ply: refutedByPly, moveUci: 'e7e5' },
    evidence: emptyEvidence([ply])
  };
}

/** Phase 4 — squares default to a fixed placeholder unrelated to the default 'e2e4' movePlayed (i.e. structurally ungrounded), unless a test explicitly overrides them to align with a specific move. */
function motifInstance(
  id: string,
  ply: number,
  motif: TacticalMotif,
  significant: boolean,
  squares: { attacker: string; targets: readonly string[]; throughSquare?: string } = { attacker: 'a1', targets: ['a2'] }
): TacticalMotifInstance {
  return {
    id,
    ply,
    motif,
    squares,
    geometryEvidence: emptyEvidence([ply]),
    ...(significant ? { significanceEvidence: emptyEvidence([ply]) } : {})
  };
}

/** Phase 3/4 — threatsRemoved/motifsTriggered/movePlayed are overridable; threatsRemoved and motifsTriggered default to [] and movePlayed defaults to 'e2e4' to match every pre-Phase-4 call site exactly. */
function causeConsequence(
  mechanism: CauseConsequenceRecord['mechanism'],
  resolution: CauseConsequenceRecord['resolution'],
  ply: number,
  overrides: { threatsRemoved?: readonly string[]; motifsTriggered?: readonly string[]; movePlayed?: { san: string; uci: string } } = {}
): CauseConsequenceRecord {
  return {
    id: `cc-${ply}`,
    ply,
    positionBefore: 'startpos',
    movePlayed: overrides.movePlayed ?? { san: 'm', uci: 'e2e4' },
    immediateChange: { evaluationDelta: { swingCp: 0, swingForMoverCp: 0 }, materialDelta: 0, motifsTriggered: overrides.motifsTriggered ?? [] },
    threatsCreated: [],
    threatsRemoved: overrides.threatsRemoved ?? [],
    mechanism,
    bestAlternative: {
      topMove: null,
      topMoveEvaluation: { kind: 'cp', cp: 0 },
      playedMoveWasTopMove: true,
      playedMoveEffectivelyEquivalent: true,
      bestMoveUniqueness: 'unknown',
      alternativesConsidered: [],
      evidence: emptyEvidence([ply])
    },
    evaluationConsequence: { atPly: ply, swingCp: 0 },
    materialConsequence: { atPly: ply, netMaterialChange: 0 },
    resolution,
    evidence: emptyEvidence([ply])
  };
}

function turningPoint(
  id: string,
  ply: number,
  mechanism: CauseConsequenceRecord['mechanism'],
  resolution: CauseConsequenceRecord['resolution'],
  overrides: { threatsRemoved?: readonly string[]; motifsTriggered?: readonly string[]; movePlayed?: { san: string; uci: string } } = {}
): TurningPoint {
  return {
    id,
    ply,
    kind: 'decisive-swing',
    significance: { score: 1, reasons: [] },
    causeConsequence: causeConsequence(mechanism, resolution, ply, overrides)
  };
}

function climaxBeat(id: string, ply: number, turningPointId: string): StoryBeat {
  return { id, role: 'climax', plies: [ply], evidenceRefs: { turningPointId }, salience: 1 };
}

describe('deriveCinematicMoments', () => {
  it('A: excludes last-move', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    const plan = cinematicPlan([directive('last-move', 1, 1), directive('last-move', 2, 2), directive('last-move', 3, 3)]);
    expect(deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY)).toEqual([]);
  });

  it('B: includes all four meaningful annotation kinds, each with a non-empty reason', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600]);
    const plan = cinematicPlan([
      directive('threat-refutation-arrow', 1, 1),
      directive('central-conflict-highlight', 2, 2),
      directive('archetype-track', 3, 3, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
      directive('terminal-result-highlight', 4, 4, { kind: 'terminal' })
    ]);
    const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(4, { kind: 'terminal', result: 'white-wins' }), EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moments.map((m) => m.kind)).toEqual([
      'threat-refutation-arrow',
      'central-conflict-highlight',
      'archetype-track',
      'terminal-result-highlight'
    ]);
    expect(moments.map((m) => m.label)).toEqual(['Threat Refutation', 'Climax', 'King Hunt', 'Checkmate']);
    for (const m of moments) {
      expect(m.reason.length).toBeGreaterThan(0);
    }
  });

  it('C: deterministic chronological ordering, byte-identical across calls', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600]);
    const plan = cinematicPlan([
      directive('terminal-result-highlight', 4, 4, { kind: 'terminal' }),
      directive('threat-refutation-arrow', 1, 1)
    ]);
    const analysis = analysisEndingWith(4, { kind: 'terminal', result: 'black-wins' });
    const first = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
    const second = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(first).toEqual(second);
    expect(first.map((m) => m.fromPly)).toEqual([1, 4]);
  });

  it('D: target timestamp is strictly inside [atMs, untilMs) — Phase 2.6 invariant unchanged by Phase 2.7', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
    const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moment!.atMs).toBe(600);
    expect(moment!.untilMs).toBe(1200);
    expect(moment!.targetTimeMs).toBe(1199);
    expect(moment!.atMs <= moment!.targetTimeMs).toBe(true);
    expect(moment!.targetTimeMs < moment!.untilMs).toBe(true);
  });

  it('E: terminal moment target is strictly less than scene.durationMs', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    expect(timeline.scenes[0]!.durationMs).toBe(1800);
    const plan = cinematicPlan([directive('terminal-result-highlight', 3, 3, { kind: 'terminal' })]);
    const analysis = analysisEndingWith(3, { kind: 'terminal', result: 'draw', drawReason: 'stalemate' });
    const [moment] = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moment!.untilMs).toBe(timeline.scenes[0]!.durationMs);
    expect(moment!.targetTimeMs).toBeLessThan(timeline.scenes[0]!.durationMs);
    expect(moment!.targetTimeMs).toBe(1799);
    expect(moment!.label).toBe('Stalemate');
    expect(moment!.reason).toBe('The game ended in a stalemate — a draw by no legal moves.');
  });

  it('F: overlapping directives merge into one moment (unchanged by Phase 2.7)', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600, 600]);
    const plan = cinematicPlan([
      directive('archetype-track', 2, 4, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
      directive('central-conflict-highlight', 3, 5)
    ]);
    const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(5, { kind: 'cp', cp: 0 }), EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.fromPly).toBe(2);
    expect(moments[0]!.toPly).toBe(5);
    // archetype-track (3) outranks central-conflict-highlight (2) in KIND_PRIORITY.
    expect(moments[0]!.kind).toBe('archetype-track');
    expect(moments[0]!.label).toBe('King Hunt');
    expect(moments[0]!.reason).toBe('A forced sequence of checks drove the king across the board, ending in mate.');
    // Phase 2.8: the lower-priority Climax narrative is no longer discarded.
    expect(moments[0]!.narratives).toEqual([
      { label: 'King Hunt', reason: 'A forced sequence of checks drove the king across the board, ending in mate.' },
      { label: 'Climax', reason: 'The decisive moment of the game.' }
    ]);
  });

  it('G: non-overlapping directives remain separate (unchanged by Phase 2.7), each with exactly one narrative (Phase 2.8)', () => {
    const timeline = timelineFromDurations([600, 600, 600, 600, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 1, 1), directive('archetype-track', 4, 5, { kind: 'archetypeSignal', archetype: 'pawn-journey' })]);
    const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(5, { kind: 'cp', cp: 0 }), EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moments).toHaveLength(2);
    expect(moments.map((m) => [m.fromPly, m.toPly])).toEqual([
      [1, 1],
      [4, 5]
    ]);
    for (const m of moments) {
      expect(m.narratives).toHaveLength(1);
      expect(m.narratives[0]).toEqual({ label: m.label, reason: m.reason });
    }
  });

  it('H: KIND_ORDER priority is respected for the merged label (terminal-result-highlight wins over central-conflict-highlight), and the lower-priority Climax narrative is preserved as narratives[1] (Phase 2.8)', () => {
    const timeline = timelineFromDurations([600, 600]);
    const plan = cinematicPlan([directive('central-conflict-highlight', 1, 2), directive('terminal-result-highlight', 2, 2, { kind: 'terminal' })]);
    const analysis = analysisEndingWith(2, { kind: 'terminal', result: 'white-wins' });
    const moments = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.kind).toBe('terminal-result-highlight');
    expect(moments[0]!.label).toBe('Checkmate');
    expect(moments[0]!.reason).toBe('The game ended in checkmate.');
    expect(moments[0]!.narratives).toEqual([
      { label: 'Checkmate', reason: 'The game ended in checkmate.' },
      { label: 'Climax', reason: 'The decisive moment of the game.' }
    ]);
  });

  it('I: no moment-worthy directives produces an empty array', () => {
    const timeline = timelineFromDurations([600]);
    expect(deriveCinematicMoments(cinematicPlan([]), timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY)).toEqual([]);
    expect(deriveCinematicMoments(cinematicPlan([directive('last-move', 1, 1)]), timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY)).toEqual([]);
  });

  it('safely omits a moment whose window is empty (a zero-duration/pruned ply)', () => {
    const timeline = timelineFromDurations([600, 0, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
    expect(deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY)).toEqual([]);
  });

  it('safely omits a moment referencing a ply with no corresponding MoveBeat', () => {
    const timeline = timelineFromDurations([600, 600]);
    const plan = cinematicPlan([directive('threat-refutation-arrow', 99, 99)]);
    expect(deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY)).toEqual([]);
  });

  it('labels a non-stalemate draw generically, and a decisive result as Checkmate', () => {
    const timeline = timelineFromDurations([600]);
    const plan = cinematicPlan([directive('terminal-result-highlight', 1, 1, { kind: 'terminal' })]);
    const draw = deriveCinematicMoments(plan, timeline, analysisEndingWith(1, { kind: 'terminal', result: 'draw' }), EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(draw[0]!.label).toBe('Draw');
    expect(draw[0]!.reason).toBe('The game ended in a draw.');
    const mate = deriveCinematicMoments(plan, timeline, analysisEndingWith(1, { kind: 'terminal', result: 'black-wins' }), EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(mate[0]!.label).toBe('Checkmate');
    expect(mate[0]!.reason).toBe('The game ended in checkmate.');
  });

  describe('Phase 2.7 — reason mappings', () => {
    const THREAT_CASES: ReadonlyArray<[ThreatRecord['kind'], string]> = [
      ['mate-threat', 'A threatened mate was refuted here.'],
      ['check-threat', 'A threatened check was refuted here.'],
      ['material-winning-threat', 'A threat to win material was refuted here.'],
      ['positional-restriction-threat', "A trapped piece's threat was refuted here."]
    ];

    it.each(THREAT_CASES)('threat-refutation-arrow resolves %s to its exact reason', (kind, expectedReason) => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
      const understanding = understandingFixture({ threats: [threatRecord(kind, 1, 2)] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, EMPTY_STORY);
      expect(moment!.reason).toBe(expectedReason);
    });

    it('threat-refutation-arrow falls back to the generic reason when the ThreatRecord cannot be resolved', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
      // No matching threat: understanding.threats is empty.
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe('A key moment identified by the game analysis.');
    });

    const MECHANISM_CASES: ReadonlyArray<[CauseConsequenceRecord['mechanism'], string]> = [
      ['fork', 'The decisive moment — a fork led to a decisive advantage.'],
      ['pin', 'The decisive moment — a pin led to a decisive advantage.'],
      ['skewer', 'The decisive moment — a skewer led to a decisive advantage.'],
      ['discovery', 'The decisive moment — a discovered attack led to a decisive advantage.'],
      ['battery', 'The decisive moment — a battery led to a decisive advantage.'],
      ['deflection', 'The decisive moment — a deflection led to a decisive advantage.'],
      ['overload', 'The decisive moment — an overload led to a decisive advantage.'],
      ['king-safety', 'The decisive moment — a king-safety issue led to a decisive advantage.'],
      ['positional', 'The decisive moment — a positional shift led to a decisive advantage.']
    ];

    it.each(MECHANISM_CASES)('central-conflict-highlight maps mechanism %s to its exact phrase', (mechanism, expectedReason) => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 2, mechanism, 'decisive-advantage')] });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe(expectedReason);
    });

    const RESOLUTION_CASES: ReadonlyArray<[CauseConsequenceRecord['resolution'], string]> = [
      ['decisive-advantage', 'The decisive moment of the game, leading to a decisive advantage.'],
      ['material-gain', 'The decisive moment of the game, leading to a material gain.'],
      ['forced-mate', 'The decisive moment of the game, leading to a forced mate.'],
      // Phase 3: this fixture never sets threatsRemoved (defaults to []),
      // so 'repelled' is the unsupported case and uses the conservative
      // phrase — see the dedicated 'Phase 3' describe block below for the
      // threatsRemoved.length > 0 case, which keeps the defensive wording.
      ['repelled', 'The decisive moment of the game, leading to a decisive swing against the player who moved.'],
      ['unresolved', 'The decisive moment of the game, leading to an unresolved position.'],
      ['drawn', 'The decisive moment of the game, leading to a draw.']
    ];

    it.each(RESOLUTION_CASES)('central-conflict-highlight maps resolution %s to its exact phrase when mechanism is null', (resolution, expectedReason) => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 2, null, resolution)] });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe(expectedReason);
    });

    it('central-conflict-highlight falls back to its own generic reason when the owning beat is missing', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'missing-beat' })]);
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe('The decisive moment of the game.');
    });

    it('central-conflict-highlight falls back to its own generic reason when the TurningPoint cannot be resolved', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      // Beat references a turningPointId that doesn't exist in understanding.turningPoints.
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'missing-tp')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, story);
      expect(moment!.reason).toBe('The decisive moment of the game.');
    });

    const ARCHETYPE_CASES: ReadonlyArray<[import('../story/types').StoryArchetype, string]> = [
      ['king-hunt', 'A forced sequence of checks drove the king across the board, ending in mate.'],
      ['pawn-journey', 'A pawn advanced across the board before promoting.'],
      ['stalemate-swindle', 'The side that was behind on material escaped with a stalemate.'],
      ['forced-trap', 'A sacrifice forced a decisive sequence.']
    ];

    it.each(ARCHETYPE_CASES)('archetype-track maps %s to its exact reason', (archetype, expectedReason) => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('archetype-track', 2, 2, { kind: 'archetypeSignal', archetype })]);
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe(expectedReason);
    });

    it('terminal-result-highlight: checkmate reason', () => {
      const timeline = timelineFromDurations([600]);
      const plan = cinematicPlan([directive('terminal-result-highlight', 1, 1, { kind: 'terminal' })]);
      const analysis = analysisEndingWith(1, { kind: 'terminal', result: 'white-wins' });
      const [moment] = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe('The game ended in checkmate.');
    });

    it('terminal-result-highlight: stalemate reason', () => {
      const timeline = timelineFromDurations([600]);
      const plan = cinematicPlan([directive('terminal-result-highlight', 1, 1, { kind: 'terminal' })]);
      const analysis = analysisEndingWith(1, { kind: 'terminal', result: 'draw', drawReason: 'stalemate' });
      const [moment] = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe('The game ended in a stalemate — a draw by no legal moves.');
    });

    it('terminal-result-highlight: generic draw reason', () => {
      const timeline = timelineFromDurations([600]);
      const plan = cinematicPlan([directive('terminal-result-highlight', 1, 1, { kind: 'terminal' })]);
      const analysis = analysisEndingWith(1, { kind: 'terminal', result: 'draw' });
      const [moment] = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe('The game ended in a draw.');
    });

    it('universal fallback: an unresolvable archetype evidenceRef falls back to the generic reason, never throws', () => {
      const timeline = timelineFromDurations([600, 600]);
      // A malformed-in-practice directive: archetype-track kind but a 'move' evidenceRef, not 'archetypeSignal'.
      const plan = cinematicPlan([directive('archetype-track', 2, 2, { kind: 'move', ply: 2 })]);
      expect(() => deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY)).not.toThrow();
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment!.reason).toBe('A key moment identified by the game analysis.');
    });

    it('reason derivation is deterministic across repeated calls', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 2, 'fork', 'forced-mate')] });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const first = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      const second = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(first[0]!.reason).toBe(second[0]!.reason);
      expect(first[0]!.reason).toBe('The decisive moment — a fork led to a forced mate.');
    });

    it('adding reason does not perturb any existing timing/navigation field', () => {
      const timeline = timelineFromDurations([600, 600, 600]);
      const plan = cinematicPlan([directive('threat-refutation-arrow', 2, 2)]);
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moment).toMatchObject({
        id: 'threat-refutation-arrow-2-2',
        kind: 'threat-refutation-arrow',
        fromPly: 2,
        toPly: 2,
        atMs: 600,
        untilMs: 1200,
        targetTimeMs: 1199
      });
      expect(moment!.narratives[0]).toEqual({ label: moment!.label, reason: moment!.reason });
    });
  });

  describe('Phase 2.8 — narrative preservation', () => {
    it('Evergreen: forced-trap + king-hunt + central-conflict-highlight overlap preserves all three narratives, in priority order', () => {
      // Reproduces the exact real Evergreen overlap shape confirmed via a
      // live pipeline probe during the Phase 2.8 audit/investigation:
      // archetype-track(forced-trap)[39,40], archetype-track(king-hunt)[39,46],
      // central-conflict-highlight[40,40] (evidenceRef: beat beat-climax-40).
      const timeline = timelineFromDurations(Array(46).fill(600));
      const plan = cinematicPlan([
        directive('archetype-track', 39, 40, { kind: 'archetypeSignal', archetype: 'forced-trap' }),
        directive('archetype-track', 39, 46, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
        directive('central-conflict-highlight', 40, 40, { kind: 'beat', id: 'beat-climax-40' })
      ]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 40, 'fork', 'forced-mate')] });
      const story = storyFixture({ beats: [climaxBeat('beat-climax-40', 40, 'tp-1')] });
      const analysis = analysisEndingWith(46, { kind: 'cp', cp: 0 });

      const moments = deriveCinematicMoments(plan, timeline, analysis, understanding, story);
      expect(moments).toHaveLength(1);
      const moment = moments[0]!;
      expect(moment.fromPly).toBe(39);
      expect(moment.toPly).toBe(46);

      // Primary fields: unchanged from the pre-Phase-2.8 single-winner selection
      // (archetype-track outranks central-conflict-highlight; forced-trap
      // precedes king-hunt via ARCHETYPE_COLOR_ORDER).
      expect(moment.kind).toBe('archetype-track');
      expect(moment.label).toBe('Forced Trap');
      expect(moment.reason).toBe('A sacrifice forced a decisive sequence.');

      // Phase 2.8: no genuine narrative is discarded, in the exact expected order.
      expect(moment.narratives).toEqual([
        { label: 'Forced Trap', reason: 'A sacrifice forced a decisive sequence.' },
        { label: 'King Hunt', reason: 'A forced sequence of checks drove the king across the board, ending in mate.' },
        { label: 'Climax', reason: 'The decisive moment — a fork led to a forced mate.' }
      ]);
      expect(moment.narratives[0]).toEqual({ label: moment.label, reason: moment.reason });
    });

    it('archetype (stalemate-swindle) + terminal-result-highlight sharing the exact same single ply preserves both narratives, terminal primary', () => {
      // stalemateSwindleSignals (src/story/archetypes.ts) sets plies to
      // exactly [finalPly.ply] — identical to terminal-result-highlight's
      // own [finalPly, finalPly] range, so this is a real, not synthetic,
      // identical-range overlap.
      const timeline = timelineFromDurations([600, 600, 600]);
      const plan = cinematicPlan([
        directive('archetype-track', 3, 3, { kind: 'archetypeSignal', archetype: 'stalemate-swindle' }),
        directive('terminal-result-highlight', 3, 3, { kind: 'terminal' })
      ]);
      const analysis = analysisEndingWith(3, { kind: 'terminal', result: 'draw', drawReason: 'stalemate' });
      const moments = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moments).toHaveLength(1);
      const moment = moments[0]!;
      expect(moment.kind).toBe('terminal-result-highlight');
      expect(moment.label).toBe('Stalemate');
      expect(moment.reason).toBe('The game ended in a stalemate — a draw by no legal moves.');
      expect(moment.narratives).toEqual([
        { label: 'Stalemate', reason: 'The game ended in a stalemate — a draw by no legal moves.' },
        { label: 'Stalemate Swindle', reason: 'The side that was behind on material escaped with a stalemate.' }
      ]);
    });

    it('exact duplicate (label, reason) pairs collapse to a single narrative even though two directives produced them', () => {
      // Two overlapping archetype-track directives for the SAME archetype
      // produce identical label+reason (archetypeReason depends only on
      // the archetype, not on which plies fired it) — a true duplicate,
      // not two distinct narratives.
      const timeline = timelineFromDurations([600, 600, 600, 600]);
      const plan = cinematicPlan([
        directive('archetype-track', 1, 2, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
        directive('archetype-track', 2, 3, { kind: 'archetypeSignal', archetype: 'king-hunt' })
      ]);
      const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(3, { kind: 'cp', cp: 0 }), EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moments).toHaveLength(1);
      expect(moments[0]!.fromPly).toBe(1);
      expect(moments[0]!.toPly).toBe(3);
      expect(moments[0]!.narratives).toEqual([
        { label: 'King Hunt', reason: 'A forced sequence of checks drove the king across the board, ending in mate.' }
      ]);
    });

    it('threat-refutation-arrow + central-conflict-highlight overlap preserves both narratives when their label/reason pairs genuinely differ', () => {
      const timeline = timelineFromDurations([600, 600, 600, 600, 600, 600]);
      const plan = cinematicPlan([
        directive('threat-refutation-arrow', 5, 5),
        directive('central-conflict-highlight', 5, 6, { kind: 'beat', id: 'beat-1' })
      ]);
      const understanding = understandingFixture({
        threats: [threatRecord('mate-threat', 4, 5)],
        turningPoints: [turningPoint('tp-1', 5, 'skewer', 'material-gain')]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 5, 'tp-1')] });
      const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(6, { kind: 'cp', cp: 0 }), understanding, story);
      expect(moments).toHaveLength(1);
      const moment = moments[0]!;
      // central-conflict-highlight (2) outranks threat-refutation-arrow (1) in KIND_PRIORITY.
      expect(moment.kind).toBe('central-conflict-highlight');
      expect(moment.label).toBe('Climax');
      expect(moment.narratives).toEqual([
        { label: 'Climax', reason: 'The decisive moment — a skewer led to a material gain.' },
        { label: 'Threat Refutation', reason: 'A threatened mate was refuted here.' }
      ]);
    });

    it('narratives[0] always equals {label, reason} across every fixture already exercised above', () => {
      const timeline = timelineFromDurations([600, 600, 600, 600]);
      const plan = cinematicPlan([
        directive('threat-refutation-arrow', 1, 1),
        directive('central-conflict-highlight', 2, 2),
        directive('archetype-track', 3, 3, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
        directive('terminal-result-highlight', 4, 4, { kind: 'terminal' })
      ]);
      const moments = deriveCinematicMoments(plan, timeline, analysisEndingWith(4, { kind: 'terminal', result: 'white-wins' }), EMPTY_UNDERSTANDING, EMPTY_STORY);
      expect(moments.length).toBeGreaterThan(0);
      for (const m of moments) {
        expect(m.narratives.length).toBeGreaterThanOrEqual(1);
        expect(m.narratives[0]).toEqual({ label: m.label, reason: m.reason });
      }
    });

    it('narrative derivation is deterministic across repeated calls, including array order and content', () => {
      const timeline = timelineFromDurations(Array(46).fill(600));
      const plan = cinematicPlan([
        directive('archetype-track', 39, 40, { kind: 'archetypeSignal', archetype: 'forced-trap' }),
        directive('archetype-track', 39, 46, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
        directive('central-conflict-highlight', 40, 40, { kind: 'beat', id: 'beat-climax-40' })
      ]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 40, 'fork', 'forced-mate')] });
      const story = storyFixture({ beats: [climaxBeat('beat-climax-40', 40, 'tp-1')] });
      const analysis = analysisEndingWith(46, { kind: 'cp', cp: 0 });

      const first = deriveCinematicMoments(plan, timeline, analysis, understanding, story);
      const second = deriveCinematicMoments(plan, timeline, analysis, understanding, story);
      expect(first).toEqual(second);
      expect(first[0]!.narratives).toEqual(second[0]!.narratives);
    });

    it('preserves every existing timing/navigation invariant unchanged: targetTimeMs, atMs, untilMs, fromPly, toPly, id', () => {
      const timeline = timelineFromDurations(Array(46).fill(600));
      const plan = cinematicPlan([
        directive('archetype-track', 39, 40, { kind: 'archetypeSignal', archetype: 'forced-trap' }),
        directive('archetype-track', 39, 46, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
        directive('central-conflict-highlight', 40, 40, { kind: 'beat', id: 'beat-climax-40' })
      ]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 40, 'fork', 'forced-mate')] });
      const story = storyFixture({ beats: [climaxBeat('beat-climax-40', 40, 'tp-1')] });
      const analysis = analysisEndingWith(46, { kind: 'cp', cp: 0 });
      const [moment] = deriveCinematicMoments(plan, timeline, analysis, understanding, story);
      expect(moment!.id).toBe('archetype-track-39-46');
      expect(moment!.fromPly).toBe(39);
      expect(moment!.toPly).toBe(46);
      expect(moment!.atMs).toBe(38 * 600);
      expect(moment!.untilMs).toBe(46 * 600);
      expect(moment!.targetTimeMs).toBe(46 * 600 - 1);
    });
  });

  describe('Phase 3 — conservative wording when "repelled" is unsupported by threatsRemoved', () => {
    it('Scholar\'s-Mate-shaped: repelled with zero threats removed uses conservative, mechanism-free wording (the pin is also ungrounded — see Phase 4 below)', () => {
      // Reproduces the exact real Scholar's Mate shape confirmed via a live
      // pipeline probe: mechanism 'pin', resolution 'repelled', threatsRemoved
      // empty. The default motif/movePlayed placeholders here are also
      // structurally ungrounded (Phase 4), so this omission is doubly
      // supported; the dedicated Phase 4 block below isolates the grounding
      // check on its own with a real (non-'repelled') resolution.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [turningPoint('tp-1', 2, 'pin', 'repelled', { motifsTriggered: ['motif-1'] })],
        motifs: [motifInstance('motif-1', 2, 'pin', false)]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game, leading to a decisive swing against the player who moved.');
      expect(moment!.reason).not.toContain('repelled');
      expect(moment!.reason).not.toContain('pin');
    });

    it('repelled with an actually removed threat and a structurally grounded mechanism keeps the existing defensive wording', () => {
      // The motif's squares are explicitly aligned with the default
      // movePlayed ('e2e4') so this exercises resolution-conservatism
      // (threatsRemoved non-empty => not unsupported) independently of
      // Phase 4's grounding check, which would otherwise also suppress an
      // unaligned motif regardless of this test's threatsRemoved setup.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [turningPoint('tp-1', 2, 'skewer', 'repelled', { threatsRemoved: ['threat-1'], motifsTriggered: ['motif-1'] })],
        motifs: [motifInstance('motif-1', 2, 'skewer', true, { attacker: 'e2', targets: ['e4'] })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a skewer led to the threat being repelled.');
    });

    it('reason derivation remains deterministic across repeated calls for the conservative-wording path', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [turningPoint('tp-1', 2, 'pin', 'repelled', { motifsTriggered: ['motif-1'] })],
        motifs: [motifInstance('motif-1', 2, 'pin', false)]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const first = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      const second = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(first[0]!.reason).toBe(second[0]!.reason);
      expect(first[0]!.reason).toBe('The decisive moment of the game, leading to a decisive swing against the player who moved.');
    });
  });

  describe('Phase 4 — mechanism grounding via involvesMovedPiece', () => {
    it('1. a selected motif structurally unrelated to the moved piece/square suppresses the mechanism clause', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [turningPoint('tp-1', 2, 'discovery', 'material-gain', { motifsTriggered: ['motif-1'] })],
        motifs: [motifInstance('motif-1', 2, 'discovery', true, { attacker: 'a1', targets: ['a8'] })] // default movePlayed is e2e4 — unrelated
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).not.toContain('discovered attack');
      expect(moment!.reason).toBe('The decisive moment of the game, leading to a material gain.');
    });

    it('2. motif.squares.attacker === movePlayed.from preserves the mechanism clause', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'pin', 'material-gain', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'm', uci: 'c6e7' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'pin', false, { attacker: 'c6', targets: ['h1'] })] // attacker === move.from ('c6')
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a pin led to a material gain.');
    });

    it('3. motif.squares.attacker === movePlayed.to preserves the mechanism clause', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'material-gain', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'm', uci: 'h3g2' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'g2', targets: ['f1', 'h1'] })] // attacker === move.to ('g2')
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a fork led to a material gain.');
    });

    it('4. movePlayed.to included in motif.squares.targets preserves the mechanism clause', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'skewer', 'material-gain', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'm', uci: 'a1e7' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'skewer', false, { attacker: 'h4', targets: ['e7', 'a1'] })] // move.to ('e7') is among targets
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a skewer led to a material gain.');
    });

    it('5. significanceEvidence === false does not suppress a structurally grounded mechanism, including when resolution is also unsupported', () => {
      // Exactly the case Phase 3's mechanismHasSignificance would have
      // wrongly suppressed: resolution 'repelled' with zero threatsRemoved
      // (unsupported), a motif with no significanceEvidence, but this time
      // the motif IS grounded (attacker === move.to) — a genuine mechanism
      // must survive regardless of significance.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'battery', 'repelled', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'm', uci: 'h3g2' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'battery', false, { attacker: 'g2', targets: ['f1'] })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a battery led to a decisive swing against the player who moved.');
      expect(moment!.reason).not.toContain('repelled');
    });

    it('6. Scholar\'s Mate real climax: repelled + ungrounded pin (attacker c5, targets g1) against Nf6 (g8f6) stays conservative and mechanism-free', () => {
      // Exact real shape confirmed via a live pipeline probe: mechanism
      // 'pin', attacker c5, targets [g1], movePlayed Nf6 (g8f6). Neither
      // move square matches the attacker, and g1 is not f6, so
      // involvesMovedPiece is false independent of resolutionIsUnsupported
      // (which is already true here too, from Phase 3).
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'pin', 'repelled', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Nf6', uci: 'g8f6' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'pin', false, { attacker: 'c5', targets: ['g1'], throughSquare: 'f2' })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game, leading to a decisive swing against the player who moved.');
    });

    it('7. Evergreen real climax: material-gain + ungrounded fork (attacker f3, a leftover from Qxf3) against Nxe7 (c6e7) is now conservative — Phase 3\'s "must remain unchanged" premise is superseded by this finding', () => {
      // The fork (attacker f3, targets [d3, d1]) first appeared two plies
      // earlier at Qxf3 and simply persisted; Nxe7's material gain is fully
      // explained by the forced Rxe7+ Nxe7 recapture, unrelated to the fork,
      // which is never converted for the rest of the game (see the Phase 4
      // investigation report). Neither 'c6' (from) nor 'e7' (to) matches
      // attacker 'f3' or is among targets ['d3','d1'].
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'material-gain', {
            threatsRemoved: ['threat-1'],
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Nxe7', uci: 'c6e7' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'f3', targets: ['d3', 'd1'] })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game, leading to a material gain.');
      expect(moment!.reason).not.toContain('fork');
    });

    it('8. Stalemate real climax: repelled + one threat removed + ungrounded skewer (attacker d8) against Kf7 (e8f7) is now conservative — the resolution stays supported, only the mechanism clause is suppressed', () => {
      // Exact real shape confirmed live: mechanism 'skewer', attacker d8,
      // targets [d2], movePlayed Kf7 (e8f7), threatsRemoved non-empty (so
      // resolutionIsUnsupported is false — the resolution phrase itself
      // remains 'the threat being repelled'). Neither 'e8' nor 'f7' matches
      // attacker 'd8' or is among targets ['d2'].
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'skewer', 'repelled', {
            threatsRemoved: ['threat-1'],
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Kf7', uci: 'e8f7' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'skewer', false, { attacker: 'd8', targets: ['d2'], throughSquare: 'd7' })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game, leading to the threat being repelled.');
      expect(moment!.reason).not.toContain('skewer');
    });

    it('9. Promotion race real climax: repelled + one threat removed + grounded fork (attacker g2 === move.to) keeps its existing mechanism wording unchanged', () => {
      // Exact real shape confirmed live: mechanism 'fork', attacker g2,
      // targets [f1, h1], movePlayed hxg2 (h3g2) — attacker === move.to, so
      // involvesMovedPiece is true, and the motif also lacks
      // significanceEvidence, demonstrating grounding (not significance)
      // is what preserves this mechanism.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'repelled', {
            threatsRemoved: ['threat-1'],
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'hxg2', uci: 'h3g2' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'g2', targets: ['f1', 'h1'] })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a fork led to the threat being repelled.');
    });

    it('10. reason derivation is deterministic across repeated calls for both the suppressed and preserved grounding paths', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);

      const ungrounded = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'material-gain', { motifsTriggered: ['motif-1'], movePlayed: { san: 'Nxe7', uci: 'c6e7' } })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'f3', targets: ['d3', 'd1'] })]
      });
      const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const firstUngrounded = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, ungrounded, story);
      const secondUngrounded = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, ungrounded, story);
      expect(firstUngrounded[0]!.reason).toBe(secondUngrounded[0]!.reason);
      expect(firstUngrounded[0]!.reason).toBe('The decisive moment of the game, leading to a material gain.');

      const grounded = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'repelled', {
            threatsRemoved: ['threat-1'],
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'hxg2', uci: 'h3g2' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'g2', targets: ['f1', 'h1'] })]
      });
      const firstGrounded = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, grounded, story);
      const secondGrounded = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, grounded, story);
      expect(firstGrounded[0]!.reason).toBe(secondGrounded[0]!.reason);
      expect(firstGrounded[0]!.reason).toBe('The decisive moment — a fork led to the threat being repelled.');
    });
  });
});

/** A store with a real (if trivial) loaded game, so seekTo's own scene-duration clamp is exercised. */
function storeWithTimeline(timeline: Timeline): Store<AppState> {
  const store = new Store<AppState>(createInitialState());
  const parsed = parsePgn('1. e4 e5 2. Nf3 Nc6', new ChessJsEngine());
  if (!parsed.ok) throw new Error('fixture PGN failed to parse');
  store.setState((s) => ({
    ...s,
    game: { gameRecord: parsed.value, timeline },
    playback: { ...s.playback, activeSceneId: timeline.scenes[0]!.id, logicalTimeMs: 0 }
  }));
  return store;
}

describe('goToNextMoment / goToPreviousMoment', () => {
  const timeline = timelineFromDurations([600, 600, 600, 600, 600]);
  const plan = cinematicPlan([
    directive('threat-refutation-arrow', 1, 1),
    directive('central-conflict-highlight', 3, 3),
    directive('terminal-result-highlight', 5, 5, { kind: 'terminal' })
  ]);
  const analysis = analysisEndingWith(5, { kind: 'terminal', result: 'white-wins' });

  function moments() {
    return deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);
  }

  it('J: Next Moment from before the first moment lands on the first moment', () => {
    const store = storeWithTimeline(timeline);
    goToNextMoment(store, moments());
    expect(store.getState().playback.logicalTimeMs).toBe(moments()[0]!.targetTimeMs);
  });

  it('J: Previous Moment from the very end lands on the last moment', () => {
    const store = storeWithTimeline(timeline);
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: timeline.scenes[0]!.durationMs } }));
    goToPreviousMoment(store, moments());
    expect(store.getState().playback.logicalTimeMs).toBe(moments()[2]!.targetTimeMs);
  });

  it('K: Next Moment then Previous Moment returns to the original moment', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: all[0]!.targetTimeMs } }));
    goToNextMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[1]!.targetTimeMs);
    goToPreviousMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[0]!.targetTimeMs);
  });

  it('L: repeated Next Moment at the final moment does not escape it', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: all[2]!.targetTimeMs } }));
    goToNextMoment(store, all);
    goToNextMoment(store, all);
    goToNextMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[2]!.targetTimeMs);
  });

  it('M: repeated Previous Moment at the first moment does not escape it', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    store.setState((s) => ({ ...s, playback: { ...s.playback, logicalTimeMs: all[0]!.targetTimeMs } }));
    goToPreviousMoment(store, all);
    goToPreviousMoment(store, all);
    goToPreviousMoment(store, all);
    expect(store.getState().playback.logicalTimeMs).toBe(all[0]!.targetTimeMs);
  });

  it('pauses playback when navigating between moments', () => {
    const store = storeWithTimeline(timeline);
    store.setState((s) => ({ ...s, playback: { ...s.playback, playing: true } }));
    goToNextMoment(store, moments());
    expect(store.getState().playback.playing).toBe(false);
  });

  it('the terminal moment target never equals scene.durationMs, so ordinary Next Move overshoot behavior is unaffected by this module', () => {
    const store = storeWithTimeline(timeline);
    const all = moments();
    const terminal = all[all.length - 1]!;
    expect(terminal.targetTimeMs).not.toBe(timeline.scenes[0]!.durationMs);
    expect(terminal.targetTimeMs).toBeLessThan(timeline.scenes[0]!.durationMs);
  });
});
