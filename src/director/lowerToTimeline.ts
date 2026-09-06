import type { GameRecord, MoveRecord } from '../pgn/types';
import type { StoryArchetype, StoryPlan } from '../story/types';
import type { Annotation, AnnotationBeat, CameraKeyframe, CameraPlan, MoveBeat, Scene, Timeline } from '../timeline/types';
import { boundsOfSquares } from '../render/coords';
import { deriveClipWindow } from './clipWindow';
import { zoomForSquares } from './camera';
import { pieceSquareAtPly } from './tracking';
import type {
  AnnotationDirective,
  AnnotationDirectiveKind,
  CameraDirective,
  CinematicPlan,
  DirectorSettings,
  TacticalAnnotationDirective,
  TacticalAnnotationKind,
  TrackingDirective
} from './types';

/**
 * CinematicPlan + GameRecord -> Timeline, the existing renderer-facing
 * contract, completely unchanged in shape. This is a purely mechanical
 * lowering step: every editorial decision was already made by
 * buildCinematicPlan/camera.ts/annotations.ts — this file only converts
 * ply-indexed directives into the literal atMs/untilMs/board-space
 * encoding Renderer/PreviewLoop/export already consume.
 *
 * Self-contained: does not import timeline/buildTrivialTimeline.ts. The
 * per-move MoveBeat field mapping is re-derived here directly from
 * GameRecord.moves rather than shared with buildTrivialTimeline.ts's own
 * copy of the same small mapping — seven direct field reads, not enough
 * duplication to justify touching existing, shipped Phase 1 code for.
 */

const SCENE_ID = 'scene-0';

function buildMoveBeats(
  moves: readonly MoveRecord[],
  plan: CinematicPlan
): { beats: MoveBeat[]; plyAtMs: Map<number, number>; plyDurationMs: Map<number, number>; totalMs: number } {
  const treatmentByPly = new Map(plan.moveTreatmentPlan.map((t) => [t.ply, t]));
  const pauseByPly = new Map(plan.transitionDirectives.map((t) => [t.beforePly, t.pauseMs]));

  const beats: MoveBeat[] = [];
  const plyAtMs = new Map<number, number>();
  const plyDurationMs = new Map<number, number>();
  let cursorMs = 0;

  for (const move of moves) {
    const pauseMs = pauseByPly.get(move.ply);
    if (pauseMs) cursorMs += pauseMs;

    const treatment = treatmentByPly.get(move.ply);
    const durationMs = treatment ? Math.round(plan.settings.baseMoveDurationMs * treatment.durationMultiplier) : plan.settings.baseMoveDurationMs;

    const atMs = cursorMs;
    beats.push({
      kind: 'move',
      san: move.san,
      pieceId: move.pieceId,
      from: move.from,
      to: move.to,
      atMs,
      durationMs,
      capturedPieceId: move.capturedPieceId,
      promotion: move.promotion,
      isEnPassant: move.isEnPassant,
      rookMove: move.rookMove,
      resultingPly: move.ply
    });

    plyAtMs.set(move.ply, atMs);
    plyDurationMs.set(move.ply, durationMs);
    cursorMs += durationMs;
  }

  return { beats, plyAtMs, plyDurationMs, totalMs: cursorMs };
}

const ANNOTATION_STYLE: Readonly<Record<AnnotationDirectiveKind, { type: Annotation['type']; color: string }>> = {
  'last-move': { type: 'highlight', color: '#9aa5b1' },
  'threat-refutation-arrow': { type: 'arrow', color: '#f4a300' },
  'central-conflict-highlight': { type: 'highlight', color: '#d63447' },
  // Overridden per-archetype by colorFor() below; this default is never actually rendered.
  'archetype-track': { type: 'highlight', color: '#7b2ff7' },
  'terminal-result-highlight': { type: 'highlight', color: '#2ecc71' }
};

const ARCHETYPE_COLOR: Readonly<Record<StoryArchetype, string>> = {
  'king-hunt': '#7b2ff7',
  'pawn-journey': '#00b8a9',
  'forced-trap': '#e94560',
  'stalemate-swindle': '#f4a300',
  // Phase 16 — type-completion entry only, reusing the existing stalemate hue.
  'stalemate-blunder': '#f4a300'
};

