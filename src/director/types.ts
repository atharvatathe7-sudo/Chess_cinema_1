import type { PieceId } from '../pgn/types';
import type { TacticalMotif } from '../understanding/types';
import type { BeatRole, CausalFact, NoConflictReason, StoryArchetype } from '../story/types';

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
// Tactical annotations (Phase 18C)
// ============================================================

/**
 * Phase 18C — the visual EXPLANATION channel: annotations that answer "why
 * does this move work", as opposed to AnnotationDirective's channel, which
 * marks WHICH plies the story selected.
 *
 * Deliberately a SEPARATE directive list rather than more
 * AnnotationDirectiveKind values, for one concrete reason: that union is an
 * exhaustive Record key AND the subject of two exhaustive switches in
 * state/moments.ts that produce caption display copy, plus the terminal-hold
 * gate in export/runExport.ts. Widening it would force this phase to invent
 * caption text for tactical geometry — narration this layer is explicitly
 * not allowed to author (see the NO NATURAL LANGUAGE note at the bottom of
 * this file). Keeping a separate list leaves the Moment/caption layer
 * provably untouched while still lowering into the SAME AnnotationBeat and
 * the SAME unmodified renderer (render/drawAnnotations.ts) — a separate
 * channel, never a parallel rendering system.
 */
export type TacticalAnnotationKind =
  /** Arrow: a verified mechanism motif's attacker -> one of its own verified targets. */
  | 'mechanism-attack'
  /** Highlight: the square a verified pin/skewer passes THROUGH (the pinned/skewered piece). */
  | 'mechanism-line'
  /** Highlight: the square a verified discovery was revealed by vacating. */
  | 'mechanism-origin'
  /** Arrow: a departed defender's own square -> the target whose defence collapsed (DefenderLossRecord). */
  | 'defender-loss'
  /** Highlight: a restricted king plus exactly the escape squares that disappeared (KingMobilityRecord). */
  | 'escape-square-removed'
  /** Arrow: the refuting move's own destination -> the threat's own target square. */
  | 'refutation'
  /** Highlight: a ThreatRecord's own target square. */
  | 'threat-target'
  /** Arrow: the from -> to of a reply that a ForcedSequence establishes was forced. */
  | 'forced-response'
  /** Highlight: the checked/mated king's own square. */
  | 'check-marker'
  /** Arrow: the critical move's own from -> to. The honest fallback when nothing stronger is verified. */
  | 'critical-move';

/**
 * Which verified fact this annotation is drawn FROM. Every variant names a
 * record that already exists upstream — this layer never asserts geometry
 * of its own.
 *
 * Note the absence of 'deflection'/'overload': TacticalMotif carries both
 * labels, but understanding/motifs.ts has no detector for either (only
 * findForks/findLineMotifs/findDiscoveries exist), so no instance — and
 * therefore no geometry — can ever be produced for them. See
 * tacticalAnnotations.ts.
 */
export type TacticalEvidenceRef =
  | { readonly kind: 'motif'; readonly motif: TacticalMotif; readonly motifId: string }
  | { readonly kind: 'causal-fact'; readonly fact: CausalFact; readonly ply: number }
  | { readonly kind: 'threat'; readonly threatId: string }
  | { readonly kind: 'forced-sequence'; readonly sequenceId: string }
  | { readonly kind: 'terminal'; readonly ply: number }
  | { readonly kind: 'move'; readonly ply: number };

export interface TacticalAnnotationDirective {
  readonly fromPly: number;
  /** Inclusive. */
  readonly toPly: number;
  readonly kind: TacticalAnnotationKind;
  /** Which beat phase this annotation explains — the same grouping the camera uses (visualRelevance.ts's cameraRoleFor). */
  readonly role: CameraRole;
  /** For an arrow kind exactly [from, to]; for a highlight kind one or more squares. Board squares only, never coordinates. */
  readonly squares: readonly string[];
  /** The already-assigned identity of the piece this annotation is about, when one specific piece owns it. Never re-derived here. */
  readonly pieceId?: PieceId;
  /** Lower wins. Fixed per kind (TACTICAL_PRIORITY) — a stable ranking, never a per-game judgement. */
  readonly priority: number;
  readonly evidenceRef: TacticalEvidenceRef;
}

// ============================================================
// Tracking (Phase 18D Batch 1)
// ============================================================

