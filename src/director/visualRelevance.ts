import type { GameAnalysis, PlyAnalysis } from '../analysis/types';
import type { GameRecord } from '../pgn/types';
import type { GameUnderstanding, TacticalMotif, TurningPoint } from '../understanding/types';
import { detectDefenderLoss } from '../understanding/defenders';
import { parseFenPlacement } from '../render/fen';
import type { BeatRole, PayoffTerminus, StoryBeat, StoryPlan } from '../story/types';

/**
 * Phase 18B — geometry-driven camera, Part 1/2/3.
 *
 * A VisualRegion is the smallest representation of "what must be visible"
 * for a viewer to understand a piece of the selected story. It is built
 * ONLY from already-verified chess/story evidence (TacticalMotifInstance
 * geometry, DefenderLossRecord geometry, KingMobilityRecord, ThreatRecord,
 * ForcedSequence, ConsequenceChain.payoff) — never a new tactical detector,
 * never a guess from board appearance, and never StoryPlan.secondaryConflicts.
 *
 * This module answers ONLY "what is relevant here" (evidence -> squares).
 * Turning that into a concrete center/zoom is director/camera.ts's job;
 * turning THAT into timed keyframes is lowerToTimeline.ts's job. See each
 * module's own doc comment for this three-layer split.
 */

export type VisualRegionSource =
  | { readonly kind: 'motif'; readonly motif: TacticalMotif; readonly motifId: string }
  | { readonly kind: 'defender-loss'; readonly ply: number }
  | { readonly kind: 'escape-square-removed'; readonly ply: number }
  | { readonly kind: 'king-safety'; readonly ply: number }
  | { readonly kind: 'threat-refutation'; readonly threatId: string }
  | { readonly kind: 'forced-sequence'; readonly sequenceId: string }
  | { readonly kind: 'terminal-result'; readonly ply: number }
  | { readonly kind: 'move'; readonly plies: readonly number[] }
  | { readonly kind: 'full-board' };

export interface VisualRegion {
  /** The tactical/strategic actors themselves — attacker, target(s), king, moved piece. Never empty unless the region is 'full-board'. */
  readonly primarySquares: readonly string[];
  /** Supporting context only — a defender, a throughSquare, an escape square. May be empty. */
  readonly secondarySquares: readonly string[];
  /** Traces this region back to the evidence it was built from — see the module doc comment. */
  readonly source: VisualRegionSource;
}

export interface VisualRelevanceContext {
  readonly game: GameRecord;
  readonly analysis: GameAnalysis;
  readonly understanding: GameUnderstanding;
  readonly story: StoryPlan;
}

function allSquares(region: VisualRegion): readonly string[] {
  return [...region.primarySquares, ...region.secondarySquares];
}

/** Deterministic equality: same evidence-driven square set. Order-independent, dedup-independent. */
export function regionsEqual(a: VisualRegion, b: VisualRegion): boolean {
  const sa = [...new Set(allSquares(a))].sort();
  const sb = [...new Set(allSquares(b))].sort();
  if (sa.length !== sb.length) return false;
  return sa.every((s, i) => s === sb[i]);
}

export function unionRegions(regions: readonly VisualRegion[]): VisualRegion {
  const first = regions[0];
  if (!first) return { primarySquares: [], secondarySquares: [], source: { kind: 'full-board' } };
  const primary = new Set<string>();
  const secondary = new Set<string>();
  for (const r of regions) {
    for (const s of r.primarySquares) primary.add(s);
    for (const s of r.secondarySquares) secondary.add(s);
  }
  return { primarySquares: [...primary], secondarySquares: [...secondary], source: first.source };
}

function pliesByNumberOf(analysis: GameAnalysis): ReadonlyMap<number, PlyAnalysis> {
  return new Map(analysis.plies.map((p) => [p.ply, p]));
}

function moveSquaresFor(game: GameRecord, plies: readonly number[]): readonly string[] {
  const squares = new Set<string>();
  for (const ply of plies) {
    const move = game.moves.find((m) => m.ply === ply);
    if (!move) continue;
    squares.add(move.from);
    squares.add(move.to);
  }
  return [...squares];
}

function moveFallbackRegion(game: GameRecord, plies: readonly number[]): VisualRegion {
  return { primarySquares: moveSquaresFor(game, plies), secondarySquares: [], source: { kind: 'move', plies } };
}

/** The relevant king's square right after `ply`, for `color`, from the real board — never guessed. */
function kingSquareAfter(analysis: GameAnalysis, ply: number, color: 'w' | 'b'): string | null {
  const plyRecord = analysis.plies.find((p) => p.ply === ply);
  if (!plyRecord) return null;
  const board = parseFenPlacement(plyRecord.fenAfter);
  for (const [square, piece] of board) {
    if (piece.type === 'k' && piece.color === color) return square;
  }
  return null;
}

