import type { GameRecord } from '../pgn/types';
import type { GameAnalysis } from '../analysis/types';
import type { GameUnderstanding } from '../understanding/types';
import type { StoryArchetype, StoryPlan } from '../story/types';
import { parseFenPlacement } from '../render/fen';
import type { AnnotationDirective, AnnotationDirectiveKind } from './types';

/**
 * One generic mapping per AnnotationDirectiveKind — not four bespoke
 * per-archetype detectors. Every square/ply used here already exists
 * upstream (GameRecord.moves, GameUnderstanding, StoryPlan, GameAnalysis);
 * nothing here detects a new tactic or invents a fact.
 */

function moveAt(game: GameRecord, ply: number) {
  return game.moves.find((m) => m.ply === ply);
}

/** Universal, beat-independent: every played move's own destination square. */
function lastMoveDirectives(game: GameRecord): AnnotationDirective[] {
  return game.moves.map((m) => ({
    fromPly: m.ply,
    toPly: m.ply,
    kind: 'last-move' as const,
    squares: [m.to],
    evidenceRef: { kind: 'move' as const, ply: m.ply }
  }));
}

/** Only for 'setup' beats — an arrow from the refuting move's own square to the threat's target square. */
function threatRefutationDirectives(
  game: GameRecord,
  story: StoryPlan,
  understanding: GameUnderstanding
): AnnotationDirective[] {
  const directives: AnnotationDirective[] = [];
  for (const beat of story.beats) {
    if (beat.role !== 'setup') continue;
    const threatIds = beat.evidenceRefs.threatIds ?? [];
    for (const threatId of threatIds) {
      const threat = understanding.threats.find((t) => t.id === threatId);
      if (!threat || !threat.refutedBy) continue;
      const refutingMove = moveAt(game, threat.refutedBy.ply);
      if (!refutingMove) continue;
      directives.push({
        fromPly: threat.refutedBy.ply,
        toPly: threat.refutedBy.ply,
        kind: 'threat-refutation-arrow',
        squares: [refutingMove.to, threat.targetSquare],
        evidenceRef: { kind: 'beat', id: beat.id }
      });
    }
  }
  return directives;
}

/** The climax beat's own squares, highlighted across climax + consequence + resolution. */
function centralConflictDirectives(game: GameRecord, story: StoryPlan): AnnotationDirective[] {
  const climaxBeat = story.beats.find((b) => b.role === 'climax');
  if (!climaxBeat) return [];
  const climaxPly = climaxBeat.plies[0];
  if (climaxPly === undefined) return [];
  const move = moveAt(game, climaxPly);
  if (!move) return [];

  const spineBeats = story.beats.filter((b) => b.role === 'climax' || b.role === 'consequence' || b.role === 'resolution');
  const allPlies = spineBeats.flatMap((b) => b.plies);
  const fromPly = Math.min(...allPlies);
  const toPly = Math.max(...allPlies);

  return [
    {
      fromPly,
      toPly,
      kind: 'central-conflict-highlight',
      squares: [move.from, move.to],
      evidenceRef: { kind: 'beat', id: climaxBeat.id }
    }
  ];
}

const ARCHETYPE_COLOR_ORDER: Readonly<Record<StoryArchetype, number>> = {
  'forced-trap': 0,
  'king-hunt': 1,
  'pawn-journey': 2,
  'stalemate-swindle': 3
};

/**
 * One shared rule for all four StoryArchetypes — highlights every ply's
 * from/to squares across the signal's own plies. Fires independent of
 * beatIds overlap (a signal is never dropped for lack of overlap — see
 * story/types.ts's own documented rule, continued here).
 */
function archetypeTrackDirectives(game: GameRecord, story: StoryPlan): AnnotationDirective[] {
  const directives: AnnotationDirective[] = [];
  for (const signal of story.archetypeSignals) {
    if (signal.plies.length === 0) continue;
    const squares = new Set<string>();
    for (const ply of signal.plies) {
      const move = moveAt(game, ply);
      if (!move) continue;
      squares.add(move.from);
      squares.add(move.to);
    }
    if (squares.size === 0) continue;
    directives.push({
      fromPly: Math.min(...signal.plies),
      toPly: Math.max(...signal.plies),
      kind: 'archetype-track',
      squares: [...squares],
      evidenceRef: { kind: 'archetypeSignal', archetype: signal.archetype }
    });
  }
  return directives;
}

/** Only when the game's final ply is genuinely terminal (checkmate/draw) — the decisive king's own square, from structured enum data only, never any new text. */
function terminalResultDirectives(game: GameRecord, analysis: GameAnalysis): AnnotationDirective[] {
  if (analysis.plies.length === 0) return [];
  const finalPly = analysis.plies[analysis.plies.length - 1]!;
  const ev = finalPly.evaluationAfter;
  if (ev.kind !== 'terminal') return [];

  // Draw (including stalemate): the side to move (no legal moves) is the
  // relevant king. Win: the losing side's king is the mated one. Both
  // conventions match analyzeGame.ts's own terminalEvaluation comment.
  const relevantColor = ev.result === 'draw' ? finalPly.sideToMove : ev.result === 'white-wins' ? 'b' : 'w';

  const board = parseFenPlacement(finalPly.fenAfter);
  let kingSquare: string | null = null;
  for (const [square, piece] of board) {
    if (piece.type === 'k' && piece.color === relevantColor) {
      kingSquare = square;
      break;
    }
  }
  if (!kingSquare) return [];

  return [
    {
      fromPly: finalPly.ply,
      toPly: finalPly.ply,
      kind: 'terminal-result-highlight',
      squares: [kingSquare],
      evidenceRef: { kind: 'terminal' }
    }
  ];
}

const KIND_ORDER: Readonly<Record<AnnotationDirectiveKind, number>> = {
  'last-move': 0,
  'threat-refutation-arrow': 1,
  'central-conflict-highlight': 2,
  'archetype-track': 3,
  'terminal-result-highlight': 4
};

/** Deterministic order: fromPly ascending, then a fixed kind order — a stable serialization order, never an editorial ranking. */
export function deriveAnnotationDirectives(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  story: StoryPlan
): readonly AnnotationDirective[] {
  const all = [
    ...lastMoveDirectives(game),
    ...threatRefutationDirectives(game, story, understanding),
    ...centralConflictDirectives(game, story),
    ...archetypeTrackDirectives(game, story),
    ...terminalResultDirectives(game, analysis)
  ];

  return all.sort((a, b) => {
    if (a.fromPly !== b.fromPly) return a.fromPly - b.fromPly;
    if (KIND_ORDER[a.kind] !== KIND_ORDER[b.kind]) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    // Same fromPly, same kind (only possible for two archetype-track
    // directives starting on the same ply): break the tie by a fixed
    // archetype order, same fixed table story/archetypes.ts itself uses.
    if (a.evidenceRef.kind === 'archetypeSignal' && b.evidenceRef.kind === 'archetypeSignal') {
      return ARCHETYPE_COLOR_ORDER[a.evidenceRef.archetype] - ARCHETYPE_COLOR_ORDER[b.evidenceRef.archetype];
    }
    return 0;
  });
}