function colorFor(directive: AnnotationDirective): string {
  if (directive.kind === 'archetype-track' && directive.evidenceRef.kind === 'archetypeSignal') {
    return ARCHETYPE_COLOR[directive.evidenceRef.archetype];
  }
  return ANNOTATION_STYLE[directive.kind].color;
}

function buildAnnotationBeats(
  directives: readonly AnnotationDirective[],
  plyAtMs: ReadonlyMap<number, number>,
  plyDurationMs: ReadonlyMap<number, number>
): AnnotationBeat[] {
  const beats: AnnotationBeat[] = [];
  for (const directive of directives) {
    const atMs = plyAtMs.get(directive.fromPly);
    const endAtMs = plyAtMs.get(directive.toPly);
    const endDurationMs = plyDurationMs.get(directive.toPly);
    if (atMs === undefined || endAtMs === undefined || endDurationMs === undefined) continue;

    beats.push({
      kind: 'annotation',
      annotation: {
        type: ANNOTATION_STYLE[directive.kind].type,
        squares: [...directive.squares],
        color: colorFor(directive)
      },
      atMs,
      untilMs: endAtMs + endDurationMs
    });
  }
  return beats;
}

/**
 * Phase 18C — how each tactical explanation kind is drawn. Arrow kinds take
 * exactly the directive's own [from, to]; every other kind fills its own
 * squares. Both are the SAME Annotation shapes render/drawAnnotations.ts
 * already draws — this phase adds no renderer capability.
 */
const TACTICAL_STYLE: Readonly<Record<TacticalAnnotationKind, { type: Annotation['type']; color: string }>> = {
  'mechanism-attack': { type: 'arrow', color: '#e94560' },
  'mechanism-line': { type: 'highlight', color: '#e94560' },
  'mechanism-origin': { type: 'highlight', color: '#f4a300' },
  'defender-loss': { type: 'arrow', color: '#ff6b35' },
  'escape-square-removed': { type: 'highlight', color: '#7b2ff7' },
  refutation: { type: 'arrow', color: '#f4a300' },
  'threat-target': { type: 'highlight', color: '#f4a300' },
  'forced-response': { type: 'arrow', color: '#00b8a9' },
  'check-marker': { type: 'highlight', color: '#2ecc71' },
  'critical-move': { type: 'arrow', color: '#d63447' }
};

/**
 * Phase 18C — tactical directives become AnnotationBeats through exactly the
 * same ply -> time resolution as story annotations, including the same
 * fail-safe skip: a directive whose plies fall outside the selected clip
 * window has no MoveBeat to anchor to and is silently omitted, so an
 * annotation can never point at a move the viewer never sees.
 */
function buildTacticalBeats(
  directives: readonly TacticalAnnotationDirective[],
  plyAtMs: ReadonlyMap<number, number>,
  plyDurationMs: ReadonlyMap<number, number>
): AnnotationBeat[] {
  const beats: AnnotationBeat[] = [];
  for (const directive of directives) {
    const atMs = plyAtMs.get(directive.fromPly);
    const endAtMs = plyAtMs.get(directive.toPly);
    const endDurationMs = plyDurationMs.get(directive.toPly);
    if (atMs === undefined || endAtMs === undefined || endDurationMs === undefined) continue;

    const style = TACTICAL_STYLE[directive.kind];
    // An arrow needs two distinct endpoints; drawAnnotations reads exactly
    // squares[0] and squares[1] and silently draws nothing otherwise, so a
    // malformed pair is dropped here rather than emitted as an invisible beat.
    if (style.type === 'arrow' && directive.squares.length < 2) continue;

    beats.push({
      kind: 'annotation',
      annotation: {
        type: style.type,
        squares: [...directive.squares],
        color: style.color
      },
      atMs,
      untilMs: endAtMs + endDurationMs
    });
  }
  return beats;
}

const BASE_CAMERA_KEYFRAME: CameraKeyframe = { atMs: 0, centerX: 4, centerY: 4, zoom: 1 };

