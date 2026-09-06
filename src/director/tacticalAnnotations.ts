import type { GameAnalysis } from '../analysis/types';
import type { GameRecord, MoveRecord } from '../pgn/types';
import type { GameUnderstanding, TurningPoint } from '../understanding/types';
import { detectDefenderLoss } from '../understanding/defenders';
import type { CausalLink, StoryBeat, StoryPlan } from '../story/types';
import { cameraRoleFor, kingSquareAfter, verifiedMechanismMotif } from './visualRelevance';
import type { CameraRole, DirectorSettings, TacticalAnnotationDirective, TacticalAnnotationKind } from './types';

/**
 * Phase 18C — tactical visual explanation.
 *
 * The camera (Phase 18B) answers "where should the viewer look". This module
 * answers "why does this move work", by turning ALREADY-VERIFIED chess
 * evidence into declarative annotation directives carrying enough geometry
 * for the renderer to draw them without re-solving any chess.
 *
 * Every directive here is traceable to a record produced upstream:
 *
 *   verified mechanism motif   CauseConsequenceRecord.mechanismVerified +
 *                              mechanismMotifId -> TacticalMotifInstance.squares
 *   verified causal facts      ConsequenceChain triggerFacts/consequents
 *                              causalFacts, whose exact squares come from the
 *                              same pure detectors understanding/ already uses
 *                              (detectDefenderLoss, KingMobilityRecord)
 *   threat / refutation        ThreatRecord.targetSquare + refutedBy
 *   forced response           ForcedSequence membership, drawn on the reply's
 *                              own from/to (a ForcedSequence carries plies,
 *                              never squares of its own)
 *   check / checkmate          PlySignals.deliversCheck/deliversMate, on the
 *                              real king square read from the ply's own FEN
 *   move fallback              MoveRecord.from/to
 *
 * NOT SUPPORTED, deliberately: 'deflection' and 'overload'. Both are members
 * of the TacticalMotif union, but understanding/motifs.ts detects only forks
 * (findForks), line motifs (findLineMotifs -> pin/skewer/battery) and
 * discoveries (findDiscoveries). No detector ever emits a deflection or
 * overload instance, so no geometry for either exists anywhere upstream, and
 * this module will not invent one — an annotation asserting a deflection
 * would be exactly the "dramatic but unsupported" claim the project's own
 * truthful-over-dramatic rule forbids.
 */

/**
 * Fixed ranking, lowest wins. Mirrors the Phase 18C specification's own
 * priority order: verified mechanism geometry, then verified causal facts,
 * then threat/refutation, then forced response, then check geometry, then
 * the plain-move fallback. A stable table, never a per-game judgement.
 */
const TACTICAL_PRIORITY: Readonly<Record<TacticalAnnotationKind, number>> = {
  'mechanism-attack': 0,
  'mechanism-line': 1,
  'mechanism-origin': 2,
  'defender-loss': 3,
  'escape-square-removed': 4,
  refutation: 5,
  'threat-target': 6,
  'forced-response': 7,
  'check-marker': 8,
  'critical-move': 9
};

/** Kinds drawn as an arrow — exactly two squares, [from, to]. Everything else is a highlight. */
const ARROW_KINDS: ReadonlySet<TacticalAnnotationKind> = new Set<TacticalAnnotationKind>([
  'mechanism-attack',
  'defender-loss',
  'refutation',
  'forced-response',
  'critical-move'
]);

export function isArrowKind(kind: TacticalAnnotationKind): boolean {
  return ARROW_KINDS.has(kind);
}

interface Ctx {
  readonly game: GameRecord;
  readonly analysis: GameAnalysis;
  readonly understanding: GameUnderstanding;
  readonly story: StoryPlan;
}

type Draft = Omit<TacticalAnnotationDirective, 'priority'>;

function directive(draft: Draft): TacticalAnnotationDirective {
  return { ...draft, priority: TACTICAL_PRIORITY[draft.kind] };
}

