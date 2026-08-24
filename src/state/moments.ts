import type { GameAnalysis } from '../analysis/types';
import type { AnnotationDirective, AnnotationDirectiveKind, CinematicPlan } from '../director/types';
import type { StoryArchetype, StoryPlan } from '../story/types';
import type { CauseConsequenceRecord, GameUnderstanding, TacticalMotif, ThreatRecord } from '../understanding/types';
import type { Timeline } from '../timeline/types';
import type { AppState } from './AppState';
import { seekTo, setPlaying } from './actions';
import type { Store } from './store';

/**
 * Phase 2.6 — Cinematic Moments navigation. Purely derived: every value a
 * CinematicMoment carries already exists on direction.result.cinematicPlan
 * (semantic identity/kind/evidence) and game.timeline (the actual, already-
 * lowered atMs/untilMs timing) — nothing here is a second timing model or a
 * new fact. Nothing here is stored in AppState; moments are recomputed on
 * demand from state already present, exactly like renderAnalysis/
 * renderDirection already recompute their own display from state on every
 * store notification.
 *
 * See the Phase 2.6 specification: the root cause this fixes is that
 * timeline/navigation.ts's goToNextMove/goToPreviousMove only ever look at
 * MoveBeats, and once the last move is reached, its own fallback lands
 * exactly on scene.durationMs — the exact exclusive edge where the final
 * move's own annotations (render/drawAnnotations.ts: `logicalTimeMs >=
 * beat.untilMs` excludes) have just switched off. This module does not
 * change that existing move-boundary behavior at all — it adds a second,
 * independent way to reach a point that is *provably* inside an
 * annotation's active window.
 */

/**
 * last-move is deliberately excluded: director/annotations.ts fires it for
 * every single played ply, so it is the baseline visual treatment, not an
 * editorially meaningful moment.
 */
const MOMENT_KINDS: ReadonlySet<AnnotationDirectiveKind> = new Set([
  'threat-refutation-arrow',
  'central-conflict-highlight',
  'archetype-track',
  'terminal-result-highlight'
]);

/**
 * Mirrors director/annotations.ts's own (unexported) KIND_ORDER constant
 * exactly. That file is out of scope for Phase 2.6 (protected directory),
 * so the same fixed priority order is restated here rather than imported —
 * this is the one already-established priority system in the codebase,
 * reused rather than reinvented, per the Phase 2.6 specification.
 */
const KIND_PRIORITY: Readonly<Record<AnnotationDirectiveKind, number>> = {
  'last-move': 0,
  'threat-refutation-arrow': 1,
  'central-conflict-highlight': 2,
  'archetype-track': 3,
  'terminal-result-highlight': 4
};

const ARCHETYPE_LABEL: Readonly<Record<StoryArchetype, string>> = {
  'king-hunt': 'King Hunt',
  'pawn-journey': 'Pawn Journey',
  'stalemate-swindle': 'Stalemate Swindle',
  'forced-trap': 'Forced Trap'
};

export interface CinematicMoment {
  readonly id: string;
  readonly kind: AnnotationDirectiveKind;
  readonly label: string;
  /**
   * Phase 2.7 — a short, deterministic, closed-vocabulary explanation of
   * why this moment matters, built only from already-verified structured
   * facts (ThreatRecord.kind, CauseConsequenceRecord.mechanism/resolution,
   * StoryArchetype, GameAnalysis terminal result/drawReason) — never free
   * prose, never an invented chess interpretation. See reasonFor below.
   */
  readonly reason: string;
  /** Inclusive, same convention as AnnotationDirective. */
  readonly fromPly: number;
  readonly toPly: number;
  readonly atMs: number;
  /** Exclusive, same convention as AnnotationBeat/drawAnnotations.ts. */
  readonly untilMs: number;
  /** Guaranteed atMs <= targetTimeMs < untilMs — see deriveCinematicMoments. */
  readonly targetTimeMs: number;
}

/** The one fallback used whenever an explanatory lookup can't be resolved — never a crash, never an invented claim. */
const FALLBACK_REASON = 'A key moment identified by the game analysis.';