/**
 * Phase 13B — terminal payoff camera re-engagement. Independent design
 * constants, deliberately not coupled to DEFAULT_DIRECTOR_SETTINGS or any
 * other existing constant (same restatement-over-coupling precedent this
 * file's own Phase 12B ramp comment, and export/runExport.ts's
 * TERMINAL_HOLD_MS, already established).
 *
 * TERMINAL_ZOOM_OUT_MS is the mandatory reset tail reserved immediately
 * before sceneDurationMs so the camera is always back to (approximately)
 * the base full-board framing by the time export/runExport.ts's Phase 12A
 * terminal-hold freeze query (sceneDurationMs - 1) samples it — see the
 * Phase 13A design report's derivation: ~93ms was the analytical floor for
 * that freeze query to already land within 1e-6 of zoom = 1 at the old
 * fixed climaxZoom = 1.8; 200ms keeps a comfortable margin, and Phase 18B's
 * dynamic zoom never exceeds DirectorSettings.maxZoom, which stays in the
 * same range.
 *
 * TERMINAL_ZOOM_IN_MS is the short window immediately before the terminal
 * ply in which the camera re-approaches the payoff directive's own zoom,
 * mirroring preClimaxRampMs's own "short, fixed window" shape at a smaller
 * scale appropriate to a single move rather than an entire pre-climax
 * buildup.
 */
export const TERMINAL_ZOOM_OUT_MS = 200;
export const TERMINAL_ZOOM_IN_MS = 400;

/** Board-space center of a directive's own relevant squares — the same bounding box director/camera.ts's zoomForSquares already sized the zoom for, so center and zoom can never disagree (see render/coords.ts's boundsOfSquares doc comment). */
function centerOfSquares(squares: readonly string[]): { centerX: number; centerY: number } {
  const bounds = boundsOfSquares(squares);
  if (!bounds) return { centerX: 4, centerY: 4 };
  return { centerX: (bounds.minX + bounds.maxX) / 2, centerY: (bounds.minY + bounds.maxY) / 2 };
}

/**
 * Phase 18D Batch 1 — what a CameraDirective's own dwell should actually
 * show: either the plain static box (no tracking, or tracking that could
 * not be honestly applied), or a per-ply moving sequence.
 *
 * `points` are extra keyframes to insert IN PLACE OF the single static
 * "start" keyframe buildCameraPlan would otherwise push — empty whenever
 * tracking does not apply, which is exactly how an empty trackingDirectives
 * list reproduces today's plan byte-for-byte (see lowerToTimeline.test.ts's
 * regression for this). `centerX/centerY/zoom` are the RESTING values used
 * for everything after that — the natural hold-end keyframe, the pre-climax
 * ramp's landing target when it lands on THIS directive, and (for the last
 * directive) every terminal/no-terminal keyframe below — exactly the role
 * the single static center/zoom used to fill.
 */
interface DirectiveFraming {
  readonly points: readonly CameraKeyframe[];
  readonly centerX: number;
  readonly centerY: number;
  readonly zoom: number;
}

/**
 * Resolves a directive's own framing, tracked or not. Never emits a
 * keyframe for a ply outside the windowed clip (plyAtMs has no entry) —
 * the same safe-omission convention buildAnnotationBeats/buildTacticalBeats
 * already use — and truncates cleanly the moment the tracked subject can no
 * longer be resolved (captured, or the clip window ends mid-span), falling
 * back to the directive's own static region for the remainder: "do not
 * fabricate a position" (Phase 18D conflict rule 8). A tracked ply's own
 * zoom is evidence-derived exactly like Phase 18B's static zoom — never a
 * bare square — by unioning the subject's own square with that ply's own
 * move geometry (from/to), the same fallback tier visualRelevance.ts's own
 * moveFallbackRegion already uses, before calling the SAME zoomForSquares
 * Phase 18B established.
 */
/**
 * Phase 18E-A — every square an ACTIVE tactical annotation needs visible on
 * this exact ply. Tactical directives are already ply-scoped precisely
 * (unlike a CameraDirective's own flat, whole-beat square union), so this
 * is the honest way to recover "the owning CameraDirective's relevant
 * evidence for THIS ply" without inventing per-ply attribution the
 * CameraDirective itself doesn't carry: a camera region and its beat's
 * tactical annotations are already derived from the SAME verified facts
 * (visualRelevance.ts's criticalRegion/consequenceRegion and
 * tacticalAnnotations.ts's own derivation both read the same
 * mechanism/causal-fact/threat evidence), so whichever of that evidence is
 * actually being drawn as an annotation on this ply is exactly the subset
 * the camera must not crop. An annotation the tactical channel already
 * suppressed (priority/redundancy/per-ply cap) is, by definition, not being
 * shown — nothing on screen needs protecting for it.
 */
