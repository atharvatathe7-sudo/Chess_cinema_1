import type { BeatRole, NoConflictReason, StoryArchetype } from '../story/types';

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

/**
 * Phase 18B — which conceptual camera event a directive realizes. Mirrors
 * BeatRole's own grouping (see visualRelevance.ts's cameraRoleFor):
 * 'setup'/'building-sequence' both become 'establish', 'climax' becomes
 * 'critical', 'consequence' stays 'consequence', 'resolution' becomes
 * 'payoff'. lowerToTimeline.ts uses this — not array position — to decide
 * which directive gets the pre-climax ramp ('critical') and which gets
 * terminal payoff re-engagement (the last directive).
 */
export type CameraRole = 'establish' | 'critical' | 'consequence' | 'payoff';

export interface CameraDirective {
  /** First ply this directive's framing covers. */
  readonly atPly: number;
  /** Inclusive. Last ply this directive's framing holds through — equal to atPly for a single-ply directive. */
  readonly untilPly: number;
  readonly role: CameraRole;
  /**
   * Phase 18B — derived from the region's own bounding box (see
   * director/camera.ts's zoomForSquares), never a fixed constant. > 1 means
   * tighter than full-board; exactly 1 means full-board framing was already
   * the truthful choice for this region.
   */
  readonly zoom: number;
  /** Every square this directive's region considers relevant (primary + secondary, deduped); resolved to board-space coordinates only at lowering time. */
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
  /**
   * Phase 18B — replaces the old fixed climaxZoom. Extra board-units of
   * padding kept visible on EACH side of a VisualRegion's own tight
   * bounding box, so the camera never crops the box itself to fill the
   * frame — see director/camera.ts's zoomForSquares. Chosen from the same
   * 0..8 board-unit coordinate system render/coords.ts already uses (one
   * square = 1 unit) and validated visually against the real corpus.
   */
  readonly minVisibleContextSquares: number;
  /** Phase 18B — the tightest zoom zoomForSquares may ever produce, regardless of how small a region is. Board-relative, same >1-means-tighter convention as the old climaxZoom. */
  readonly maxZoom: number;
  /**
   * Phase 12B — how long, immediately before the climax/critical beat, the
   * camera's eased zoom-in ramp is allowed to run. Camera zoom used to
   * start easing toward the climax framing from t=0 across the entire
   * pre-climax portion of the video, so easeOutCubic's own front-loaded
   * shape (render/resolveCamera.ts, unchanged) meant the camera was already
   * sitting near-fully zoomed in — and visually static — for a long
   * stretch before the climax actually happened (see the Phase 12
   * investigation's own zoom-curve quantification: >99% zoomed by 78.5% of
   * the way through the gap, regardless of gap length). Compressing the
   * ramp into a short, fixed window right before the climax makes the zoom
   * read as an arrival at the climax rather than a long prior hold, without
   * touching the easing function or any other segment of the camera plan.
   * Phase 18B applies this only to the 'critical' CameraDirective — see
   * lowerToTimeline.ts's buildCameraPlan.
   */
  readonly preClimaxRampMs: number;
  /**
   * Phase 18A — a conservative safety-valve ceiling on how many plies a
   * windowed Cinematic Moment export may span (inclusive, startPly..endPly).
   * See clipWindow.ts's deriveClipWindow: exceeding this trims SETUP first,
   * never mid-consequence, and sets ClipWindow.truncated = true. Has no
   * effect on the Full Game path (timeline/buildTrivialTimeline.ts), which
   * clip windowing does not touch.
   */
  readonly maxClipSpanPlies: number;
}

export const DEFAULT_DIRECTOR_SETTINGS: DirectorSettings = {
  baseMoveDurationMs: 600, // matches timeline/buildTrivialTimeline.ts's existing MOVE_DURATION_MS
  heldMultiplier: 2.5,
  compressedMultiplier: 0.5,
  theoryMultiplier: 0.25,
  explanationOpportunityBonusMultiplier: 1.4,
  beatBoundaryPauseMs: 400,
  minVisibleContextSquares: 1.5,
  maxZoom: 2.2,
  preClimaxRampMs: 1200,
  maxClipSpanPlies: 40
};

// ============================================================
// Clip window (Phase 18A)
// ============================================================

/**
 * Which portion of the game's moves a Cinematic Moment export should
 * include, derived strictly from StoryPlan's own CentralConflict/
 * ConsequenceChain/PayoffTerminus evidence — never a new story-selection
 * mechanism. See clipWindow.ts's deriveClipWindow, the only place this
 * type is constructed.
 *
 * 'abstained' mirrors StoryPlan's own centralConflict === null case exactly
 * (same NoConflictReason), so a consumer that already branches on
 * StoryPlan.centralConflict needs no new concept here — it is simply
 * "no window", and lowerToTimeline.ts falls back to the existing,
 * unwindowed Full Game behavior for it.
 */
export type ClipWindow =
  | {
      readonly kind: 'windowed';
      /** Inclusive. chain.antecedents[0].ply, or criticalPly when there are no antecedents. */
      readonly startPly: number;
      /** Ascending. Subset of the chain's own antecedents' plies that survived truncation. */
      readonly setupPlies: readonly number[];
      /** The primary turning point's own ply (== ConsequenceChain.triggerPly). */
      readonly criticalPly: number;
      /** Ascending. The chain's own consequents' plies, verbatim — never secondaryConflicts. */
      readonly consequencePlies: readonly number[];
      /** null only for an 'off-board-result' or 'unresolved' payoff. */
      readonly payoffPly: number | null;
      /** Inclusive. The last ply this window includes. */
      readonly endPly: number;
      /** True only when maxClipSpanPlies forced startPly later than the chain's own raw antecedents[0].ply. */
      readonly truncated: boolean;
    }
  | { readonly kind: 'abstained'; readonly reason: NoConflictReason | undefined };

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
  /**
   * Phase 13B — true exactly when the game's own final position is a
   * genuine terminal result (checkmate/stalemate/draw): the same condition
   * director/annotations.ts's terminalResultDirectives already uses
   * (analysis.plies[last].evaluationAfter.kind === 'terminal'), restated
   * here rather than re-derived, since buildCinematicPlan.ts already
   * receives GameAnalysis and already computes this exact fact for
   * annotationDirectives. Consumed by lowerToTimeline.ts's buildCameraPlan
   * to re-engage the camera on the actual terminal move — see the Phase 13A
   * design report (Phase 18B additionally threads GameAnalysis into
   * director/camera.ts itself, for verified-geometry lookups; this field's
   * own role here is unchanged).
   */
  readonly finalPositionIsTerminal: boolean;
  readonly settings: DirectorSettings;
}

/**
 * ============================================================
 * NO NATURAL LANGUAGE — the one rule for this entire module
 * ============================================================
 *
 * Every field in this file is either a reference into StoryPlan/
 * GameUnderstanding/GameAnalysis (never a copy of the fact itself), a
 * closed enum-like label (PacingClass, CameraRole,
 * AnnotationDirectiveKind), or plain structural data (ply numbers, square
 * names, milliseconds). No field anywhere holds a sentence, a title, a
 * hook, a caption, a psychological claim, or unsupported intent. That
 * synthesis remains a later layer's responsibility — see the Phase 2.4
 * specification's narration-boundary decision.
 */