/**
 * central-conflict-highlight is only ever produced from the StoryPlan's own
 * climax beat (director/annotations.ts's centralConflictDirectives finds
 * `story.beats.find(b => b.role === 'climax')` and returns nothing
 * otherwise) — "Climax" is therefore a direct, source-grounded label, not a
 * guess, and needs no StoryBeat lookup of its own.
 */
function labelFor(directive: AnnotationDirective, analysis: GameAnalysis): string {
  switch (directive.kind) {
    case 'threat-refutation-arrow':
      return 'Threat Refutation';
    case 'central-conflict-highlight':
      return 'Climax';
    case 'archetype-track':
      return directive.evidenceRef.kind === 'archetypeSignal' ? ARCHETYPE_LABEL[directive.evidenceRef.archetype] : 'Key Moment';
    case 'terminal-result-highlight':
      return terminalLabel(analysis);
    case 'last-move':
      return 'Move';
  }
}

/**
 * Only GameAnalysis carries the result/drawReason distinction (director/
 * annotations.ts's own terminalResultDirectives reads exactly this same
 * field) — GameUnderstanding's TurningPointKind has no dedicated
 * stalemate/draw case, so a safe "Checkmate"/"Stalemate" label needs
 * GameAnalysis specifically. It is already-existing, already-required
 * state (direction cannot run without a completed analysis), not a new
 * fact and not new AppState.
 */
function terminalLabel(analysis: GameAnalysis): string {
  const finalPly = analysis.plies[analysis.plies.length - 1];
  const ev = finalPly?.evaluationAfter;
  if (!ev || ev.kind !== 'terminal') return 'Terminal';
  if (ev.result === 'draw') return ev.drawReason === 'stalemate' ? 'Stalemate' : 'Draw';
  return 'Checkmate';
}

const THREAT_REASON: Readonly<Record<ThreatRecord['kind'], string>> = {
  'mate-threat': 'A threatened mate was refuted here.',
  'check-threat': 'A threatened check was refuted here.',
  'material-winning-threat': 'A threat to win material was refuted here.',
  'positional-restriction-threat': "A trapped piece's threat was refuted here."
};

const ARCHETYPE_REASON: Readonly<Record<StoryArchetype, string>> = {
  'king-hunt': 'A forced sequence of checks drove the king across the board, ending in mate.',
  'pawn-journey': 'A pawn advanced across the board before promoting.',
  'stalemate-swindle': 'The side that was behind on material escaped with a stalemate.',
  'forced-trap': 'A sacrifice forced a decisive sequence.'
};

const MECHANISM_PHRASE: Readonly<Record<TacticalMotif | 'king-safety' | 'positional', string>> = {
  fork: 'a fork',
  pin: 'a pin',
  skewer: 'a skewer',
  discovery: 'a discovered attack',
  battery: 'a battery',
  deflection: 'a deflection',
  overload: 'an overload',
  'king-safety': 'a king-safety issue',
  positional: 'a positional shift'
};

const RESOLUTION_PHRASE: Readonly<Record<CauseConsequenceRecord['resolution'], string>> = {
  'decisive-advantage': 'a decisive advantage',
  'material-gain': 'a material gain',
  'forced-mate': 'a forced mate',
  repelled: 'the threat being repelled',
  unresolved: 'an unresolved position',
  drawn: 'a draw'
};

/**
 * threat-refutation-arrow's own evidenceRef only points at its owning
 * StoryBeat (director/annotations.ts's threatRefutationDirectives), not at
 * the ThreatRecord itself — but fromPly === toPly === threat.refutedBy.ply
 * by construction, so the specific threat is recovered by that value
 * instead, exactly as reliably as a direct id reference would be.
 */
function threatRefutationReason(directive: AnnotationDirective, understanding: GameUnderstanding): string {
  const threat = understanding.threats.find((t) => t.refutedBy?.ply === directive.fromPly);
  if (!threat) return FALLBACK_REASON;
  return THREAT_REASON[threat.kind];
}