/**
 * Phase 18D — the single-subject camera-tracking channel: "follow this one
 * verified piece/king through this bounded span." Deliberately its own list
 * rather than a property on CameraDirective, for the same reason Phase 18C
 * kept tactical annotations off AnnotationDirectiveKind rather than widening
 * it: CameraDirective's existing contract (camera.ts's merge logic, and
 * lowerToTimeline.ts's pre-climax ramp / terminal re-engagement) all assume
 * ONE static region per directive. Bolting a "this one actually moves" flag
 * onto it would force every one of those call sites to branch on it anyway,
 * with none of the clarity of a separate, single-purpose type — and would be
 * exactly the "redesign CameraDirective" this batch is required not to do.
 *
 * A TrackingDirective instead OVERLAYS one existing CameraDirective's own
 * atPly..untilPly span (see lowerToTimeline.ts's buildCameraPlan): the
 * CameraDirective still owns WHEN / WHICH ROLE / WHAT ZOOM AT REST: tracking
 * only supplies WHERE the camera points ply-by-ply within that span.
 */

/**
 * Deliberately just a stable PieceId, not a separate king/piece
 * discriminator: a king's PieceId is exactly as stable and resolvable
 * (including through castling, for its entire life) as any other piece's —
 * see pgn/assignPieceIdentities.ts, which assigns and moves the king through
 * the SAME generic occupancy mechanism every other piece uses (castling's
 * paired rook is the only special case, and it is its own separate
 * RookMove). Keeping one subject shape means tracking.ts's per-ply resolver
 * (pieceSquareAtPly) never special-cases "is this the king" — subject
 * SELECTION (tracking.ts's kingCandidate) is the only place that cares which
 * physical piece a candidate is.
 */
export type TrackingSubject = { readonly kind: 'piece'; readonly pieceId: PieceId };

/**
 * Which already-verified fact justified this tracking choice — Batch 1
 * supports exactly two, both reliably resolvable from data that already
 * exists. 'king-safety' mirrors VisualRegionSource's own naming for the
 * identical underlying fact (a checked/mated king, from
 * PlySignals.deliversCheck/deliversMate — never a new detector). 'move' is
 * the honest fallback: the single piece that made every move across the
 * span, when — and only when — it is genuinely the same piece throughout
 * (see tracking.ts's moverCandidate). A future batch's mechanism-attacker
 * case would add a third variant here; Batch 1 deliberately does not,
 * because resolving an attacker that didn't itself just move requires the
 * deferred occupancyAfterPly primitive.
 */
export type TrackingEvidenceRef = { readonly kind: 'king-safety'; readonly ply: number } | { readonly kind: 'move'; readonly ply: number };

export interface TrackingDirective {
  /** Always equal to the overlaid CameraDirective's own atPly — see lowerToTimeline.ts's buildCameraPlan. */
  readonly fromPly: number;
  /** Inclusive; always equal to that same CameraDirective's own untilPly. Batch 1 never tracks a sub-slice of a directive's span — see the module doc comment above. */
  readonly toPly: number;
  readonly subject: TrackingSubject;
  /** The CameraDirective this directive overlays. Batch 1 only ever produces 'critical' or 'consequence' — never 'establish'/'payoff', so tracking can never contest the terminal camera's own authority over the final beat. See tracking.ts's deriveTrackingDirectives. */
  readonly role: CameraRole;
  /** Lower wins. Fixed per evidence kind (TRACKING_PRIORITY in tracking.ts) — a stable ranking, never a per-game judgement. */
  readonly priority: number;
  readonly evidenceRef: TrackingEvidenceRef;
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
  /**
   * Phase 18C — hard ceiling on how many tactical annotations may be active
   * on any single ply, applied after priority ordering and redundancy
   * suppression (see tacticalAnnotations.ts). Deliberately small: the
   * viewer should follow one tactical idea per moment, so a strong pair
   * beats a correct-but-unreadable stack of arrows.
   */
  readonly maxTacticalAnnotationsPerPly: number;
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
  maxClipSpanPlies: 40,
  maxTacticalAnnotationsPerPly: 2
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
  /**
   * Phase 18C — the tactical EXPLANATION channel, ascending by fromPly then
   * priority. Empty whenever StoryPlan selected no central conflict, and
   * never populated from anything but already-verified upstream evidence.
   * Kept separate from annotationDirectives so the Moment/caption layer
   * (state/moments.ts) is untouched by it — see TacticalAnnotationDirective.
   */
  readonly tacticalDirectives: readonly TacticalAnnotationDirective[];
  /**
   * Phase 18D Batch 1 — the single-subject camera-TRACKING channel. At most
   * one entry per 'critical'/'consequence' CameraDirective, each overlaying
   * that directive's own atPly..untilPly span exactly (see
   * TrackingDirective's own doc comment). Empty whenever no reliable subject
   * exists — "no tracking is preferable to incorrect tracking" — and, like
   * tacticalDirectives, never consumed by the Moment/caption layer.
   */
  readonly trackingDirectives: readonly TrackingDirective[];
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
