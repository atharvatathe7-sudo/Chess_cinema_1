import { centralConflict as centralConflictFixture, consequenceChain, noStoryConfidence, unknownOutcome } from '../story/storyFixtures';
import { motifInstanceKeyFor } from '../understanding/motifs';
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
import { DEFAULT_STORY_SETTINGS, STORY_SCHEMA_VERSION, type CentralConflict, type StoryBeat, type StoryConfidence, type StoryPlan } from '../story/types';
import type { MoveBeat, Timeline } from '../timeline/types';
import { createInitialState, type AppState } from './AppState';
import { Store } from './store';
import type { CinematicMoment } from './moments';
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
function storyFixture(overrides: { beats?: readonly StoryBeat[]; confidence?: StoryConfidence; centralConflict?: CentralConflict } = {}): StoryPlan {
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    centralConflict: overrides.centralConflict ?? null,
    noConflictReason: overrides.centralConflict ? undefined : 'no-turning-points',
    beats: overrides.beats ?? [],
    moveTreatment: [],
    archetypeSignals: [],
    leadArchetype: null,
    supportingArchetypes: [],
    pieceContributions: [],
    explanationOpportunities: [],
    confidence: overrides.confidence ?? noStoryConfidence(),
    outcome: unknownOutcome(),
    settings: DEFAULT_STORY_SETTINGS
  };
}

/**
 * Phase 16 (D-3) — a StoryPlan whose claim ladder permits causal wording.
 *
 * storyFixture's default confidence is noStoryConfidence(), i.e.
 * causalClaimAllowed === false, which is now the CONSERVATIVE path. Tests
 * whose subject is the phrase tables themselves (which words map to which
 * mechanism/resolution) use this so they keep exercising the causal form they
 * were written for; tests whose subject is the claim ladder use storyFixture
 * directly. Nothing here loosens the ladder — it states which side of it a
 * given test is about.
 */
function causalStoryFixture(overrides: { beats?: readonly StoryBeat[] } = {}): StoryPlan {
  return storyFixture({
    ...overrides,
    confidence: noStoryConfidence({
      level: 'high',
      causalClaimAllowed: true,
      mechanismVerified: true,
      resolutionCorroborated: true,
      hasConsequents: true,
      reachesResult: true
    })
  });
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
    motifInstanceKey: motifInstanceKeyFor(motif, squares.attacker, squares.targets, squares.throughSquare),
    firstSeenPly: ply,
    geometryEvidence: emptyEvidence([ply]),
    ...(significant ? { significanceEvidence: emptyEvidence([ply]) } : {})
  };
}