/**
 * central-conflict-highlight is only ever produced from the StoryPlan's
 * own climax beat, and story/beats.ts always populates a climax beat's
 * evidenceRefs.turningPointId — so this lookup is expected to resolve for
 * every real central-conflict-highlight, but the fallback below is kept
 * for defense-in-depth rather than assumed to be unreachable.
 */
function centralConflictReason(directive: AnnotationDirective, story: StoryPlan, understanding: GameUnderstanding): string {
  if (directive.evidenceRef.kind !== 'beat') return 'The decisive moment of the game.';
  const beatId = directive.evidenceRef.id;
  const beat = story.beats.find((b) => b.id === beatId);
  const turningPointId = beat?.evidenceRefs.turningPointId;
  const turningPoint = turningPointId ? understanding.turningPoints.find((tp) => tp.id === turningPointId) : undefined;
  if (!turningPoint) return 'The decisive moment of the game.';

  const resolution = RESOLUTION_PHRASE[turningPoint.causeConsequence.resolution];
  const mechanism = turningPoint.causeConsequence.mechanism;
  if (mechanism === null) return `The decisive moment of the game, leading to ${resolution}.`;
  return `The decisive moment — ${MECHANISM_PHRASE[mechanism]} led to ${resolution}.`;
}

function archetypeReason(directive: AnnotationDirective): string {
  return directive.evidenceRef.kind === 'archetypeSignal' ? ARCHETYPE_REASON[directive.evidenceRef.archetype] : FALLBACK_REASON;
}

function terminalReason(analysis: GameAnalysis): string {
  const finalPly = analysis.plies[analysis.plies.length - 1];
  const ev = finalPly?.evaluationAfter;
  if (!ev || ev.kind !== 'terminal') return FALLBACK_REASON;
  if (ev.result === 'draw') {
    return ev.drawReason === 'stalemate' ? 'The game ended in a stalemate — a draw by no legal moves.' : 'The game ended in a draw.';
  }
  return 'The game ended in checkmate.';
}

function reasonFor(directive: AnnotationDirective, understanding: GameUnderstanding, story: StoryPlan, analysis: GameAnalysis): string {
  switch (directive.kind) {
    case 'threat-refutation-arrow':
      return threatRefutationReason(directive, understanding);
    case 'central-conflict-highlight':
      return centralConflictReason(directive, story, understanding);
    case 'archetype-track':
      return archetypeReason(directive);
    case 'terminal-result-highlight':
      return terminalReason(analysis);
    case 'last-move':
      return FALLBACK_REASON;
  }
}

/**
 * ply -> {atMs, durationMs}, read directly off the already-lowered
 * Timeline's own MoveBeats (via resultingPly) — the exact values
 * director/lowerToTimeline.ts itself used to build every AnnotationBeat's
 * atMs/untilMs, just reached through the Timeline's already-exposed shape
 * instead of director's internal (and discarded) plyAtMs/plyDurationMs
 * maps. This is "the lowered Timeline['s] ... timing", not a second timing
 * model: no pacing/multiplier math is redone here.
 */
function buildPlyTimingMap(timeline: Timeline): ReadonlyMap<number, { atMs: number; durationMs: number }> {
  const scene = timeline.scenes[0];
  const map = new Map<number, { atMs: number; durationMs: number }>();
  if (!scene) return map;
  for (const beat of scene.beats) {
    if (beat.kind === 'move') {
      map.set(beat.resultingPly, { atMs: beat.atMs, durationMs: beat.durationMs });
    }
  }
  return map;
}

