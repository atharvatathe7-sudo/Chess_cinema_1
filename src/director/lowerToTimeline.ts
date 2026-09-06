import type { GameRecord, MoveRecord } from '../pgn/types';
import type { StoryArchetype, StoryPlan } from '../story/types';
import type { Annotation, AnnotationBeat, CameraKeyframe, CameraPlan, MoveBeat, Scene, Timeline } from '../timeline/types';
import { boundsOfSquares } from '../render/coords';
import { deriveClipWindow } from './clipWindow';
import type { AnnotationDirective, AnnotationDirectiveKind, CameraDirective, CinematicPlan } from './types';

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
  terminalPlyAtMs: number | null
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

    const { centerX, centerY } = centerOfSquares(directive.squares);
    const zoom = directive.zoom;

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
    keyframes.push({ atMs, centerX, centerY, zoom });

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

  const { beats: moveBeats, plyAtMs, plyDurationMs, totalMs } = buildMoveBeats(consideredMoves, plan);
  const annotationBeats = buildAnnotationBeats(plan.annotationDirectives, plyAtMs, plyDurationMs);
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
  const cameraPlan = buildCameraPlan(plan.cameraDirectives, plyAtMs, plyDurationMs, totalMs, plan.settings.preClimaxRampMs, terminalPlyAtMs);

  const scene: Scene = {
    id: SCENE_ID,
    startPositionFen: scenePosition.fen,
    startPly: scenePositionIndex,
    beats: [...moveBeats, ...annotationBeats],
    cameraPlan,
    durationMs: totalMs
  };

  return { scenes: [scene] };
}