/** Phase 3/4 — threatsRemoved/motifsTriggered/movePlayed are overridable; threatsRemoved and motifsTriggered default to [] and movePlayed defaults to 'e2e4' to match every pre-Phase-4 call site exactly. */
function causeConsequence(
  mechanism: CauseConsequenceRecord['mechanism'],
  resolution: CauseConsequenceRecord['resolution'],
  ply: number,
  overrides: { threatsRemoved?: readonly string[]; motifsTriggered?: readonly string[]; movePlayed?: { san: string; uci: string }; mechanismVerified?: boolean } = {}
): CauseConsequenceRecord {
  return {
    id: `cc-${ply}`,
    ply,
    positionBefore: 'startpos',
    movePlayed: overrides.movePlayed ?? { san: 'm', uci: 'e2e4' },
    immediateChange: { evaluationDelta: { swingCp: 0, swingForMoverCp: 0 }, materialDelta: 0, motifsTriggered: overrides.motifsTriggered ?? [] },
    // Phase 15 — a named mechanism in a fixture is a verified one by
    // construction; mechanism === null means there is no claim to verify.
    // Phase 16 (D-1) — overridable, so a fixture can express the one shape
    // that must never reach a caption: a mechanism NAMED but not verified.
    mechanismVerified: overrides.mechanismVerified ?? mechanism !== null,
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
  overrides: { threatsRemoved?: readonly string[]; motifsTriggered?: readonly string[]; movePlayed?: { san: string; uci: string }; mechanismVerified?: boolean } = {}
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

  /**
   * Phase 15 supersedes the previous version of this case, which asserted
   * that an overlapping terminal-result-highlight and central-conflict-
   * highlight merge into ONE moment with the terminal label winning.
   *
   * That merge only ever happened by accident: before Phase 15 a
   * central-conflict highlight covered the climax ply alone, so it rarely
   * overlapped the ending. Now that the story owns its payoff, the highlight
   * spans climax -> resolution and the two ALWAYS overlap — so merging would
   * silently relabel every decisive game's climax caption as "Checkmate" and
   * demote the Climax to a secondary narrative.
   *
   * The climax and the payoff are two beats of one story, so they are two
   * moments. KIND_PRIORITY still orders every other merge group.
   */
  it('H: a terminal payoff keeps its own moment rather than absorbing the climax highlight (Phase 15)', () => {
    const timeline = timelineFromDurations([600, 600]);
    const plan = cinematicPlan([directive('central-conflict-highlight', 1, 2), directive('terminal-result-highlight', 2, 2, { kind: 'terminal' })]);
    const analysis = analysisEndingWith(2, { kind: 'terminal', result: 'white-wins' });
    const moments = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);

    expect(moments).toHaveLength(2);
    expect(moments.map((m) => m.kind)).toEqual(['central-conflict-highlight', 'terminal-result-highlight']);

    const climax = moments[0]!;
    expect(climax.label).toBe('Climax');
    expect(climax.reason).toBe('The decisive moment of the game.');
    expect(climax.narratives).toEqual([{ label: 'Climax', reason: 'The decisive moment of the game.' }]);

    const payoff = moments[1]!;
    expect(payoff.label).toBe('Checkmate');
    expect(payoff.reason).toBe('The game ended in checkmate.');
    expect(payoff.narratives).toEqual([{ label: 'Checkmate', reason: 'The game ended in checkmate.' }]);
  });

  it('H2: KIND_PRIORITY still decides the label for every other merge group', () => {
    // A short archetype-track and a threat-refutation-arrow over the same
    // plies still merge, with the higher-priority kind taking the label.
    const timeline = timelineFromDurations([600, 600]);
    const plan = cinematicPlan([
      directive('threat-refutation-arrow', 1, 1),
      directive('archetype-track', 1, 2, { kind: 'archetypeSignal', archetype: 'king-hunt' })
    ]);
    const moments = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, EMPTY_STORY);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.kind).toBe('archetype-track');
    expect(moments[0]!.narratives.length).toBeGreaterThan(1);
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe(expectedReason);
    });

    /**
     * Phase 16 — with no verified mechanism there is no causal rung at all:
     * causalClaimAllowed requires mechanismVerified, so "causal but
     * mechanism-free" is not a state the confidence model can produce. These
     * cases therefore assert the FACTUAL form, which is what a mechanism-free
     * climax actually renders as, and they continue to pin the exact phrase
     * for every resolution value.
     */
    const RESOLUTION_CASES: ReadonlyArray<[CauseConsequenceRecord['resolution'], string]> = [
      ['decisive-advantage', 'The decisive moment of the game — the evaluation moved decisively.'],
      ['material-gain', 'The decisive moment of the game — material was won.'],
      ['forced-mate', 'The decisive moment of the game — a forced mate followed.'],
      // Phase 3: this fixture never sets threatsRemoved (defaults to []),
      // so 'repelled' is the unsupported case and uses the conservative
      // phrase — see the dedicated 'Phase 3' describe block below for the
      // threatsRemoved.length > 0 case, which keeps the defensive wording.
      // Phase 16 (D-2) — was 'a decisive swing against the player who moved',
      // the substitution Phase 3's caption-time patch made whenever
      // threatsRemoved was empty. That patch is gone: the pipeline can no
      // longer produce an uncorroborated 'repelled' (the corroboration is now
      // a precondition on the value itself), so this table states the real
      // phrase for the real resolution.
      ['repelled', 'The decisive moment of the game — a threat was removed.'],
      ['unresolved', 'The decisive moment of the game — the position stayed unresolved.'],
      ['drawn', 'The decisive moment of the game — the game was drawn.']
    ];

    it.each(RESOLUTION_CASES)('central-conflict-highlight maps resolution %s to its exact phrase when mechanism is null', (resolution, expectedReason) => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({ turningPoints: [turningPoint('tp-1', 2, null, resolution)] });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'missing-tp')] });
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-climax-40', 40, 'tp-1')] });
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 5, 'tp-1')] });
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-climax-40', 40, 'tp-1')] });
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
      const story = causalStoryFixture({ beats: [climaxBeat('beat-climax-40', 40, 'tp-1')] });
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

  describe('Phase 16 (D-2) — the "repelled" guard lives upstream, not here', () => {
    /**
     * Phase 3 added a caption-time patch (resolutionIsUnsupported) that
     * rewrote 'repelled' whenever threatsRemoved was empty. Phase 15 promoted
     * that exact condition into a PRECONDITION on the value itself:
     * understanding/causeConsequence.ts's resolutionFor only ever returns
     * 'repelled' when corroboration.threatsRemovedCount > 0. The caption-time
     * patch was therefore unreachable, and Phase 16 removed it rather than
     * leaving a second, redundant heuristic behind.
     *
     * What remains testable here is the contract that replaced it: this layer
     * reports the resolution it is given, and never second-guesses it.
     */
    it('renders a corroborated "repelled" with its own phrase, with no local re-derivation', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [turningPoint('tp-1', 2, null, 'repelled', { threatsRemoved: ['threat-1'] })]
      });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game — a threat was removed.');
    });

    it('does not silently rewrite a resolution based on threatsRemoved anymore', () => {
      // The shape Phase 3 used to patch. It can no longer be produced by the
      // real pipeline, but if a record like this ever reached the caption
      // layer, the honest behaviour is to report what the record says — not to
      // substitute a different claim invented here.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [turningPoint('tp-1', 2, null, 'repelled', { threatsRemoved: [] })]
      });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game — a threat was removed.');
      expect(moment!.reason).not.toContain('decisive swing against the player who moved');
    });
  });

  describe('Phase 16 (D-1) — the verified mechanism is the single source of truth', () => {
    /**
     * Phase 4 grounded the mechanism clause by re-deriving anchoring HERE,
     * from immediateChange.motifsTriggered[0]. Phase 15 had already moved that
     * rule upstream (mechanismVerification.ts's V1), applied per candidate
     * motif rather than only to the first, and recorded the verdict as
     * `mechanismVerified`. Phase 16 deletes the local copy.
     *
     * These tests assert the two failure modes the duplication allowed, in
     * both directions.
     */
    it('a mechanism verified via a LATER motif is not suppressed because an earlier motif would have failed', () => {
      // The regression this fixes. motif-A is first in motifsTriggered and its
      // geometry is entirely unrelated to the move (h1/a8 vs e2e4) — the old
      // local check read motifsTriggered[0] and would have suppressed the
      // clause. motif-B is the one that actually passed verification upstream,
      // and it is anchored to the move. The verified mechanism must survive.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'decisive-advantage', {
            motifsTriggered: ['motif-A', 'motif-B'],
            movePlayed: { san: 'e4', uci: 'e2e4' },
            mechanismVerified: true
          })
        ],
        motifs: [
          motifInstance('motif-A', 2, 'battery', false, { attacker: 'h1', targets: ['a8'] }),
          motifInstance('motif-B', 2, 'fork', false, { attacker: 'e4', targets: ['d6', 'f6'] })
        ]
      });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a fork led to a decisive advantage.');
    });

    it('an UNVERIFIED mechanism never leaks into a caption, even when its motif geometry touches the moved squares', () => {
      // The mirror failure. The motif is perfectly anchored (attacker === the
      // move's own destination), so the old local check would have passed it
      // through — but mechanismVerification rejected it upstream (it failed
      // V2/V3/V4), so no mechanism may be named.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'decisive-advantage', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'e4', uci: 'e2e4' },
            mechanismVerified: false
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'e4', targets: ['d6', 'f6'] })]
      });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game — the evaluation moved decisively.');
      expect(moment!.reason).not.toContain('fork');
    });

    it('a null mechanism stays mechanism-free regardless of what motifs are present', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, null, 'material-gain', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'e4', uci: 'e2e4' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', true, { attacker: 'e4', targets: ['d6'] })]
      });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game — material was won.');
    });

    it('motif geometry no longer influences the caption at all: identical records with opposite geometry read the same', () => {
      // The clearest statement of the invariant. Both fixtures are verified;
      // only the motif's squares differ, and the old code would have produced
      // two different captions from them.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });

      const anchored = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'pin', 'decisive-advantage', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Be7', uci: 'a3e7' },
            mechanismVerified: true
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'pin', false, { attacker: 'a3', targets: ['e7'] })]
      });
      const unanchored = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'pin', 'decisive-advantage', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Be7', uci: 'a3e7' },
            mechanismVerified: true
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'pin', false, { attacker: 'h1', targets: ['b8'] })]
      });

      const [a] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, anchored, story);
      const [b] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, unanchored, story);
      expect(a!.reason).toBe('The decisive moment — a pin led to a decisive advantage.');
      expect(b!.reason).toBe(a!.reason);
    });

    it('reason derivation stays deterministic across repeated calls for both the verified and unverified paths', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      for (const verified of [true, false]) {
        const understanding = understandingFixture({
          turningPoints: [
            turningPoint('tp-1', 2, 'skewer', 'material-gain', {
              motifsTriggered: ['motif-1'],
              movePlayed: { san: 'Re7', uci: 'e1e7' },
              mechanismVerified: verified
            })
          ],
          motifs: [motifInstance('motif-1', 2, 'skewer', false, { attacker: 'e1', targets: ['e7'] })]
        });
        const first = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
        const second = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
        expect(first).toEqual(second);
      }
    });
  });

  describe('Phase 16 (D-3) — causalClaimAllowed gates causal wording', () => {
    /**
     * story/types.ts defines causalClaimAllowed as "the single gate on
     * narration of the form 'X led to Y'". It was computed correctly from
     * Phase 15 onward and consumed by nothing, so every caption asserted
     * causation regardless of whether the evidence supported it.
     *
     * Each pair below holds the FACTS constant and varies only the claim
     * ladder, so the difference in output is exactly the difference in claim.
     */
    function reasonFor(causalClaimAllowed: boolean, mechanismVerified: boolean): string {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'material-gain', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Nd5', uci: 'c3d5' },
            mechanismVerified
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'd5', targets: ['e7', 'c7'] })]
      });
      const story = causalClaimAllowed
        ? causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] })
        : storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      return moment!.reason;
    }

    const CAUSAL_CONNECTIVES = ['led to', 'leading to', 'caused', 'because of'];

    it('POSITIVE: allowed + verified mechanism uses the full causal form', () => {
      expect(reasonFor(true, true)).toBe('The decisive moment — a fork led to a material gain.');
    });

    it('UNREACHABLE STATE: "causal claim allowed, no verified mechanism" withholds the claim rather than inventing a weaker one', () => {
      // story/confidence.ts requires mechanismVerified for causalClaimAllowed,
      // so this combination cannot arise from the real model. Phase 16 deleted
      // the rung that used to serve it. If it ever did arise, the safe
      // direction is to withhold the causal claim, NOT to offer a weaker
      // causal pathway — which is exactly what this asserts.
      const reason = reasonFor(true, false);
      expect(reason).toBe('The decisive moment of the game — material was won.');
      for (const connective of CAUSAL_CONNECTIVES) expect(reason).not.toContain(connective);
    });

    it('NEGATIVE: disallowed + verified mechanism states both facts without asserting causation', () => {
      const reason = reasonFor(false, true);
      expect(reason).toBe('The decisive moment of the game — a fork is present, and material was won.');
      for (const connective of CAUSAL_CONNECTIVES) expect(reason).not.toContain(connective);
    });

    it('NEGATIVE: disallowed without a verified mechanism reports the resolution as a bare fact', () => {
      const reason = reasonFor(false, false);
      expect(reason).toBe('The decisive moment of the game — material was won.');
      for (const connective of CAUSAL_CONNECTIVES) expect(reason).not.toContain(connective);
      expect(reason).not.toContain('fork');
    });

    it('NEGATIVE: no resolution loses its facts when the claim is withheld — only the claim weakens', () => {
      // Every resolution must still SAY something under the factual form. A
      // withheld causal claim must never become a withheld fact.
      const RESOLUTIONS: ReadonlyArray<[CauseConsequenceRecord['resolution'], string]> = [
        ['decisive-advantage', 'the evaluation moved decisively'],
        ['material-gain', 'material was won'],
        ['forced-mate', 'a forced mate followed'],
        ['repelled', 'a threat was removed'],
        ['unresolved', 'the position stayed unresolved'],
        ['drawn', 'the game was drawn']
      ];
      for (const [resolution, fact] of RESOLUTIONS) {
        const timeline = timelineFromDurations([600, 600]);
        const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
        const understanding = understandingFixture({
          turningPoints: [turningPoint('tp-1', 2, null, resolution, { threatsRemoved: ['threat-1'] })]
        });
        const story = storyFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
        const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
        expect(moment!.reason).toBe(`The decisive moment of the game — ${fact}.`);
        for (const connective of CAUSAL_CONNECTIVES) expect(moment!.reason).not.toContain(connective);
      }
    });
  });

  describe('Phase 16 — a payoff-corroborated causal claim names the actual payoff', () => {
    /**
     * The mismatch this fixes: causalClaimAllowed can be unlocked by
     * payoffCorroborated (the chain reached checkmate/stalemate) rather than
     * by resolutionCorroborated (the trigger-local resolution). The
     * trigger-local `resolution` is measured at the trigger's OWN consequence
     * ply, so it can still read 'unresolved' even when that chain-level
     * payoff is exactly what justified the claim — "led to an unresolved
     * position" would then describe a different ending than the one that
     * licensed the sentence. The fix: when payoffCorroborated (and NOT
     * resolutionCorroborated) is what unlocked the claim, the sentence names
     * the chain's own payoff instead.
     */
    function payoffCorroboratedStory(payoffKind: 'checkmate' | 'stalemate'): StoryPlan {
      const conflict: CentralConflict = centralConflictFixture('tp-1', 2, {
        consequenceChain: consequenceChain(2, { payoff: { kind: payoffKind, atPly: 5 }, reachesResult: true, consequents: [{ ply: 5, linkType: 'terminal-arrival', evidenceId: 'terminal-5' }] })
      });
      return storyFixture({
        beats: [climaxBeat('beat-1', 2, 'tp-1')],
        centralConflict: conflict,
        confidence: noStoryConfidence({
          level: 'high',
          causalClaimAllowed: true,
          mechanismVerified: true,
          resolutionCorroborated: false,
          payoffCorroborated: true,
          hasConsequents: true,
          reachesResult: true
        })
      });
    }

    it('1a. names checkmate when the causal claim was corroborated by a chain that reached checkmate', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      // The trigger-local resolution is deliberately 'unresolved' — the exact
      // shape story/confidence.ts's payoff-corroboration path exists for.
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'king-safety', 'unresolved', { motifsTriggered: [], movePlayed: { san: 'a2+', uci: 'a2a3' } })
        ]
      });
      const story = payoffCorroboratedStory('checkmate');
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a king-safety issue led to checkmate.');
      expect(moment!.reason).not.toContain('unresolved');
    });

    it('1b. names stalemate when the causal claim was corroborated by a chain that reached stalemate', () => {
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'king-safety', 'unresolved', { motifsTriggered: [], movePlayed: { san: 'a2+', uci: 'a2a3' } })
        ]
      });
      const story = payoffCorroboratedStory('stalemate');
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a king-safety issue led to stalemate.');
      expect(moment!.reason).not.toContain('unresolved');
    });

    it('2. trigger-local resolution behaviour is UNCHANGED when payoff corroboration is absent', () => {
      // The exact pre-existing causalStoryFixture shape: resolutionCorroborated
      // true, payoffCorroborated false (its default). Must still render the
      // resolution phrase, not a payoff phrase.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'fork', 'material-gain', {
            motifsTriggered: ['motif-1'],
            movePlayed: { san: 'Nd5', uci: 'c3d5' }
          })
        ],
        motifs: [motifInstance('motif-1', 2, 'fork', false, { attacker: 'd5', targets: ['e7', 'c7'] })]
      });
      const story = causalStoryFixture({ beats: [climaxBeat('beat-1', 2, 'tp-1')] });
      expect(story.confidence.payoffCorroborated).toBe(false);
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment — a fork led to a material gain.');
    });

    it('2b. a factual (non-causal) caption is unaffected by payoff corroboration entirely', () => {
      // When the claim itself is disallowed, the payoff-naming logic must
      // never be reached at all — only the CLAIM ladder decides that, per the
      // existing D-3 safety model.
      const timeline = timelineFromDurations([600, 600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 2, 2, { kind: 'beat', id: 'beat-1' })]);
      const understanding = understandingFixture({
        turningPoints: [
          turningPoint('tp-1', 2, 'king-safety', 'unresolved', { motifsTriggered: [], movePlayed: { san: 'a2+', uci: 'a2a3' } })
        ]
      });
      const conflict: CentralConflict = centralConflictFixture('tp-1', 2, {
        consequenceChain: consequenceChain(2, { payoff: { kind: 'checkmate', atPly: 5 }, reachesResult: true })
      });
      const story = storyFixture({
        beats: [climaxBeat('beat-1', 2, 'tp-1')],
        centralConflict: conflict,
        confidence: noStoryConfidence({
          mechanismVerified: true,
          resolutionCorroborated: false,
          payoffCorroborated: true,
          causalClaimAllowed: false // still disallowed, e.g. hasConsequents false
        })
      });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, understanding, story);
      expect(moment!.reason).toBe('The decisive moment of the game — a king-safety issue is present, and the position stayed unresolved.');
      expect(moment!.reason).not.toContain('checkmate');
    });

    it('3. a no-conflict (abstained) StoryPlan is unaffected by the payoff-phrase logic', () => {
      // Games 03/06-shaped: centralConflict is null, so centralConflictReason
      // never reaches the payoff lookup at all.
      const timeline = timelineFromDurations([600]);
      const plan = cinematicPlan([directive('central-conflict-highlight', 1, 1, { kind: 'beat', id: 'beat-1' })]);
      const story = storyFixture({ confidence: noStoryConfidence({ reasons: ['no-story: no-admissible-candidate'] }) });
      const [moment] = deriveCinematicMoments(plan, timeline, QUIET_ANALYSIS, EMPTY_UNDERSTANDING, story);
      expect(moment!.reason).toBe('The decisive moment of the game.');
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

/**
 * Phase 15 (M11) — a long archetype span must not take the caption away
 * from the game's central conflict.
 *
 * The failure this covers: interval-overlap merging put a whole-game
 * archetype-track and a single-ply central-conflict-highlight into one
 * group, and because KIND_PRIORITY ranks archetype-track higher, the
 * archetype won the caption. A game's one decisive moment was narrated as
 * "a pawn advanced across the board before promoting".
 */
describe('archetype span must not swallow the central conflict (M11)', () => {
  const analysis = QUIET_ANALYSIS;
  const understanding = EMPTY_UNDERSTANDING;

  function momentsFor(directives: readonly AnnotationDirective[], plyCount: number) {
    const timeline = timelineFromDurations(Array.from({ length: plyCount }, () => 300));
    return deriveCinematicMoments(cinematicPlan(directives), timeline, analysis, understanding, EMPTY_STORY);
  }

  it('keeps a central-conflict highlight as its own moment inside a long archetype span', () => {
    const moments = momentsFor(
      [
        directive('archetype-track', 3, 115, { kind: 'archetypeSignal', archetype: 'pawn-journey' }),
        directive('central-conflict-highlight', 62, 62, { kind: 'beat', id: 'beat-climax-62' })
      ],
      120
    );

    const kinds = moments.map((m) => m.kind);
    expect(kinds).toContain('central-conflict-highlight');
    // Both survive: the archetype is not suppressed, it just does not own
    // the decisive moment's caption.
    expect(kinds).toContain('archetype-track');

    const climax = moments.find((m) => m.kind === 'central-conflict-highlight')!;
    expect(climax.fromPly).toBe(62);
    expect(climax.toPly).toBe(62);
    expect(climax.label).toBe('Climax');
  });

  it('still merges a SHORT archetype span with an overlapping central conflict, as before', () => {
    // The long-span rule is about whole-game ambience, not about archetypes
    // in general — a tight archetype genuinely about the same moment keeps
    // the existing merge behaviour.
    const moments = momentsFor(
      [
        directive('archetype-track', 60, 64, { kind: 'archetypeSignal', archetype: 'forced-trap' }),
        directive('central-conflict-highlight', 62, 62, { kind: 'beat', id: 'beat-climax-62' })
      ],
      70
    );

    expect(moments).toHaveLength(1);
    expect(moments[0]!.narratives.length).toBeGreaterThan(1);
  });

  it('does not disturb a long archetype span when there is no central conflict to protect', () => {
    const moments = momentsFor([directive('archetype-track', 3, 115, { kind: 'archetypeSignal', archetype: 'pawn-journey' })], 120);
    expect(moments).toHaveLength(1);
    expect(moments[0]!.kind).toBe('archetype-track');
  });
});

/**
 * Phase 15 — export/drawCaptions.ts's activeMomentAt documents and relies on
 * moment windows being non-overlapping ("the first interval containing
 * logicalTimeMs is the only one that ever can"). Merging used to guarantee
 * that for free; now that a terminal payoff is deliberately kept out of the
 * climax's group, the invariant is maintained by clamping instead.
 */
describe('non-overlapping window invariant (M11)', () => {
  it('trims a climax window so the payoff caption owns the payoff', () => {
    const timeline = timelineFromDurations([600, 600, 600]);
    const plan = cinematicPlan([
      directive('central-conflict-highlight', 1, 3),
      directive('terminal-result-highlight', 3, 3, { kind: 'terminal' })
    ]);
    const analysis = analysisEndingWith(3, { kind: 'terminal', result: 'white-wins' });
    const moments = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);

    expect(moments).toHaveLength(2);
    const [climax, payoff] = moments as [CinematicMoment, CinematicMoment];
    expect(climax.untilMs).toBe(payoff.atMs);
    expect(climax.targetTimeMs).toBeLessThan(payoff.atMs);
    expect(payoff.label).toBe('Checkmate');
  });

  it('leaves every moment window disjoint, for any directive set', () => {
    const timeline = timelineFromDurations([400, 400, 400, 400, 400]);
    const plan = cinematicPlan([
      directive('threat-refutation-arrow', 1, 1),
      directive('central-conflict-highlight', 2, 5),
      directive('archetype-track', 3, 5, { kind: 'archetypeSignal', archetype: 'king-hunt' }),
      directive('terminal-result-highlight', 5, 5, { kind: 'terminal' })
    ]);
    const analysis = analysisEndingWith(5, { kind: 'terminal', result: 'white-wins' });
    const moments = deriveCinematicMoments(plan, timeline, analysis, EMPTY_UNDERSTANDING, EMPTY_STORY);

    for (let i = 0; i + 1 < moments.length; i++) {
      expect(moments[i]!.untilMs).toBeLessThanOrEqual(moments[i + 1]!.atMs);
    }
    // Every surviving moment still has a real, non-empty window.
    for (const m of moments) {
      expect(m.untilMs).toBeGreaterThan(m.atMs);
      expect(m.targetTimeMs).toBeGreaterThanOrEqual(m.atMs);
      expect(m.targetTimeMs).toBeLessThan(m.untilMs);
    }
  });
});