function moveAt(game: GameRecord, ply: number): MoveRecord | undefined {
  return game.moves.find((m) => m.ply === ply);
}

function beatOf(story: StoryPlan, role: CameraRole): StoryBeat | undefined {
  return story.beats.find((b) => cameraRoleFor(b.role) === role);
}

// ============================================================
// Tier 1 — the verified mechanism's own geometry
// ============================================================

/**
 * A verified motif mechanism, drawn as its own real geometry: an attack
 * arrow per verified target, plus the line/origin square the motif itself
 * names. Nothing here is inferred from the board — every square comes from
 * TacticalMotifInstance.squares, which understanding/geometry.ts produced.
 */
function mechanismDirectives(tp: TurningPoint, ply: number, ctx: Ctx): TacticalAnnotationDirective[] {
  const motif = verifiedMechanismMotif(tp, ctx.understanding);
  if (!motif) return [];

  const { attacker, targets, throughSquare } = motif.squares;
  const evidenceRef = { kind: 'motif' as const, motif: motif.motif, motifId: motif.id };
  const out: TacticalAnnotationDirective[] = [];

  for (const target of targets) {
    // findLineMotifs reports a battery with through === target (both name the
    // second attacker), so a "battery" whose target IS its attacker would be a
    // zero-length arrow with nothing to show. Skip rather than draw a dot.
    if (target === attacker) continue;
    out.push(
      directive({
        fromPly: ply,
        toPly: ply,
        kind: 'mechanism-attack',
        role: 'critical',
        squares: [attacker, target],
        evidenceRef
      })
    );
  }

  if (throughSquare && throughSquare !== attacker && !targets.includes(throughSquare)) {
    // A pin/skewer's own through-square is the piece caught on the line; a
    // discovery's is the square the mover vacated to reveal the attack. Both
    // are stated by the motif itself, so both are honest to show — under
    // their own distinct kinds, since they mean different things.
    out.push(
      directive({
        fromPly: ply,
        toPly: ply,
        kind: motif.motif === 'discovery' ? 'mechanism-origin' : 'mechanism-line',
        role: 'critical',
        squares: [throughSquare],
        evidenceRef
      })
    );
  }

  return out;
}

// ============================================================
// Tier 2 — verified causal facts
// ============================================================

/** defender-lost: the exact departed-defender -> collapsed-target pair the already-tested detector reports. */
function defenderLossDirectives(ply: number, role: CameraRole, ctx: Ctx): TacticalAnnotationDirective[] {
  const plyRecord = ctx.analysis.plies.find((p) => p.ply === ply);
  if (!plyRecord) return [];
  return detectDefenderLoss(plyRecord).map((record) =>
    directive({
      fromPly: ply,
      toPly: ply,
      kind: 'defender-loss',
      role,
      squares: [record.defenderSquare, record.targetSquare],
      evidenceRef: { kind: 'causal-fact', fact: 'defender-lost', ply }
    })
  );
}

/**
 * escape-square-removed: the restricted king plus exactly the squares that
 * disappeared between the KingMobilityRecord before and after this ply —
 * the same bracket story/consequenceChain.ts uses to establish the fact.
 */