function activeTacticalSquares(ply: number, tacticalDirectives: readonly TacticalAnnotationDirective[]): readonly string[] {
  const squares = new Set<string>();
  for (const t of tacticalDirectives) {
    if (ply < t.fromPly || ply > t.toPly) continue;
    for (const sq of t.squares) squares.add(sq);
  }
  return [...squares];
}

function framingFor(
  directive: CameraDirective,
  tracking: TrackingDirective | undefined,
  game: GameRecord | undefined,
  settings: DirectorSettings | undefined,
  plyAtMs: ReadonlyMap<number, number>,
  tacticalDirectives: readonly TacticalAnnotationDirective[]
): DirectiveFraming {
  const fallback = centerOfSquares(directive.squares);
  const staticFraming: DirectiveFraming = { points: [], centerX: fallback.centerX, centerY: fallback.centerY, zoom: directive.zoom };
  if (!tracking || !game || !settings) return staticFraming;

  const trackedPlies = game.moves.filter((m) => m.ply >= tracking.fromPly && m.ply <= tracking.toPly).map((m) => m.ply);
  const points: CameraKeyframe[] = [];
  let lastPoint: { centerX: number; centerY: number; zoom: number } | null = null;
  // Set the moment tracking cannot continue for the REST of its own
  // declared span — a capture, or a clip-window boundary reached mid-span
  // (clip windows are always one contiguous range, so once a ply is
  // missing from plyAtMs every later ply is missing too). Either way,
  // "the subject cannot be resolved at a ply" (Phase 18D conflict rule 8)
  // means falling back to the directive's own static region for whatever
  // remains — never holding on a stale or nonexistent position. This is
  // distinct from tracking simply reaching its own toPly with nothing gone
  // wrong, where holding at the last real tracked position is the truthful
  // choice (see `resting` below).
  let truncatedEarly = false;

  for (const ply of trackedPlies) {
    const atMs = plyAtMs.get(ply);
    if (atMs === undefined) {
      // Outside the selected clip window. If this is the very FIRST tracked
      // ply, there is nothing to track at all for this directive; fall back
      // entirely rather than start mid-sequence.
      if (points.length === 0) return staticFraming;
      truncatedEarly = true;
      break;
    }

    const square = pieceSquareAtPly(game, tracking.subject.pieceId, ply);
    if (square === null) {
      truncatedEarly = true;
      break;
    }

    const move = game.moves.find((m) => m.ply === ply)!;
    // Phase 18E-A — never narrower than whatever tactical geometry is
    // actually being drawn on this ply: the smallest region that still
    // safely contains it, widening past the bare subject+move geometry
    // exactly when (and only when) it must (see activeTacticalSquares).
    const regionSquares = [...new Set([square, move.from, move.to, ...activeTacticalSquares(ply, tacticalDirectives)])];
    const { centerX, centerY } = centerOfSquares(regionSquares);
    const zoom = zoomForSquares(regionSquares, settings);
    points.push({ atMs, centerX, centerY, zoom });
    lastPoint = { centerX, centerY, zoom };
  }

  if (points.length === 0) return staticFraming;
  const resting = truncatedEarly || !lastPoint ? { centerX: fallback.centerX, centerY: fallback.centerY, zoom: directive.zoom } : lastPoint;
  return { points, centerX: resting.centerX, centerY: resting.centerY, zoom: resting.zoom };
}

/** A TrackingDirective always overlays exactly one CameraDirective's own span — see TrackingDirective's own doc comment. */
function trackingFor(directive: CameraDirective, trackingDirectives: readonly TrackingDirective[]): TrackingDirective | undefined {
  return trackingDirectives.find((t) => t.role === directive.role && t.fromPly === directive.atPly && t.toPly === directive.untilPly);
}

