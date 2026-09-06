import type { GameAnalysis } from '../analysis/types';
import type { GameRecord } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import type { StoryBeat, StoryPlan } from '../story/types';
import { boundsOfSquares } from '../render/coords';
import { cameraRoleFor, deriveBeatVisualRegion, regionsEqual, unionRegions, type VisualRegion, type VisualRelevanceContext } from './visualRelevance';
import type { CameraDirective, CameraRole, DirectorSettings } from './types';

/**
 * Phase 18B — geometry-driven, per-beat camera framing.
 *
 * Replaces the old single-climax-only, fixed-zoom camera rule with one
 * directive per meaningful camera event: an "establish" shot over
 * setup/building-sequence, a "critical" push-in over the climax, a
 * "consequence" follow/reframe, and a "payoff" frame over the resolution —
 * each only when the corresponding StoryBeat actually exists, and adjacent
 * beats/groups that resolve to the SAME region are merged into one event
 * rather than forced into separate camera moves (Part 6/9 of the Phase 18B
 * spec's "do not force camera movement if the region is unchanged").
 *
 * This module decides WHICH region and HOW MUCH zoom; visualRelevance.ts
 * decides WHAT is relevant; lowerToTimeline.ts converts these directives
 * into timed keyframes. See each module's own doc comment.
 */

const BOARD_UNITS = 8;

/** Every square a region names as relevant, deduped — used for both zoom here and (at lowering time) center. */
function squaresOf(region: VisualRegion): readonly string[] {
  return [...new Set([...region.primarySquares, ...region.secondarySquares])];
}

/**
 * Deterministic zoom from a region's own bounding box: tighter for a small
 * region, wider for a large one, and never tighter than "every relevant
 * square plus minVisibleContextSquares of padding on each side" fits the
 * frame. A region too large to fit even at zoom 1 widens toward full-board
 * rather than cropping (Math.max(1, ...) below) — it is never allowed to
 * cut a verified-relevant square out of frame.
 */
export function zoomForSquares(squares: readonly string[], settings: DirectorSettings): number {
  const bounds = boundsOfSquares(squares);
  if (!bounds) return 1;
  const span = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const visibleUnits = span + 2 * settings.minVisibleContextSquares;
  const raw = BOARD_UNITS / visibleUnits;
  return Math.min(settings.maxZoom, Math.max(1, raw));
}

interface BeatGroup {
  readonly role: CameraRole;
  readonly beats: readonly StoryBeat[];
}

/** Adjacent StoryBeats sharing the same camera role become one group — see cameraRoleFor. story.beats is already ascending by role/ply (beats.ts). */
function groupBeatsByCameraRole(beats: readonly StoryBeat[]): readonly BeatGroup[] {
  const groups: BeatGroup[] = [];
  for (const beat of beats) {
    const role = cameraRoleFor(beat.role);
    const last = groups[groups.length - 1];
    if (last && last.role === role) {
      groups[groups.length - 1] = { role, beats: [...last.beats, beat] };
    } else {
      groups.push({ role, beats: [beat] });
    }
  }
  return groups;
}

function plyRangeOf(beats: readonly StoryBeat[]): { atPly: number; untilPly: number } {
  const plies = beats.flatMap((b) => b.plies);
  return { atPly: Math.min(...plies), untilPly: Math.max(...plies) };
}

function regionForGroup(group: BeatGroup, ctx: VisualRelevanceContext): VisualRegion {
  return unionRegions(group.beats.map((beat) => deriveBeatVisualRegion(beat, ctx)));
}

interface PendingDirective {
  readonly atPly: number;
  untilPly: number;
  readonly role: CameraRole;
  region: VisualRegion;
  readonly evidenceBeatId: string;
}

function toDirective(pending: PendingDirective, settings: DirectorSettings): CameraDirective {
  const squares = squaresOf(pending.region);
  return {
    atPly: pending.atPly,
    untilPly: pending.untilPly,
    role: pending.role,
    zoom: zoomForSquares(squares, settings),
    squares,
    evidenceRef: { kind: 'beat', id: pending.evidenceBeatId }
  };
}

export function deriveCameraDirectives(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  story: StoryPlan,
  settings: DirectorSettings
): readonly CameraDirective[] {
  if (!story.centralConflict || story.beats.length === 0) return [];

  const ctx: VisualRelevanceContext = { game, analysis, understanding, story };
  const groups = groupBeatsByCameraRole(story.beats);

  const directives: CameraDirective[] = [];
  let pending: PendingDirective | null = null;

  for (const group of groups) {
    const region = regionForGroup(group, ctx);
    if (squaresOf(region).length === 0) continue;

    const { atPly, untilPly } = plyRangeOf(group.beats);

    // Two events are folded into one whenever EITHER holds (Part 6/9):
    //   - their ply ranges touch/overlap — StoryBeat roles can legitimately
    //     share a ply (e.g. the climax IS the resolution when the game ends
    //     on that very move — beats.ts), and two directives can never be
    //     sequenced in time when they cover the same ply anyway; or
    //   - the region is unchanged, so forcing a new camera event would be
    //     pure motion for no reason.
    // The FIRST group's own role/evidence wins a merge — establish stays
    // establish, and a climax that doubles as the payoff stays 'critical'
    // so the pre-climax ramp still engages it.
    if (pending && (atPly <= pending.untilPly || regionsEqual(pending.region, region))) {
      pending.untilPly = Math.max(pending.untilPly, untilPly);
      pending.region = unionRegions([pending.region, region]);
      continue;
    }

    if (pending) directives.push(toDirective(pending, settings));
    pending = { atPly, untilPly, role: group.role, region, evidenceBeatId: group.beats[0]!.id };
  }
  if (pending) directives.push(toDirective(pending, settings));

  return directives;
}