function escapeSquareDirectives(ply: number, role: CameraRole, ctx: Ctx): TacticalAnnotationDirective[] {
  const at = (p: number) => ctx.understanding.kingMobility.find((k) => k.ply === p);
  const before = at(ply - 1);
  const after = at(ply + 1);
  if (!before || !after || before.color !== after.color) return [];
  const vanished = before.legalEscapeSquares.filter((sq) => !after.legalEscapeSquares.includes(sq));
  if (vanished.length === 0) return [];
  const kingSquare = kingSquareAfter(ctx.analysis, ply, before.color);
  if (!kingSquare) return [];

  // A legalEscapeSquares list is measured FROM wherever the king stood at
  // the time, so the two bracketing records are only comparable square-by-
  // square when the king did not itself relocate between them. The before-
  // record at ply-1 is measured before that side's own move, i.e. from the
  // king's square after ply-2. When that differs from where the king stands
  // now, a raw set difference reports squares that were never adjacent to
  // the king's current position — including, when the king moved, the very
  // square it moved TO, which would put a "this escape was taken away"
  // marker under a king sitting there perfectly safely. The verified fact
  // itself (story/consequenceChain.ts's removesEscapeSquares) is a COUNT
  // comparison and is unaffected by this; Phase 18C simply declines to draw
  // geometry it cannot honestly attribute, leaving the fact unillustrated
  // rather than mis-illustrated.
  const kingSquareBefore = kingSquareAfter(ctx.analysis, ply - 2, before.color);
  if (kingSquareBefore !== kingSquare) return [];

  const removed = vanished.filter((sq) => sq !== kingSquare);
  if (removed.length === 0) return [];
  return [
    directive({
      fromPly: ply,
      toPly: ply,
      kind: 'escape-square-removed',
      role,
      squares: [kingSquare, ...removed],
      evidenceRef: { kind: 'causal-fact', fact: 'escape-square-removed', ply }
    })
  ];
}

/** Both causal-fact tiers for one chain link, gated on the fact the chain itself recorded. */
function causalFactDirectives(ply: number, facts: readonly string[] | undefined, role: CameraRole, ctx: Ctx): TacticalAnnotationDirective[] {
  if (!facts) return [];
  const out: TacticalAnnotationDirective[] = [];
  if (facts.includes('defender-lost')) out.push(...defenderLossDirectives(ply, role, ctx));
  if (facts.includes('escape-square-removed')) out.push(...escapeSquareDirectives(ply, role, ctx));
  return out;
}

// ============================================================
// Tier 3 — threat and its refutation
// ============================================================

/**
 * The setup beat's own threats: the threatened square, and — when the
 * threat was actually refuted — an arrow from the refuting move's own
 * destination to it. Mirrors director/annotations.ts's existing
 * threatRefutationDirectives geometry exactly, so the two channels never
 * disagree about what refuted what.
 */
function threatDirectives(ctx: Ctx): TacticalAnnotationDirective[] {
  const beat = beatOf(ctx.story, 'establish');
  if (!beat) return [];
  const out: TacticalAnnotationDirective[] = [];

  for (const threatId of beat.evidenceRefs.threatIds ?? []) {
    const threat = ctx.understanding.threats.find((t) => t.id === threatId);
    if (!threat) continue;

    out.push(
      directive({
        fromPly: threat.ply,
        toPly: threat.refutedBy?.ply ?? threat.ply,
        kind: 'threat-target',
        role: 'establish',
        squares: [threat.targetSquare],
        evidenceRef: { kind: 'threat', threatId }
      })
    );

    if (!threat.refutedBy) continue;
    const refutingMove = moveAt(ctx.game, threat.refutedBy.ply);
    if (!refutingMove) continue;
    // Normally the refuting piece answers the threat from wherever it landed
    // (the same to -> targetSquare geometry director/annotations.ts uses). But
    // a refutation very often IS taking the threatened square, and then those
    // two squares are the same one — an arrow from a square to itself draws a
    // dot. In that case the truthful, visible geometry is the refuting move's
    // own journey onto the square it contested.
    const answersFrom = refutingMove.to === threat.targetSquare ? refutingMove.from : refutingMove.to;
    out.push(
      directive({
        fromPly: threat.refutedBy.ply,
        toPly: threat.refutedBy.ply,
        kind: 'refutation',
        role: 'establish',
        squares: [answersFrom, threat.targetSquare],
        pieceId: refutingMove.pieceId,
        evidenceRef: { kind: 'threat', threatId }
      })
    );
  }

  return out;
}

// ============================================================
// Tier 4 — forced response
// ============================================================

