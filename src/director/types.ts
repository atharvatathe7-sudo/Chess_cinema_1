import type { StoryArchetype } from '../story/types';

/**
 * Phase 2.4 — Cinematic Director data model.
 *
 * CinematicPlan is the structured, deterministic bridge between Phase 2.3's
 * StoryPlan (narrative SELECTION — which facts matter) and the existing,
 * unchanged Timeline/Scene/Beat/CameraPlan/Annotation contract the renderer,
 * PreviewLoop, and export already consume. This module performs
 * presentation DECISIONS (timing, camera focus, annotation placement) —
 * never chess-fact detection (Phase 2.1/2.2's job) and never narrative
 * selection (Phase 2.3's job).
 *
 * CinematicPlan is deliberately renderer-agnostic: no MoveBeat, no PieceId,
 * no board-pixel coordinates, no canvas/renderer object anywhere in this
 * file. Lowering CinematicPlan into the literal Timeline shape is
 * lowerToTimeline.ts's job alone.
 */

export const DIRECTOR_SCHEMA_VERSION = 1;

// ============================================================
// Timing
// ============================================================

/** How much screen time a ply gets, relative to DirectorSettings.baseMoveDurationMs. */
export type PacingClass = 'held' | 'linear' | 'compressed' | 'skipped';

export interface MoveTreatmentPlan {
  readonly ply: number;
  readonly pacing: PacingClass;
  /** durationMs = baseMoveDurationMs * durationMultiplier. 0 for 'skipped' — already renderer-safe (resolveAnimations.ts treats durationMs===0 as instantly complete). */
  readonly durationMultiplier: number;
}

/** A pause inserted before a ply, realized as a gap between beats at lowering time — never a new Beat kind. */
export interface TransitionDirective {
  readonly beforePly: number;
  readonly pauseMs: number;
}

// ============================================================
// Camera
// ============================================================

export type CameraFocusKind = 'full-board' | 'square-pair';

export interface CameraDirective {
  readonly atPly: number;
  readonly focus: CameraFocusKind;
  /** Square names (e.g. "e4"); resolved to board-space coordinates only at lowering time. */
  readonly squares: readonly string[];
  readonly evidenceRef: { readonly kind: 'beat'; readonly id: string };
}

// ============================================================
// Annotations
// ============================================================

export type AnnotationDirectiveKind =
  | 'last-move'
  | 'threat-refutation-arrow'
  | 'central-conflict-highlight'
  | 'archetype-track'
  | 'terminal-result-highlight';

export type AnnotationEvidenceRef =
  | { readonly kind: 'beat'; readonly id: string }
  | { readonly kind: 'archetypeSignal'; readonly archetype: StoryArchetype }
  | { readonly kind: 'terminal' }
  /** A directive derived from a single already-played move, not from any StoryPlan selection (e.g. 'last-move'). */
  | { readonly kind: 'move'; readonly ply: number };

export interface AnnotationDirective {
  readonly fromPly: number;
  /** Inclusive. */
  readonly toPly: number;
  readonly kind: AnnotationDirectiveKind;
  readonly squares: readonly string[];
  readonly evidenceRef: AnnotationEvidenceRef;
}

// ============================================================
// Settings
// ============================================================

export interface DirectorSettings {
  readonly baseMoveDurationMs: number;
  readonly heldMultiplier: number;
  readonly compressedMultiplier: number;
  readonly theoryMultiplier: number;
  readonly explanationOpportunityBonusMultiplier: number;
  readonly beatBoundaryPauseMs: number;
  /** > 1. Applied uniformly at the one v1 camera move (the climax zoom). */
  readonly climaxZoom: number;
  /**
   * Phase 12B — how long, immediately before the climax ply, the camera's
   * eased zoom-in ramp is allowed to run. Camera zoom used to start easing
   * toward climaxZoom from t=0 across the entire pre-climax portion of the
   * video, so easeOutCubic's own front-loaded shape (render/resolveCamera.ts,
   * unchanged) meant the camera was already sitting near-fully zoomed in —
   * and visually static — for a long stretch before the climax actually
   * happened (see the Phase 12 investigation's own zoom-curve quantification:
   * >99% zoomed by 78.5% of the way through the gap, regardless of gap
   * length). Compressing the ramp into a short, fixed window right before
   * the climax makes the zoom read as an arrival at the climax rather than
   * a long prior hold, without touching the easing function or any other
   * segment of the camera plan.
   */
  readonly preClimaxRampMs: number;
}

export const DEFAULT_DIRECTOR_SETTINGS: DirectorSettings = {
  baseMoveDurationMs: 600, // matches timeline/buildTrivialTimeline.ts's existing MOVE_DURATION_MS
  heldMultiplier: 2.5,
  compressedMultiplier: 0.5,
  theoryMultiplier: 0.25,
  explanationOpportunityBonusMultiplier: 1.4,
  beatBoundaryPauseMs: 400,
  climaxZoom: 1.8,
  preClimaxRampMs: 1200
};

// ============================================================
// Top-level output
// ============================================================

export interface CinematicPlan {
  readonly schemaVersion: typeof DIRECTOR_SCHEMA_VERSION;
  /** One entry per ply, ascending, total coverage — mirrors StoryPlan.moveTreatment's own ply coverage exactly. */
  readonly moveTreatmentPlan: readonly MoveTreatmentPlan[];
  /** Ascending by atPly. Empty when StoryPlan has no climax beat. */
  readonly cameraDirectives: readonly CameraDirective[];
  /** Ascending by fromPly, then a fixed kind order. */
  readonly annotationDirectives: readonly AnnotationDirective[];
  /** Ascending by beforePly. */
  readonly transitionDirectives: readonly TransitionDirective[];
  readonly settings: DirectorSettings;
}

/**
 * ============================================================
 * NO NATURAL LANGUAGE — the one rule for this entire module
 * ============================================================
 *
 * Every field in this file is either a reference into StoryPlan/
 * GameUnderstanding/GameAnalysis (never a copy of the fact itself), a
 * closed enum-like label (PacingClass, CameraFocusKind,
 * AnnotationDirectiveKind), or plain structural data (ply numbers, square
 * names, milliseconds). No field anywhere holds a sentence, a title, a
 * hook, a caption, a psychological claim, or unsupported intent. That
 * synthesis remains a later layer's responsibility — see the Phase 2.4
 * specification's narration-boundary decision.
 */