/**
 * Mirrors story/consequenceChain.ts's own removesEscapeSquares exactly (the
 * one place ply-P's escape-square-removed fact is established), but returns
 * the actual squares instead of a boolean — the king's own square, plus
 * exactly the escape squares that disappeared between before/after.
 */
function escapeSquareRegion(ply: number, understanding: GameUnderstanding, analysis: GameAnalysis): VisualRegion | null {
  const at = (p: number) => understanding.kingMobility.find((k) => k.ply === p);
  const before = at(ply - 1);
  const after = at(ply + 1);
  if (!before || !after || before.color !== after.color) return null;
  const removed = before.legalEscapeSquares.filter((sq) => !after.legalEscapeSquares.includes(sq));
  if (removed.length === 0) return null;
  const kingSquare = kingSquareAfter(analysis, ply, before.color);
  if (!kingSquare) return null;
  return { primarySquares: [kingSquare], secondarySquares: removed, source: { kind: 'escape-square-removed', ply } };
}

/** Reuses the already-tested pure detector directly — never a new tactical detector. */
function defenderLossRegion(ply: number, analysis: GameAnalysis): VisualRegion | null {
  const plyRecord = analysis.plies.find((p) => p.ply === ply);
  if (!plyRecord) return null;
  const records = detectDefenderLoss(plyRecord);
  if (records.length === 0) return null;
  const primary = new Set<string>();
  const secondary = new Set<string>();
  for (const r of records) {
    primary.add(r.targetSquare);
    secondary.add(r.defenderSquare);
  }
  return { primarySquares: [...primary], secondarySquares: [...secondary], source: { kind: 'defender-loss', ply } };
}

/**
 * The verified mechanism's own geometry — the highest-priority source (Part
 * 2/7). Only fires when the CauseConsequenceRecord's own mechanism is BOTH
 * verified and motif-sourced, and the referenced TacticalMotifInstance
 * actually resolves; an unverified or nearby-but-unrelated motif never wins
 * here (Part 7 — "do not allow an unverified motif to override a verified
 * causal fact").
 */
function verifiedMotifRegion(tp: TurningPoint, understanding: GameUnderstanding): VisualRegion | null {
  const cc = tp.causeConsequence;
  if (!cc.mechanismVerified || cc.mechanism === null || !cc.mechanismMotifId) return null;
  const motif = understanding.motifs.find((m) => m.id === cc.mechanismMotifId);
  if (!motif) return null;
  const secondary = motif.squares.throughSquare ? [motif.squares.throughSquare] : [];
  return {
    primarySquares: [motif.squares.attacker, ...motif.squares.targets],
    secondarySquares: secondary,
    source: { kind: 'motif', motif: motif.motif, motifId: motif.id }
  };
}

/** checkmate/stalemate payoff framing: the decisive king's own square, from structured data only — mirrors annotations.ts's terminalResultDirectives exactly. */
function payoffKingRegion(payoff: PayoffTerminus, analysis: GameAnalysis): VisualRegion | null {
  if (payoff.kind !== 'checkmate' && payoff.kind !== 'stalemate') return null;
  const plyRecord = analysis.plies.find((p) => p.ply === payoff.atPly);
  if (!plyRecord) return null;
  const ev = plyRecord.evaluationAfter;
  if (ev.kind !== 'terminal') return null;
  const relevantColor = ev.result === 'draw' ? plyRecord.sideToMove : ev.result === 'white-wins' ? 'b' : 'w';
  const kingSquare = kingSquareAfter(analysis, payoff.atPly, relevantColor);
  if (!kingSquare) return null;
  return { primarySquares: [kingSquare], secondarySquares: [], source: { kind: 'terminal-result', ply: payoff.atPly } };
}

/**
 * setup / building-sequence -> "establish" framing. Priority: the setup
 * beat's own threat-refutation evidence (targetSquare + the refuting move's
 * own destination, mirroring annotations.ts's threatRefutationDirectives)
 * union the building-sequence beat's own moves; falls back to plain move
 * geometry when neither resolves (Part 2, tiers 5-6).
 */
function establishRegion(beat: StoryBeat, ctx: VisualRelevanceContext): VisualRegion {
  const regions: VisualRegion[] = [];
  const threatIds = beat.evidenceRefs.threatIds ?? [];
  for (const threatId of threatIds) {
    const threat = ctx.understanding.threats.find((t) => t.id === threatId);
    if (!threat?.refutedBy) continue;
    const refutingMove = ctx.game.moves.find((m) => m.ply === threat.refutedBy!.ply);
    if (!refutingMove) continue;
    regions.push({
      primarySquares: [refutingMove.to, threat.targetSquare],
      secondarySquares: [],
      source: { kind: 'threat-refutation', threatId }
    });
  }
  // The beat's own move geometry is always included as establishing
  // context, whether or not stronger threat-refutation evidence resolved.
  regions.push(moveFallbackRegion(ctx.game, beat.plies));
  return unionRegions(regions);
}

