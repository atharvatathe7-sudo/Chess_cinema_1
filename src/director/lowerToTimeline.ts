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

function buildCameraPlan(
  directives: readonly CameraDirective[],
  plyAtMs: ReadonlyMap<number, number>,
  plyDurationMs: ReadonlyMap<number, number>,
  sceneDurationMs: number,
  climaxZoom: number
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

    // Zoom in, then hold at the same values through this ply's own dwell
    // time — two identical-value keyframes at different atMs create a
    // genuine hold under resolveCamera.ts's own interpolation (unchanged).
    keyframes.push({ atMs, centerX, centerY, zoom: climaxZoom });
    keyframes.push({ atMs: atMs + durationMs, centerX, centerY, zoom: climaxZoom });
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
  const cameraPlan = buildCameraPlan(plan.cameraDirectives, plyAtMs, plyDurationMs, totalMs, plan.settings.climaxZoom);

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