/**
 * Pure: (CinematicPlan, Timeline, GameAnalysis, GameUnderstanding, StoryPlan)
 * -> CinematicMoment[], ascending by atMs (tie-broken by fromPly), deterministic and
 * byte-identical for identical input. Directives whose ply ranges overlap
 * (share at least one ply) are merged into a single moment, spanning their
 * union and labeled by the highest-KIND_PRIORITY directive among them —
 * see the Phase 2.6 specification section H for why interval-overlap
 * (rather than shared StoryBeat id) is the merge key: it makes no
 * assumption about whether a terminal-result-highlight (which has no
 * owning StoryBeat) happens to fall inside the same beat as a
 * central-conflict-highlight.
 *
 * Every moment's targetTimeMs is untilMs - 1: durationMs is always an
 * integer count of milliseconds (director/lowerToTimeline.ts rounds it),
 * so whenever untilMs > atMs, untilMs - 1 >= atMs always holds — the
 * atMs <= targetTimeMs < untilMs invariant is therefore guaranteed by
 * construction, not merely by convention. A directive landing on a
 * zero-duration (pruned) ply, where untilMs === atMs, has a genuinely
 * empty active window (render/drawAnnotations.ts could never show it at
 * any timestamp) — that moment is safely omitted rather than emitting a
 * broken timestamp. The same safe-omission applies if a directive's ply
 * has no corresponding MoveBeat at all (an internal inconsistency that
 * should never occur for a validly-lowered Timeline, but is not assumed).
 */
export function deriveCinematicMoments(
  cinematicPlan: CinematicPlan,
  timeline: Timeline,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  story: StoryPlan
): readonly CinematicMoment[] {
  const worthy = cinematicPlan.annotationDirectives.filter((d) => MOMENT_KINDS.has(d.kind));
  if (worthy.length === 0) return [];

  const sorted = [...worthy].sort((a, b) => a.fromPly - b.fromPly || a.toPly - b.toPly);

  const groups: AnnotationDirective[][] = [];
  for (const directive of sorted) {
    const currentGroup = groups[groups.length - 1];
    const groupMaxToPly = currentGroup ? Math.max(...currentGroup.map((d) => d.toPly)) : -Infinity;
    if (currentGroup && directive.fromPly <= groupMaxToPly) {
      currentGroup.push(directive);
    } else {
      groups.push([directive]);
    }
  }

  const timing = buildPlyTimingMap(timeline);
  const moments: CinematicMoment[] = [];

  for (const group of groups) {
    const fromPly = Math.min(...group.map((d) => d.fromPly));
    const toPly = Math.max(...group.map((d) => d.toPly));
    const start = timing.get(fromPly);
    const end = timing.get(toPly);
    if (!start || !end) continue;

    const atMs = start.atMs;
    const untilMs = end.atMs + end.durationMs;
    if (untilMs <= atMs) continue;

    const primary = group.reduce((best, d) => (KIND_PRIORITY[d.kind] > KIND_PRIORITY[best.kind] ? d : best));

    moments.push({
      id: `${primary.kind}-${fromPly}-${toPly}`,
      kind: primary.kind,
      label: labelFor(primary, analysis),
      reason: reasonFor(primary, understanding, story, analysis),
      fromPly,
      toPly,
      atMs,
      untilMs,
      targetTimeMs: untilMs - 1
    });
  }

  return moments.sort((a, b) => a.atMs - b.atMs || a.fromPly - b.fromPly);
}

/**
 * Seeks to the first moment strictly after the current playhead, via the
 * existing seekTo — the same single writer of playback.logicalTimeMs every
 * other navigation action already uses. A no-op (does not call seekTo at
 * all) once already at or past the last moment, so repeated clicks can
 * never escape the final moment or land anywhere unexpected. Pauses first,
 * mirroring goToNextMove/goToPreviousMove/restart's own convention in
 * state/actions.ts (unmodified — this only calls its exports).
 */
export function goToNextMoment(store: Store<AppState>, moments: readonly CinematicMoment[]): void {
  const current = store.getState().playback.logicalTimeMs;
  const next = moments.find((m) => m.targetTimeMs > current);
  if (!next) return;
  setPlaying(store, false);
  seekTo(store, next.targetTimeMs);
}

/** Symmetric with goToNextMoment — see its own comment. */
export function goToPreviousMoment(store: Store<AppState>, moments: readonly CinematicMoment[]): void {
  const current = store.getState().playback.logicalTimeMs;
  const candidates = moments.filter((m) => m.targetTimeMs < current);
  const prev = candidates[candidates.length - 1];
  if (!prev) return;
  setPlaying(store, false);
  seekTo(store, prev.targetTimeMs);
}
