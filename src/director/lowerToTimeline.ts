import type { GameRecord } from '../pgn/types';
import type { StoryArchetype } from '../story/types';
import type { Annotation, AnnotationBeat, CameraKeyframe, CameraPlan, MoveBeat, Scene, Timeline } from '../timeline/types';
import { squareCenter } from '../render/coords';
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
  game: GameRecord,
  plan: CinematicPlan
): { beats: MoveBeat[]; plyAtMs: Map<number, number>; plyDurationMs: Map<number, number>; totalMs: number } {
  const treatmentByPly = new Map(plan.moveTreatmentPlan.map((t) => [t.ply, t]));
  const pauseByPly = new Map(plan.transitionDirectives.map((t) => [t.beforePly, t.pauseMs]));

  const beats: MoveBeat[] = [];
  const plyAtMs = new Map<number, number>();
  const plyDurationMs = new Map<number, number>();
  let cursorMs = 0;

  for (const move of game.moves) {
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
  'stalemate-swindle': '#f4a300'
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
 * Phase 13A design report's derivation: for climaxZoom = 1.8, ~93ms is the
 * analytical floor for that freeze query to already land within 1e-6 of
 * zoom = 1; 200ms keeps a comfortable margin.
 *
 * TERMINAL_ZOOM_IN_MS is the short window immediately before the terminal
 * ply in which the camera re-approaches climaxZoom, mirroring
 * preClimaxRampMs's own "short, fixed window" shape at a smaller scale
 * appropriate to a single move rather than an entire pre-climax buildup.
 */
export const TERMINAL_ZOOM_OUT_MS = 200;
export const TERMINAL_ZOOM_IN_MS = 400;

export function buildCameraPlan(
  directives: readonly CameraDirective[],
  plyAtMs: ReadonlyMap<number, number>,
  plyDurationMs: ReadonlyMap<number, number>,
  sceneDurationMs: number,
  climaxZoom: number,
  preClimaxRampMs: number,
  /**
   * Phase 13B — the actual logical time the game's own terminal ply (the
   * literal checkmate/stalemate-delivering move) begins, or null when the
   * game does not end in a genuine terminal result. Resolved by
   * lowerToTimeline() from the game's own last move — never threaded
   * through director/camera.ts, which stays anchored only on the climax
   * StoryBeat, unchanged, per the Phase 13A design report.
   */
  terminalPlyAtMs: number | null
): CameraPlan {
  if (directives.length === 0) {
    return { keyframes: [BASE_CAMERA_KEYFRAME] };
  }

  const keyframes: CameraKeyframe[] = [BASE_CAMERA_KEYFRAME];
  for (const directive of directives) {
    const atMs = plyAtMs.get(directive.atPly);
    if (atMs === undefined) continue;
    const durationMs = plyDurationMs.get(directive.atPly) ?? 0;

    const centers = directive.squares.map((sq) => squareCenter(sq, false));
    const centerX = centers.reduce((sum, c) => sum + c.x, 0) / centers.length;
    const centerY = centers.reduce((sum, c) => sum + c.y, 0) / centers.length;

    // Phase 12B — hold at the base full-board framing until shortly before
    // the climax, so easeOutCubic's own eased ramp (render/resolveCamera.ts,
    // unchanged) is compressed into a short, fixed window immediately
    // preceding the climax rather than spread across the entire pre-climax
    // portion of the video. Omitted entirely (rampStartMs <= 0) whenever the
    // climax happens sooner than preClimaxRampMs into the video — the ramp
    // then simply uses however much time is already available between the
    // base keyframe and the climax keyframe, identical to pre-Phase-12B
    // behavior for every such game (e.g. Scholar's Mate).
    const rampStartMs = Math.max(0, atMs - preClimaxRampMs);
    if (rampStartMs > 0) {
      keyframes.push({ atMs: rampStartMs, centerX: 4, centerY: 4, zoom: 1 });
    }

    // Zoom in, then hold at the same values through this ply's own dwell
    // time — two identical-value keyframes at different atMs create a
    // genuine hold under resolveCamera.ts's own interpolation (unchanged).
    keyframes.push({ atMs, centerX, centerY, zoom: climaxZoom });
    const naturalHoldEndMs = atMs + durationMs;

    // Phase 13B — the story-layer climax is deliberately anchored on the
    // turning point that makes the outcome inevitable (e.g. the blunder
    // before a forced mate), not the later move that mechanically delivers
    // it (see the Phase 13 investigation and story.spec.ts's own
    // documented reasoning) — that selection is intentionally left
    // unchanged. What follows only adjusts how long the camera stays
    // engaged, so the actual terminal move itself also reads as visually
    // decisive rather than playing out after the camera has already
    // reset.
    if (terminalPlyAtMs !== null && terminalPlyAtMs > naturalHoldEndMs) {
      // Gap case (Evergreen/Stalemate-shaped): the terminal move happens
      // well after the climax hold's own natural end, with genuinely
      // distinct consequence moves in between (e.g. Evergreen's Qxd7+,
      // Kxd7, Bf5+, Ke8, Bd7+, Kf8) that should stay at full-board framing
      // rather than sit inside an unnaturally long zoomed hold. The
      // existing climax hold-end is left exactly as it was; a short,
      // separate re-engagement episode is appended, timed on the terminal
      // ply itself: reset to full board, re-approach climaxZoom in the
      // final TERMINAL_ZOOM_IN_MS before the terminal move begins, hold
      // through most of it, then leave TERMINAL_ZOOM_OUT_MS of reset room
      // before sceneDurationMs. Every new keyframe here is guarded with
      // Math.max/a strict-inequality skip so a small or zero gap between
      // the climax hold and the terminal move (not seen in any canonical
      // game today, but not assumed impossible for a future one) never
      // produces a duplicate or out-of-order timestamp — see the Phase 13A
      // design report's own Scholar's Mate keyframe-safety analysis.
      keyframes.push({ atMs: naturalHoldEndMs, centerX, centerY, zoom: climaxZoom });

      const reengageStartMs = terminalPlyAtMs - TERMINAL_ZOOM_IN_MS;
      if (reengageStartMs > naturalHoldEndMs) {
        keyframes.push({ atMs: reengageStartMs, centerX, centerY, zoom: 1 });
      }

      keyframes.push({ atMs: terminalPlyAtMs, centerX, centerY, zoom: climaxZoom });

      const proposedHoldEndMs = sceneDurationMs - TERMINAL_ZOOM_OUT_MS;
      const holdEndMs = proposedHoldEndMs > terminalPlyAtMs ? proposedHoldEndMs : terminalPlyAtMs;
      if (holdEndMs > terminalPlyAtMs) {
        keyframes.push({ atMs: holdEndMs, centerX, centerY, zoom: climaxZoom });
      }
    } else if (terminalPlyAtMs !== null) {
      // Zero/negative-gap case (Scholar's-Mate-shaped): the terminal move
      // already begins at or before the climax hold's own natural end, so
      // there is no separate episode to insert — simply extend the SAME
      // hold-end keyframe far enough to leave TERMINAL_ZOOM_OUT_MS of
      // reset room before sceneDurationMs. Guarded to fall back to the
      // unextended natural hold-end whenever extending would reach or
      // exceed sceneDurationMs itself (the degenerate case where the
      // climax ply IS the game's own terminal ply, already a pre-existing,
      // untouched edge case in buildCameraPlan's final unconditional reset
      // push — this guard only avoids making that pre-existing case worse,
      // it does not newly fix it).
      const proposedHoldEndMs = naturalHoldEndMs > sceneDurationMs - TERMINAL_ZOOM_OUT_MS ? naturalHoldEndMs : sceneDurationMs - TERMINAL_ZOOM_OUT_MS;
      const holdEndMs = proposedHoldEndMs < sceneDurationMs ? proposedHoldEndMs : naturalHoldEndMs;
      keyframes.push({ atMs: holdEndMs, centerX, centerY, zoom: climaxZoom });
    } else {
      keyframes.push({ atMs: naturalHoldEndMs, centerX, centerY, zoom: climaxZoom });
    }
  }
  keyframes.push({ atMs: sceneDurationMs, centerX: 4, centerY: 4, zoom: 1 });

  return { keyframes };
}

export function lowerToTimeline(game: GameRecord, plan: CinematicPlan): Timeline {
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

  const { beats: moveBeats, plyAtMs, plyDurationMs, totalMs } = buildMoveBeats(game, plan);
  const annotationBeats = buildAnnotationBeats(plan.annotationDirectives, plyAtMs, plyDurationMs);
  // Phase 13B — the terminal ply is always the game's own last move (a
  // checkmate/stalemate delivery is definitionally the last move ever
  // played), so its own atMs is already available from the plyAtMs map
  // this function just built — no new GameAnalysis dependency, and no new
  // per-ply field on CinematicPlan, is needed beyond the one
  // finalPositionIsTerminal boolean. See the Phase 13A design report.
  const lastMove = game.moves[game.moves.length - 1];
  const terminalPlyAtMs = plan.finalPositionIsTerminal && lastMove ? (plyAtMs.get(lastMove.ply) ?? null) : null;
  const cameraPlan = buildCameraPlan(
    plan.cameraDirectives,
    plyAtMs,
    plyDurationMs,
    totalMs,
    plan.settings.climaxZoom,
    plan.settings.preClimaxRampMs,
    terminalPlyAtMs
  );

  const scene: Scene = {
    id: SCENE_ID,
    startPositionFen: startPosition.fen,
    startPly: 0,
    beats: [...moveBeats, ...annotationBeats],
    cameraPlan,
    durationMs: totalMs
  };

  return { scenes: [scene] };
}