export function buildCameraPlan(
  directives: readonly CameraDirective[],
  plyAtMs: ReadonlyMap<number, number>,
  plyDurationMs: ReadonlyMap<number, number>,
  sceneDurationMs: number,
  preClimaxRampMs: number,
  /**
   * Phase 13B — the actual logical time the game's own terminal ply (the
   * literal checkmate/stalemate-delivering move) begins, or null when the
   * game does not end in a genuine terminal result. Resolved by
   * lowerToTimeline() from the game's own last move. Phase 18B applies the
   * terminal re-engagement below only to the LAST CameraDirective (whatever
   * its role — establish/critical/consequence/payoff), since that is the
   * only directive whose hold can run into the scene's own end.
   */
  terminalPlyAtMs: number | null,
  /**
   * Phase 18D Batch 1 — optional camera tracking, additive only. Every
   * existing call site (every test written before this batch) omits these
   * three trailing parameters and gets byte-identical output: an empty
   * array here means trackingFor() never matches anything, so every
   * directive takes the exact code path it always has. `game`/`settings`
   * are only needed to actually resolve a tracked subject's square and its
   * per-ply zoom; they are optional for the same reason.
   */
  trackingDirectives: readonly TrackingDirective[] = [],
  game?: GameRecord,
  settings?: DirectorSettings,
  /**
   * Phase 18E-A — optional, additive. Every pre-existing call site omits
   * this and gets byte-identical output: framingFor's own
   * activeTacticalSquares lookup against an empty list never adds anything,
   * so a tracked ply's region is exactly [subject, move.from, move.to] as
   * before. Only used to widen (never narrow) a tracked ply's own region —
   * see framingFor's own doc comment.
   */
  tacticalDirectives: readonly TacticalAnnotationDirective[] = []
): CameraPlan {
  if (directives.length === 0) {
    return { keyframes: [BASE_CAMERA_KEYFRAME] };
  }

  const keyframes: CameraKeyframe[] = [BASE_CAMERA_KEYFRAME];
  let lastKeyframeAtMs = 0;

  for (let i = 0; i < directives.length; i++) {
    const directive = directives[i]!;
    const isLast = i === directives.length - 1;

    const atMs = plyAtMs.get(directive.atPly);
    if (atMs === undefined) continue;
    const untilAtMs = plyAtMs.get(directive.untilPly);
    const untilDurationMs = plyDurationMs.get(directive.untilPly);
    const naturalHoldEndMs = untilAtMs !== undefined && untilDurationMs !== undefined ? untilAtMs + untilDurationMs : atMs + (plyDurationMs.get(directive.atPly) ?? 0);

    const framing = framingFor(directive, trackingFor(directive, trackingDirectives), game, settings, plyAtMs, tacticalDirectives);
    const { centerX, centerY, zoom } = framing;

    // Phase 12B — hold at the base full-board framing until shortly before
    // the 'critical' directive, so easeOutCubic's own eased ramp
    // (render/resolveCamera.ts, unchanged) is compressed into a short,
    // fixed window immediately preceding it rather than spread across
    // everything since the last keyframe. Omitted entirely
    // (rampStartMs <= lastKeyframeAtMs) whenever the critical beat happens
    // too soon after the last keyframe for a full ramp window — the
    // interpolation then simply uses however much time is already
    // available, identical to pre-Phase-12B behavior for every such game
    // (e.g. Scholar's Mate). Phase 18B — gated to role 'critical' only:
    // an establish/consequence/payoff reframe already reads as a deliberate
    // transition via the plain interpolation from the previous directive's
    // own hold-end, and does not need this extra full-board dip.
    if (directive.role === 'critical') {
      const rampStartMs = Math.max(lastKeyframeAtMs, atMs - preClimaxRampMs);
      if (rampStartMs > lastKeyframeAtMs) {
        keyframes.push({ atMs: rampStartMs, centerX: 4, centerY: 4, zoom: 1 });
      }
    }

    // Zoom in, then hold at the same values through this directive's own
    // dwell time — two identical-value keyframes at different atMs create a
    // genuine hold under resolveCamera.ts's own interpolation (unchanged).
    // Phase 18D Batch 1 — when tracking resolved one or more per-ply points
    // for this directive, they replace the single static "zoom in" keyframe
    // (framing.points[0] is always at this same atMs — see trackingFor's own
    // fromPly===directive.atPly invariant); everything below this still
    // reads centerX/centerY/zoom, which framingFor already set to the
    // tracked sequence's own resting position, so no other line changes.
    if (framing.points.length > 0) {
      for (const point of framing.points) keyframes.push(point);
    } else {
      keyframes.push({ atMs, centerX, centerY, zoom });
    }

    if (!isLast) {
      keyframes.push({ atMs: naturalHoldEndMs, centerX, centerY, zoom });
      lastKeyframeAtMs = naturalHoldEndMs;
      continue;
    }

    // Phase 13B — the story-layer climax/payoff is deliberately anchored on
    // the turning point that makes the outcome inevitable (e.g. the blunder
    // before a forced mate), not necessarily the later move that
    // mechanically delivers it (see the Phase 13 investigation and
    // story.spec.ts's own documented reasoning) — that selection is
    // intentionally left unchanged. What follows only adjusts how long the
    // camera stays engaged on the LAST directive, so the actual terminal
    // move itself also reads as visually decisive rather than playing out
    // after the camera has already reset.
    if (terminalPlyAtMs !== null && terminalPlyAtMs > naturalHoldEndMs) {
      // Gap case (Evergreen/Stalemate-shaped): the terminal move happens
      // well after this directive's own hold naturally ends, with genuinely
      // distinct consequence moves in between (e.g. Evergreen's Qxd7+,
      // Kxd7, Bf5+, Ke8, Bd7+, Kf8) that should stay at full-board framing
      // rather than sit inside an unnaturally long zoomed hold. The
      // existing hold-end is left exactly as it was; a short, separate
      // re-engagement episode is appended, timed on the terminal ply
      // itself: reset to full board, re-approach this directive's own zoom
      // in the final TERMINAL_ZOOM_IN_MS before the terminal move begins,
      // hold through most of it, then leave TERMINAL_ZOOM_OUT_MS of reset
      // room before sceneDurationMs. Every new keyframe here is guarded
      // with Math.max/a strict-inequality skip so a small or zero gap
      // between the hold-end and the terminal move never produces a
      // duplicate or out-of-order timestamp — see the Phase 13A design
      // report's own Scholar's Mate keyframe-safety analysis.
      keyframes.push({ atMs: naturalHoldEndMs, centerX, centerY, zoom });

      const reengageStartMs = terminalPlyAtMs - TERMINAL_ZOOM_IN_MS;
      if (reengageStartMs > naturalHoldEndMs) {
        keyframes.push({ atMs: reengageStartMs, centerX, centerY, zoom: 1 });
      }

      keyframes.push({ atMs: terminalPlyAtMs, centerX, centerY, zoom });

      const proposedHoldEndMs = sceneDurationMs - TERMINAL_ZOOM_OUT_MS;
      const holdEndMs = proposedHoldEndMs > terminalPlyAtMs ? proposedHoldEndMs : terminalPlyAtMs;
      if (holdEndMs > terminalPlyAtMs) {
        keyframes.push({ atMs: holdEndMs, centerX, centerY, zoom });
      }
    } else if (terminalPlyAtMs !== null) {
      // Zero/negative-gap case (Scholar's-Mate-shaped): the terminal move
      // already begins at or before this directive's own hold naturally
      // ends, so there is no separate episode to insert — simply extend the
      // SAME hold-end keyframe far enough to leave TERMINAL_ZOOM_OUT_MS of
      // reset room before sceneDurationMs (that's the "propose the later of
      // the two" step below). Guarded to fall back to a CLAMPED-DOWN
      // latestHoldEndMs — never the unextended natural hold-end verbatim —
      // whenever the proposal would land AT OR PAST sceneDurationMs itself:
      // e.g. when this directive's own ply IS the game's last ply, where
      // naturalHoldEndMs can equal sceneDurationMs exactly. Falling back to
      // naturalHoldEndMs there would push a keyframe AT sceneDurationMs,
      // sharing that timestamp with the final unconditional reset
      // immediately below — two same-timestamp keyframes with different
      // centers make resolveCamera's own interval search pick whichever
      // sorts first, breaking Phase 12A's freeze-anchor query.
      const latestHoldEndMs = sceneDurationMs - TERMINAL_ZOOM_OUT_MS;
      const proposedHoldEndMs = Math.max(naturalHoldEndMs, latestHoldEndMs);
      const holdEndMs = proposedHoldEndMs < sceneDurationMs ? proposedHoldEndMs : latestHoldEndMs > atMs ? latestHoldEndMs : naturalHoldEndMs;
      keyframes.push({ atMs: holdEndMs, centerX, centerY, zoom });
    } else {
      // Phase 15 — reserve the same reset tail the terminal branches above
      // already reserve.
      //
      // When the last directive's own hold runs all the way to
      // sceneDurationMs, the hold-end keyframe and the final unconditional
      // reset land on the same timestamp and the camera never actually
      // returns to full board: the Phase 12A freeze query at
      // sceneDurationMs - 1 reads the full zoom, and the exported video
      // ends frozen mid-zoom. Clamping only ever moves the hold END
      // earlier, never the zoom-in, and only when the hold would otherwise
      // overrun the reset tail — so every game with room to spare keeps a
      // byte-identical camera plan.
      const latestHoldEndMs = sceneDurationMs - TERMINAL_ZOOM_OUT_MS;
      const holdEndMs = naturalHoldEndMs > latestHoldEndMs && latestHoldEndMs > atMs ? latestHoldEndMs : naturalHoldEndMs;
      keyframes.push({ atMs: holdEndMs, centerX, centerY, zoom });
    }
  }
  keyframes.push({ atMs: sceneDurationMs, centerX: 4, centerY: 4, zoom: 1 });

  return { keyframes };
}