/**
 * A reply the game's own ForcedSequence detection established had no free
 * choice, drawn on that reply's own from/to. A ForcedSequence carries plies
 * and a forcingReason but no squares, so the move itself is the only honest
 * geometry available — never a guess about why it was forced.
 */
function forcedResponseDirectives(plies: readonly number[], role: CameraRole, ctx: Ctx): TacticalAnnotationDirective[] {
  const out: TacticalAnnotationDirective[] = [];
  for (const ply of plies) {
    const sequence = ctx.understanding.sequences.find((s) => s.plies.includes(ply) && s.startPly !== ply);
    if (!sequence) continue;
    const move = moveAt(ctx.game, ply);
    if (!move) continue;
    out.push(
      directive({
        fromPly: ply,
        toPly: ply,
        kind: 'forced-response',
        role,
        squares: [move.from, move.to],
        pieceId: move.pieceId,
        evidenceRef: { kind: 'forced-sequence', sequenceId: sequence.id }
      })
    );
  }
  return out;
}

// ============================================================
// Tier 5 — check / checkmate geometry
// ============================================================

/**
 * The king that was checked or mated, on plies whose own PlySignals already
 * say so. The square is read from that ply's real post-move FEN — the same
 * board director/annotations.ts's terminal highlight reads.
 */
function checkDirectives(plies: readonly number[], role: CameraRole, ctx: Ctx): TacticalAnnotationDirective[] {
  const out: TacticalAnnotationDirective[] = [];
  for (const ply of plies) {
    const semantics = ctx.understanding.plies.find((p) => p.ply === ply);
    if (!semantics) continue;
    if (!semantics.signals.deliversCheck && !semantics.signals.deliversMate) continue;
    const move = moveAt(ctx.game, ply);
    if (!move) continue;
    const checkedColor = move.color === 'w' ? 'b' : 'w';
    const kingSquare = kingSquareAfter(ctx.analysis, ply, checkedColor);
    if (!kingSquare) continue;
    out.push(
      directive({
        fromPly: ply,
        toPly: ply,
        kind: 'check-marker',
        role,
        squares: [kingSquare],
        evidenceRef: { kind: 'terminal', ply }
      })
    );
  }
  return out;
}

// ============================================================
// Tier 6 — the critical move itself
// ============================================================

function criticalMoveDirective(ply: number, ctx: Ctx): TacticalAnnotationDirective[] {
  const move = moveAt(ctx.game, ply);
  if (!move) return [];
  return [
    directive({
      fromPly: ply,
      toPly: ply,
      kind: 'critical-move',
      role: 'critical',
      squares: [move.from, move.to],
      pieceId: move.pieceId,
      evidenceRef: { kind: 'move', ply }
    })
  ];
}

// ============================================================
// Conflict handling
// ============================================================

function squareKey(squares: readonly string[]): string {
  return [...squares].join('>');
}

function identityOf(d: TacticalAnnotationDirective): string {
  return `${d.kind}|${d.fromPly}|${d.toPly}|${squareKey(d.squares)}`;
}

/**
 * Deterministic ordering: earliest ply first, then strongest evidence, then
 * a fixed tiebreak on kind and geometry so two runs can never disagree.
 */
function compareDirectives(a: TacticalAnnotationDirective, b: TacticalAnnotationDirective): number {
  if (a.fromPly !== b.fromPly) return a.fromPly - b.fromPly;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  const ka = squareKey(a.squares);
  const kb = squareKey(b.squares);
  return ka === kb ? 0 : ka < kb ? -1 : 1;
}

/**
 * Suppression, applied in priority order so a stronger annotation always
 * survives its weaker duplicate:
 *
 *   1. an exact repeat (same kind, span and squares) is dropped;
 *   2. a directive whose squares are already fully covered, on the same ply,
 *      by an accepted stronger one is dropped as redundant — this is what
 *      stops a 'critical-move' arrow restating a 'mechanism-attack' that
 *      already runs between the same two squares;
 *   3. whatever is left is capped at maxTacticalAnnotationsPerPly, so a
 *      dense ply shows its strongest ideas rather than every true one.
 */