/**
 * The climax beat -> "critical" framing. Priority order (Part 2/7): verified
 * mechanism motif > verified causal fact (defender-lost, then
 * escape-square-removed) > plain move geometry. The mated-king square is
 * ALWAYS added on top when this climax ply is a forced-mate-delivery — the
 * one piece of Phase-2.4-era behavior Part 10 requires unchanged.
 */
function criticalRegion(beat: StoryBeat, ctx: VisualRelevanceContext): VisualRegion {
  const turningPointId = beat.evidenceRefs.turningPointId;
  const tp = turningPointId ? ctx.understanding.turningPoints.find((t) => t.id === turningPointId) : undefined;
  const ply = beat.plies[0];

  let base: VisualRegion | null = null;
  if (tp) {
    base = verifiedMotifRegion(tp, ctx.understanding);
    const chain = ctx.story.centralConflict?.consequenceChain;
    if (!base && chain?.triggerFacts?.includes('defender-lost') && ply !== undefined) {
      base = defenderLossRegion(ply, ctx.analysis);
    }
    if (!base && chain?.triggerFacts?.includes('escape-square-removed') && ply !== undefined) {
      base = escapeSquareRegion(ply, ctx.understanding, ctx.analysis);
    }
  }
  const region = base ?? moveFallbackRegion(ctx.game, beat.plies);

  // Existing Phase 2.4 behavior, preserved verbatim (Part 10): the mated
  // king's own square is always shown for a forced-mate-delivery climax,
  // regardless of which evidence tier supplied the base region.
  if (tp?.kind === 'forced-mate-delivery' && ply !== undefined) {
    const move = ctx.game.moves.find((m) => m.ply === ply);
    if (move) {
      const matedColor = move.color === 'w' ? 'b' : 'w';
      const kingSquare = kingSquareAfter(ctx.analysis, ply, matedColor);
      if (kingSquare) {
        return unionRegions([region, { primarySquares: [kingSquare], secondarySquares: [], source: { kind: 'king-safety', ply } }]);
      }
    }
  }
  return region;
}

/**
 * The consequence beat -> "follow" framing. Enriches the plain move
 * geometry with any verified defender-loss fact recorded on one of its own
 * plies (the chain's own consequents already carry causalFacts — see
 * story/consequenceChain.ts), never re-selecting a different ply.
 */
function consequenceRegion(beat: StoryBeat, ctx: VisualRelevanceContext): VisualRegion {
  const chain = ctx.story.centralConflict?.consequenceChain;
  const regions: VisualRegion[] = [moveFallbackRegion(ctx.game, beat.plies)];
  if (chain) {
    for (const link of chain.consequents) {
      if (!beat.plies.includes(link.ply)) continue;
      if (link.causalFacts?.includes('defender-lost')) {
        const region = defenderLossRegion(link.ply, ctx.analysis);
        if (region) regions.push(region);
      }
    }
  }
  return unionRegions(regions);
}

/**
 * The resolution beat -> "payoff" framing. checkmate/stalemate get the
 * decisive king's own square (Part 10); every other payoff kind falls back
 * to the resolution beat's own move geometry — no invented payoff evidence.
 */
function payoffRegion(beat: StoryBeat, ctx: VisualRelevanceContext): VisualRegion {
  const chain = ctx.story.centralConflict?.consequenceChain;
  const kingRegion = chain ? payoffKingRegion(chain.payoff, ctx.analysis) : null;
  const fallback = moveFallbackRegion(ctx.game, beat.plies);
  return kingRegion ? unionRegions([fallback, kingRegion]) : fallback;
}

/** Which conceptual camera role a StoryBeat maps to — see camera.ts's grouping. */
export function cameraRoleFor(role: BeatRole): 'establish' | 'critical' | 'consequence' | 'payoff' {
  switch (role) {
    case 'setup':
    case 'building-sequence':
      return 'establish';
    case 'climax':
      return 'critical';
    case 'consequence':
      return 'consequence';
    case 'resolution':
      return 'payoff';
  }
}

/**
 * The one entry point: derives a StoryBeat's VisualRegion, dispatching on
 * its camera role. Always returns a region — falls back to plain move
 * geometry (never full-board-with-no-evidence) so a beat with no stronger
 * evidence still frames its own actual moves, per Part 11's "truthful but
 * less specific over dramatic but unsupported".
 */
export function deriveBeatVisualRegion(beat: StoryBeat, ctx: VisualRelevanceContext): VisualRegion {
  switch (cameraRoleFor(beat.role)) {
    case 'establish':
      return establishRegion(beat, ctx);
    case 'critical':
      return criticalRegion(beat, ctx);
    case 'consequence':
      return consequenceRegion(beat, ctx);
    case 'payoff':
      return payoffRegion(beat, ctx);
  }
}