/**
 * Phase 18E-B — the explicit invariant Phase 18A's own move filtering
 * (consideredMoves, below) already implies but never stated for
 * DIRECTIVES: no CameraDirective/TacticalAnnotationDirective/
 * TrackingDirective may meaningfully extend beyond the selected clip
 * window. Before this, a directive's own atPly/untilPly (or fromPly/toPly)
 * were computed straight from StoryPlan's beats/consequenceChain — entirely
 * unaware that clipWindow.ts's own endPly (payoff-anchored) can fall EARLIER
 * than a beat's own last ply (consequent-anchored); see the Phase 18
 * integration review's game_07 finding. A directive whose range partially
 * overlaps the window is truncated to the overlapping portion — its
 * squares/zoom/subject/evidenceRef are left exactly as derived, since they
 * describe real, already-verified geometry regardless of which of its
 * plies end up shown; only the PLY RANGE it may be shown for is clamped. A
 * directive with no overlap at all is dropped entirely. Enforced here, at
 * the lowering boundary, rather than left to whatever fallback formula in
 * buildCameraPlan/buildTacticalBeats happens to absorb an out-of-range ply
 * — the same principle Phase 18A already applies to moves, now applied to
 * directives too.
 */
function clampCameraDirectivesToWindow(directives: readonly CameraDirective[], startPly: number, endPly: number): readonly CameraDirective[] {
  const out: CameraDirective[] = [];
  for (const d of directives) {
    const atPly = Math.max(d.atPly, startPly);
    const untilPly = Math.min(d.untilPly, endPly);
    if (atPly > untilPly) continue;
    out.push(atPly === d.atPly && untilPly === d.untilPly ? d : { ...d, atPly, untilPly });
  }
  return out;
}