function resolveConflicts(directives: readonly TacticalAnnotationDirective[], settings: DirectorSettings): TacticalAnnotationDirective[] {
  const ordered = [...directives].sort(compareDirectives);
  const seen = new Set<string>();
  const acceptedByPly = new Map<number, TacticalAnnotationDirective[]>();
  const accepted: TacticalAnnotationDirective[] = [];

  for (const candidate of ordered) {
    if (seen.has(identityOf(candidate))) continue;
    // Defence in depth: an arrow whose endpoints coincide renders as a dot
    // and explains nothing. Each source already avoids producing one; this
    // guarantees no future source can.
    if (isArrowKind(candidate.kind) && (candidate.squares.length < 2 || candidate.squares[0] === candidate.squares[1])) continue;

    const onPly = acceptedByPly.get(candidate.fromPly) ?? [];
    const covered = onPly.some((existing) => candidate.squares.every((sq) => existing.squares.includes(sq)));
    if (covered) continue;
    if (onPly.length >= settings.maxTacticalAnnotationsPerPly) continue;

    seen.add(identityOf(candidate));
    onPly.push(candidate);
    acceptedByPly.set(candidate.fromPly, onPly);
    accepted.push(candidate);
  }

  return accepted.sort(compareDirectives);
}

// ============================================================
// Entry point
// ============================================================

/**
 * The one tactical-annotation decision per game. Pure and synchronous; every
 * input is already materialized. Returns [] whenever StoryPlan selected no
 * central conflict — with no selected story there is nothing to explain, and
 * inventing an explanation is exactly what this layer must not do.
 *
 * Annotations are attached to the beat phase they explain, so a viewer can
 * follow setup -> threat -> critical move -> mechanism -> consequence ->
 * payoff rather than seeing every arrow at once.
 */
export function deriveTacticalDirectives(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  story: StoryPlan,
  settings: DirectorSettings
): readonly TacticalAnnotationDirective[] {
  const conflict = story.centralConflict;
  if (!conflict || story.beats.length === 0) return [];

  const ctx: Ctx = { game, analysis, understanding, story };
  const chain = conflict.consequenceChain;
  const criticalPly = chain.triggerPly;
  const tp = understanding.turningPoints.find((t) => t.id === conflict.primaryTurningPointId);

  const drafts: TacticalAnnotationDirective[] = [];

  // Establish: only the problem being posed, never the answer.
  drafts.push(...threatDirectives(ctx));

  // Critical: the mechanism itself, with the move as the honest fallback.
  if (tp) {
    drafts.push(...mechanismDirectives(tp, criticalPly, ctx));
    drafts.push(...causalFactDirectives(criticalPly, chain.triggerFacts, 'critical', ctx));
  }
  drafts.push(...criticalMoveDirective(criticalPly, ctx));

  // Consequence: what the critical move forced, on the chain's own consequents.
  const consequentPlies = chain.consequents.map((l: CausalLink) => l.ply);
  const payoffBeat = beatOf(story, 'payoff');
  const payoffPlies = new Set(payoffBeat?.plies ?? []);
  for (const link of chain.consequents) {
    const role: CameraRole = payoffPlies.has(link.ply) ? 'payoff' : 'consequence';
    drafts.push(...causalFactDirectives(link.ply, link.causalFacts, role, ctx));
  }
  drafts.push(...forcedResponseDirectives(consequentPlies.filter((p) => !payoffPlies.has(p)), 'consequence', ctx));

  // Payoff: the king the story actually arrived at, plus check geometry on
  // the critical ply itself when the move gave check.
  drafts.push(...checkDirectives([criticalPly], 'critical', ctx));
  drafts.push(...checkDirectives([...payoffPlies], 'payoff', ctx));

  return resolveConflicts(drafts, settings);
}
