import type { GameRecord } from '../pgn/types';
import type { GameAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import type { BeatRole, MoveTreatment, StoryBeat, StoryPlan } from '../story/types';
import { deriveCameraDirectives } from './camera';
import { deriveAnnotationDirectives } from './annotations';
import {
  DEFAULT_DIRECTOR_SETTINGS,
  DIRECTOR_SCHEMA_VERSION,
  type CinematicPlan,
  type DirectorSettings,
  type MoveTreatmentPlan,
  type PacingClass,
  type TransitionDirective
} from './types';

/**
 * Which StoryBeat (if any) owns a given ply. StoryPlan.moveTreatment's own
 * 'spine'/'setup' labels are derived from exactly these same beats
 * (spinePliesFromBeats/setupPliesFromBeats in story/beats.ts), so a
 * 'spine'/'setup' ply is always found here — never re-derived independently.
 */
function owningBeat(ply: number, beats: readonly StoryBeat[]): StoryBeat | undefined {
  return beats.find((b) => b.plies.includes(ply));
}

function pacingForBeatRole(role: BeatRole, settings: DirectorSettings): { pacing: PacingClass; durationMultiplier: number } {
  switch (role) {
    case 'setup':
      return { pacing: 'linear', durationMultiplier: 1 };
    case 'building-sequence':
      return { pacing: 'held', durationMultiplier: settings.heldMultiplier };
    case 'climax':
      return { pacing: 'held', durationMultiplier: settings.heldMultiplier };
    case 'consequence':
      return { pacing: 'linear', durationMultiplier: 1 };
    case 'resolution':
      return { pacing: 'held', durationMultiplier: settings.heldMultiplier };
  }
}

function pacingForMoveTreatment(treatment: MoveTreatment, settings: DirectorSettings): { pacing: PacingClass; durationMultiplier: number } {
  switch (treatment) {
    case 'compressible':
      return { pacing: 'compressed', durationMultiplier: settings.compressedMultiplier };
    case 'theory':
      return { pacing: 'compressed', durationMultiplier: settings.theoryMultiplier };
    case 'pruned':
      return { pacing: 'skipped', durationMultiplier: 0 };
    // 'spine' and 'setup' are always resolved via owningBeat before this
    // function is reached — see pacingForPly.
    case 'spine':
    case 'setup':
      return { pacing: 'linear', durationMultiplier: 1 };
  }
}

/**
 * The one pacing decision per ply: a ply that belongs to a StoryBeat is
 * paced by that beat's own role (setup/building-sequence/climax/
 * consequence/resolution); every other ply is paced by its own
 * MoveTreatment (compressible/theory/pruned) — StoryPlan's own
 * classification, never re-derived. An explanation-opportunity bonus
 * applies only to spine plies (climax/consequence/resolution) that also
 * carry one, reserving extra screen time for a later narration layer
 * without Director inventing any caption itself.
 */
export function pacingForPly(
  ply: number,
  treatment: MoveTreatment,
  beats: readonly StoryBeat[],
  explanationOpportunityPlies: ReadonlySet<number>,
  settings: DirectorSettings
): MoveTreatmentPlan {
  const beat = owningBeat(ply, beats);
  const base = beat ? pacingForBeatRole(beat.role, settings) : pacingForMoveTreatment(treatment, settings);

  const isSpineExplanationOpportunity = treatment === 'spine' && explanationOpportunityPlies.has(ply);
  const durationMultiplier = isSpineExplanationOpportunity
    ? base.durationMultiplier * settings.explanationOpportunityBonusMultiplier
    : base.durationMultiplier;

  return { ply, pacing: base.pacing, durationMultiplier };
}

function buildTransitionDirectives(beats: readonly StoryBeat[], settings: DirectorSettings): readonly TransitionDirective[] {
  return beats.slice(1).map((beat) => ({
    beforePly: beat.plies[0]!,
    pauseMs: settings.beatBoundaryPauseMs
  }));
}

/**
 * Phase 13B — true exactly when the game's own final position is a genuine
 * terminal result (checkmate/stalemate/draw). Mirrors director/
 * annotations.ts's own terminalResultDirectives condition exactly
 * (analysis.plies[last].evaluationAfter.kind === 'terminal') rather than
 * re-deriving a new terminal check — restated here because this file
 * already has GameAnalysis in scope and already passes it to
 * deriveAnnotationDirectives for the same purpose.
 */
function isTerminalPosition(analysis: GameAnalysis): boolean {
  if (analysis.plies.length === 0) return false;
  return analysis.plies[analysis.plies.length - 1]!.evaluationAfter.kind === 'terminal';
}

function emptyPlan(settings: DirectorSettings, analysis: GameAnalysis): CinematicPlan {
  return {
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
    moveTreatmentPlan: [],
    cameraDirectives: [],
    annotationDirectives: [],
    transitionDirectives: [],
    finalPositionIsTerminal: isTerminalPosition(analysis),
    settings
  };
}

/**
 * Top-level Phase 2.4 orchestration: (GameRecord, GameAnalysis,
 * GameUnderstanding, StoryPlan) -> CinematicPlan. Pure and synchronous —
 * every input is already fully materialized, so there is no engine call
 * this function could make even by accident. StoryPlan remains the sole
 * authority for narrative selection; this only decides presentation
 * (timing, camera focus, annotation placement) from what StoryPlan already
 * selected.
 */
export function buildCinematicPlan(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  story: StoryPlan,
  settings: DirectorSettings = DEFAULT_DIRECTOR_SETTINGS
): CinematicPlan {
  if (story.moveTreatment.length === 0) {
    return emptyPlan(settings, analysis);
  }

  const explanationOpportunityPlies = new Set(story.explanationOpportunities.map((eo) => eo.ply));

  const moveTreatmentPlan = story.moveTreatment.map((entry) =>
    pacingForPly(entry.ply, entry.treatment, story.beats, explanationOpportunityPlies, settings)
  );

  const cameraDirectives = deriveCameraDirectives(game, understanding, story);
  const annotationDirectives = deriveAnnotationDirectives(game, analysis, understanding, story);
  const transitionDirectives = buildTransitionDirectives(story.beats, settings);

  return {
    schemaVersion: DIRECTOR_SCHEMA_VERSION,
    moveTreatmentPlan,
    cameraDirectives,
    annotationDirectives,
    transitionDirectives,
    finalPositionIsTerminal: isTerminalPosition(analysis),
    settings
  };
}