/** Same clamp as clampCameraDirectivesToWindow, for the fromPly/toPly shape TacticalAnnotationDirective and TrackingDirective both share. */
function clampSpanDirectivesToWindow<T extends { fromPly: number; toPly: number }>(directives: readonly T[], startPly: number, endPly: number): readonly T[] {
  const out: T[] = [];
  for (const d of directives) {
    const fromPly = Math.max(d.fromPly, startPly);
    const toPly = Math.min(d.toPly, endPly);
    if (fromPly > toPly) continue;
    out.push(fromPly === d.fromPly && toPly === d.toPly ? d : { ...d, fromPly, toPly });
  }
  return out;
}

export function lowerToTimeline(game: GameRecord, plan: CinematicPlan, story: StoryPlan): Timeline {
  const startPosition = game.positions[0];
  if (!startPosition) {
    throw new Error('lowerToTimeline: GameRecord has no starting position');
  }

  if (game.moves.length === 0) {
    const scene: Scene = {
      id: SCENE_ID,
      startPositionFen: startPosition.fen,
      startPly: 0,
      beats: [],
      cameraPlan: { keyframes: [BASE_CAMERA_KEYFRAME] },
      durationMs: 0
    };
    return { scenes: [scene] };
  }

  // Phase 18A — Cinematic Clip Windowing. A 'windowed' ClipWindow restricts
  // which of the game's already-played moves this Scene covers, derived
  // purely from StoryPlan's own evidence (see clipWindow.ts). 'abstained'
  // (no central conflict) preserves this function's pre-Phase-18A behavior
  // exactly: every move considered, scene starting at game.positions[0].
  const clipWindow = deriveClipWindow(story, plan.settings);
  const consideredMoves = clipWindow.kind === 'windowed' ? game.moves.filter((m) => m.ply >= clipWindow.startPly && m.ply <= clipWindow.endPly) : game.moves;
  const scenePositionIndex = clipWindow.kind === 'windowed' ? clipWindow.startPly - 1 : 0;
  const scenePosition = game.positions[scenePositionIndex] ?? startPosition;

  // Phase 18E-B — camera/tactical/tracking directives clamped to the SAME
  // window consideredMoves already enforces for moves. A no-op for Full
  // Game ('abstained': every directive already references real, in-window
  // plies by construction there) and a no-op for every directive that
  // already fits — see clampCameraDirectivesToWindow/
  // clampSpanDirectivesToWindow's own doc comment. The pre-existing
  // AnnotationDirective channel (Phase 2.4/16) is untouched: its own
  // buildAnnotationBeats already has a safe-omission check (drops a
  // directive outright when its ply is out of window) and is out of this
  // batch's scope.
  const cameraDirectives =
    clipWindow.kind === 'windowed' ? clampCameraDirectivesToWindow(plan.cameraDirectives, clipWindow.startPly, clipWindow.endPly) : plan.cameraDirectives;
  const tacticalDirectives =
    clipWindow.kind === 'windowed' ? clampSpanDirectivesToWindow(plan.tacticalDirectives, clipWindow.startPly, clipWindow.endPly) : plan.tacticalDirectives;
  const trackingDirectives =
    clipWindow.kind === 'windowed' ? clampSpanDirectivesToWindow(plan.trackingDirectives, clipWindow.startPly, clipWindow.endPly) : plan.trackingDirectives;

  const { beats: moveBeats, plyAtMs, plyDurationMs, totalMs } = buildMoveBeats(consideredMoves, plan);
  const annotationBeats = buildAnnotationBeats(plan.annotationDirectives, plyAtMs, plyDurationMs);
  const tacticalBeats = buildTacticalBeats(tacticalDirectives, plyAtMs, plyDurationMs);
  // Phase 13B — the terminal ply is the game's own last move (a
  // checkmate/stalemate delivery is definitionally the last move ever
  // played). Phase 18A — once windowed, that move may fall outside this
  // Scene entirely, so the terminal camera treatment may only fire when the
  // WINDOW's own last move (never game.moves' raw last index) IS that same
  // real last move — otherwise a truncated or payoff-short window would
  // wrongly re-engage the terminal camera on a move that isn't actually the
  // game's terminal result. See lowerToTimeline.test.ts's dedicated
  // regression test.
  const gameLastMove = game.moves[game.moves.length - 1];
  const windowLastMove = consideredMoves[consideredMoves.length - 1];
  const windowReachesGameEnd = windowLastMove !== undefined && gameLastMove !== undefined && windowLastMove.ply === gameLastMove.ply;
  const terminalPlyAtMs = plan.finalPositionIsTerminal && windowReachesGameEnd && windowLastMove ? (plyAtMs.get(windowLastMove.ply) ?? null) : null;
  const cameraPlan = buildCameraPlan(
    cameraDirectives,
    plyAtMs,
    plyDurationMs,
    totalMs,
    plan.settings.preClimaxRampMs,
    terminalPlyAtMs,
    trackingDirectives,
    game,
    plan.settings,
    tacticalDirectives
  );

  const scene: Scene = {
    id: SCENE_ID,
    startPositionFen: scenePosition.fen,
    startPly: scenePositionIndex,
    beats: [...moveBeats, ...annotationBeats, ...tacticalBeats],
    cameraPlan,
    durationMs: totalMs
  };

  return { scenes: [scene] };
}
