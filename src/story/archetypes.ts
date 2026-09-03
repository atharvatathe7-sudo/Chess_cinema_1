import type { GameAnalysis } from '../analysis/types';
import { toComparableCp } from '../analysis/evaluation';
import type { GameRecord } from '../pgn/types';
import type { ForcedSequence, GameUnderstanding } from '../understanding/types';
import type { ArchetypeSignal, CentralConflict, StoryArchetype, StoryBeat, StorySettings } from './types';
import { winnerOf, type GameOutcome } from './gameOutcome';

/** Below this the final evaluation is not decisive enough to contradict anything. */
const DECISIVE_FINAL_CP = 300;

/**
 * How far back stalemateBlunderSignals looks for the advantage the stalemating
 * side held. Short and fixed on purpose — the claim is about a win thrown away
 * at the END of the game, not about an advantage held at some earlier point.
 */
const STALEMATE_ADVANTAGE_WINDOW_PLIES = 8;

/**
 * True when the final position points decisively at one side while the
 * recorded result does not award them the game. Both directions count: a
 * decisive board with a drawn result, and a decisive board favouring the
 * side that is recorded as losing.
 */
function boardContradictsResult(outcome: GameOutcome): boolean {
  const evaluation = outcome.finalEvaluation;
  if (evaluation.kind === 'terminal') return false;

  const favours = evaluation.kind === 'mate' ? (evaluation.mateIn > 0 ? 'w' : 'b') : evaluation.cp >= DECISIVE_FINAL_CP ? 'w' : evaluation.cp <= -DECISIVE_FINAL_CP ? 'b' : null;
  if (favours === null) return false;

  const winner = winnerOf(outcome);
  if (outcome.result === '1/2-1/2') return true;
  return winner !== null && winner !== favours;
}

function beatIdsOverlapping(plies: readonly number[], beats: readonly StoryBeat[]): readonly string[] {
  const plySet = new Set(plies);
  return beats.filter((b) => b.plies.some((p) => plySet.has(p))).map((b) => b.id);
}

/**
 * King Hunt — pure pass-through of understanding.narrativeSignals. No
 * second detector: the ForcedSequence/mate-transition gating already lives
 * in understanding/gameArc.ts's computeNarrativeSignals and is not
 * reimplemented here. KingMobilityRecord is available to a later consumer
 * for corroborating detail over these same plies, but is never used here to
 * independently produce a king-hunt signal.
 */
function kingHuntSignals(understanding: GameUnderstanding, beats: readonly StoryBeat[]): ArchetypeSignal[] {
  const signals: ArchetypeSignal[] = [];
  for (const signal of understanding.narrativeSignals) {
    if (signal.archetype !== 'king-hunt') continue;
    const plies = [...new Set(signal.supportingEvidence.flatMap((e) => e.sourcePlies))].sort((a, b) => a - b);
    if (plies.length === 0) continue;
    const sacrificePly = enablingSacrificePly(plies, understanding);
    signals.push({
      archetype: 'king-hunt',
      plies,
      beatIds: beatIdsOverlapping(plies, beats),
      ...(sacrificePly !== undefined ? { enablingSacrificePly: sacrificePly } : {}),
      evidence: signal.supportingEvidence[0]!
    });
  }
  return signals;
}

/** The mate-related turning point that qualified this hunt, per gameArc.ts's own test. */
function mateQualifyingPly(huntPlies: ReadonlySet<number>, understanding: GameUnderstanding): number | undefined {
  const mateTps = understanding.turningPoints
    .filter((tp) => huntPlies.has(tp.ply) && (tp.kind === 'forced-mate-delivery' || tp.kind === 'mate-appeared'))
    .sort((a, b) => a.ply - b.ply);
  return mateTps[mateTps.length - 1]?.ply;
}

/**
 * The forcing run reachable from `seq`: itself, plus every check-type sequence
 * that begins exactly where the previous one ended. This is the same
 * adjacency rule understanding/gameArc.ts uses to reassemble a continuous
 * alternating-check hunt from the short sequences detectForcedSequences
 * produces — reused rather than reinvented, and never generalized to "nearby
 * plies".
 */
function connectedRunEnd(seq: ForcedSequence, understanding: GameUnderstanding, huntPlies: ReadonlySet<number>): number {
  let end = seq.endPly;
  let extended = true;
  while (extended) {
    extended = false;
    for (const other of understanding.sequences) {
      if (other.startPly === end + 1 && huntPlies.has(other.startPly)) {
        end = other.endPly;
        extended = true;
        break;
      }
    }
  }
  return end;
}

/**
 * Phase 16 (MUST HAVE 7) — "a sacrifice happened during a king hunt" versus
 * "the sacrifice enabled the mating sequence".
 *
 * These are different claims and the second is much stronger. The benchmark
 * shape that motivated this: a queen offered with check, taken by force, and
 * mate delivered two plies later by a piece the capture unblocked. The system
 * could already see the hunt and could already see an isSacrifice ply; what it
 * could not say was that the one produced the other, so the sacrifice was
 * reported only as a separate, lower-priority archetype and the hunt's own
 * narration never mentioned it.
 *
 * A sacrifice is called ENABLING only when all three hold:
 *
 *   1. PlySignals.isSacrifice — an actual, engine-sound material offer, not a
 *      blunder that happened to lose material (see understanding/quality.ts).
 *   2. it lies INSIDE the hunt's own plies — not merely near them.
 *   3. its ForcedSequence reaches the mate-qualifying turning point, either
 *      by containing it or via sequences adjacent-continuous with it.
 *
 * Condition 3 allows the mate to land exactly one ply past the run's end,
 * because understanding/gameArc.ts documents that the mating move is
 * structurally never part of any ForcedSequence's own plies — a king's last
 * forced reply never "forces" the delivering move that follows it. Without
 * that allowance the test would be unsatisfiable for precisely the mating
 * combinations it exists to recognise.
 *
 * When nothing qualifies this returns undefined, and the hunt keeps its
 * existing, weaker narration. Nothing here downgrades a hunt.
 */
export function enablingSacrificePly(plies: readonly number[], understanding: GameUnderstanding): number | undefined {
  const huntPlies = new Set(plies);
  const matePly = mateQualifyingPly(huntPlies, understanding);
  if (matePly === undefined) return undefined;

  const candidates = understanding.plies
    .filter((ps) => ps.signals.isSacrifice && huntPlies.has(ps.ply) && ps.ply <= matePly)
    .sort((a, b) => a.ply - b.ply);

  for (const ps of candidates) {
    const sequenceId = ps.signals.forcedSequenceId;
    // A sacrifice that forced nothing cannot have enabled a forced mate.
    if (sequenceId === undefined) continue;
    const seq = understanding.sequences.find((s) => s.id === sequenceId);
    if (!seq) continue;
    if (seq.plies.includes(matePly)) return ps.ply;
    const runEnd = connectedRunEnd(seq, understanding, huntPlies);
    if (matePly >= ps.ply && matePly <= runEnd + 1) return ps.ply;
  }
  return undefined;
}

/**
 * Pawn Journey — a pieceId's full move history (from GameRecord, threaded
 * via Phase 2.2.1's PlySignals.pieceId) ending in isPromotion. Zero new
 * detection: pieceId/promotion are already-existing, deterministic facts.
 */
function pawnJourneySignals(
  game: GameRecord,
  understanding: GameUnderstanding,
  settings: StorySettings,
  beats: readonly StoryBeat[]
): ArchetypeSignal[] {
  const signals: ArchetypeSignal[] = [];
  const seen = new Set<string>();

  for (const ps of understanding.plies) {
    if (!ps.signals.isPromotion) continue;
    const pieceId = ps.signals.pieceId;
    if (seen.has(pieceId)) continue;
    seen.add(pieceId);

    const history = game.moves.filter((m) => m.pieceId === pieceId).sort((a, b) => a.ply - b.ply);
    if (history.length < settings.minPawnJourneyPlies) continue;

    const plies = history.map((m) => m.ply);
    const promotionMove = history[history.length - 1]!;
    signals.push({
      archetype: 'pawn-journey',
      plies,
      beatIds: beatIdsOverlapping(plies, beats),
      evidence: {
        basis: 'chess-rule',
        sourcePlies: plies,
        note: `pawn ${pieceId} made ${history.length} moves before promoting to ${promotionMove.promotion}`
      }
    });
  }

  return signals;
}

/**
 * Stalemate Swindle — only the drawReason === 'stalemate' form. Never
 * generalized to repetition/50-move/other draws, which current data cannot
 * distinguish (Evaluation.drawReason only ever encodes 'stalemate').
 */
function stalemateSwindleSignals(
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  settings: StorySettings,
  beats: readonly StoryBeat[]
): ArchetypeSignal[] {
  if (analysis.plies.length === 0) return [];
  const finalPly = analysis.plies[analysis.plies.length - 1]!;
  const evalAfter = finalPly.evaluationAfter;
  if (evalAfter.kind !== 'terminal' || evalAfter.result !== 'draw' || evalAfter.drawReason !== 'stalemate') {
    return [];
  }

  // PlyAnalysis.sideToMove is "the side that played this ply" (the mover) —
  // i.e. exactly the side that delivered the stalemate, not the side left
  // with no legal moves.
  const stalematingColor = finalPly.sideToMove;
  const trajectory = understanding.gameArc.materialTrajectory;
  const beforePly = finalPly.ply - 1;
  const beforeEntry = trajectory.find((t) => t.ply === beforePly) ?? trajectory.find((t) => t.ply === finalPly.ply);
  if (!beforeEntry) return [];

  // materialDiff is White-relative; flip to "deficit for the stalemating side".
  const deficitForStalemator = stalematingColor === 'w' ? -beforeEntry.materialDiff : beforeEntry.materialDiff;
  if (deficitForStalemator < settings.swindleMaterialDeficitFloor) return [];

  const plies = [finalPly.ply];
  return [
    {
      archetype: 'stalemate-swindle',
      plies,
      beatIds: beatIdsOverlapping(plies, beats),
      evidence: {
        basis: 'chess-rule',
        sourcePlies: plies,
        note: `stalemate reached with a ${deficitForStalemator}-unit material deficit against the stalemating side`
      }
    }
  ];
}

/**
 * Phase 16 (MUST HAVE 6) — Stalemate Blunder: the WINNING side threw the win
 * away.
 *
 * This is the mirror of stalemateSwindleSignals above, and the two are
 * mutually exclusive by construction. Both measure the same quantity — the
 * stalemating side's material standing just before the final move — and test
 * it against a positive floor with opposite sign:
 *
 *   swindle  deficitForStalemator   >= swindleMaterialDeficitFloor   (behind)
 *   blunder  advantageForStalemator >= blunderMaterialAdvantageFloor (ahead)
 *
 * Since advantage === -deficit and both floors are positive, no position can
 * satisfy both. The distinction matters editorially, not just technically: a
 * swindle credits the side that was losing, so applying that word to a game
 * where the WINNING side stalemated its opponent would state the opposite of
 * what happened.
 *
 * Material advantage alone is deliberately NOT sufficient. A side can be a
 * rook up in a locked or genuinely drawn position, where a stalemate throws
 * away nothing at all; calling that a blunder would be a fabricated
 * accusation. So a corroborating EVALUATION advantage is also required, read
 * from the position immediately before the stalemating move — which is
 * exactly "was this side winning at the moment they threw it away". A mate
 * evaluation for the stalemating side is the strongest possible form of that
 * corroboration and is treated as such by toComparableCp's own scale.
 */
function stalemateBlunderSignals(
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  outcome: GameOutcome,
  settings: StorySettings,
  beats: readonly StoryBeat[]
): ArchetypeSignal[] {
  // GATE 0 is the authority on how the game ended.
  if (!outcome.onBoard || outcome.termination !== 'stalemate') return [];
  if (analysis.plies.length === 0) return [];

  const finalPly = analysis.plies[analysis.plies.length - 1]!;
  // PlyAnalysis.sideToMove is the side that PLAYED this ply — i.e. the side
  // that delivered the stalemate, not the side left without a legal move.
  const stalematingColor = finalPly.sideToMove;

  const trajectory = understanding.gameArc.materialTrajectory;
  const beforePly = finalPly.ply - 1;
  const beforeEntry = trajectory.find((t) => t.ply === beforePly) ?? trajectory.find((t) => t.ply === finalPly.ply);
  if (!beforeEntry) return [];

  // materialDiff is White-relative; flip to "advantage held by the stalemating side".
  const advantageForStalemator = stalematingColor === 'w' ? beforeEntry.materialDiff : -beforeEntry.materialDiff;
  if (advantageForStalemator < settings.blunderMaterialAdvantageFloor) return [];

  // Corroboration: the evaluation advantage this side actually HELD in the
  // run-up to the ending.
  //
  // Deliberately NOT the evaluation immediately before the final move. That
  // reading is structurally near-vacuous for this phenomenon: by the time a
  // stalemate is one move away the engine already sees the draw, so the
  // position scores ~0.00 precisely BECAUSE the win has already been thrown
  // away. Measuring there asks "is this side still winning after the
  // blunder?", whose answer is almost always no — which is the wrong
  // question. The requirement is that the side HAD a winning position, so
  // the measurement looks back over a short bounded window and takes the
  // best advantage it actually held there.
  //
  // The window is fixed and small: this is about the ending being thrown
  // away, not about an advantage held at some point earlier in the game.
  const windowStart = Math.max(1, finalPly.ply - STALEMATE_ADVANTAGE_WINDOW_PLIES);
  let evalForStalemator = -Infinity;
  for (const p of analysis.plies) {
    if (p.ply < windowStart || p.ply >= finalPly.ply) continue;
    if (p.evaluationAfter.kind === 'terminal') continue;
    const whiteRelativeCp = toComparableCp(p.evaluationAfter);
    const held = stalematingColor === 'w' ? whiteRelativeCp : -whiteRelativeCp;
    if (held > evalForStalemator) evalForStalemator = held;
  }
  if (evalForStalemator < settings.blunderEvalAdvantageFloor) return [];

  const plies = [finalPly.ply];
  return [
    {
      archetype: 'stalemate-blunder',
      plies,
      beatIds: beatIdsOverlapping(plies, beats),
      evidence: {
        basis: 'engine-eval',
        sourcePlies: plies,
        note: `stalemate delivered by the side holding a ${advantageForStalemator}-unit material advantage and ${evalForStalemator}cp evaluation advantage`
      }
    }
  ];
}

/**
 * Forced Trap — only the mechanically-traceable, forced-sequence-linked
 * form: an isSacrifice ply whose ForcedSequence resolves to a decisive
 * CauseConsequenceRecord.resolution. No slow/non-forced trap detector.
 */
function forcedTrapSignals(understanding: GameUnderstanding, beats: readonly StoryBeat[]): ArchetypeSignal[] {
  const signals: ArchetypeSignal[] = [];
  const seenSequenceIds = new Set<string>();

  for (const ps of understanding.plies) {
    if (!ps.signals.isSacrifice || !ps.signals.forcedSequenceId) continue;
    const seq = understanding.sequences.find((s) => s.id === ps.signals.forcedSequenceId);
    if (!seq || seenSequenceIds.has(seq.id)) continue;

    const resolvingTp = understanding.turningPoints.find(
      (tp) => tp.causeConsequence.multiMoveConsequence?.sequenceId === seq.id
    );
    if (!resolvingTp) continue;
    if (resolvingTp.causeConsequence.resolution !== 'decisive-advantage' && resolvingTp.causeConsequence.resolution !== 'forced-mate') {
      continue;
    }

    seenSequenceIds.add(seq.id);
    const plies = seq.plies;
    signals.push({
      archetype: 'forced-trap',
      plies,
      beatIds: beatIdsOverlapping(plies, beats),
      evidence: {
        basis: 'engine-eval',
        sourcePlies: plies,
        note: `sacrifice at ply ${ps.ply} led via sequence ${seq.id} to ${resolvingTp.causeConsequence.resolution}`
      }
    });
  }

  return signals;
}

/**
 * Phase 15 — which archetype, if any, is entitled to own the game's
 * headline.
 *
 * Previously every ArchetypeSignal was equal, and downstream layers each
 * re-derived a "primary" one from the bare list. That let a 112-ply
 * pawn-journey span take both the caption and the hook away from the central
 * conflict, in a game whose actual ending it did not touch.
 *
 * An archetype may lead only when it is demonstrably about the same events
 * as the selected story:
 *   1. its plies CONTAIN the selected story's trigger ply, and
 *   2. it PARTICIPATES in the selected story's own beats (beatIds non-empty).
 *
 * Both are structural set-membership tests over data that already exists —
 * no new detection, no confidence heuristic. Everything else is supporting,
 * which is not a demotion: a supporting archetype is still true, still
 * annotated, and still rendered.
 *
 * NOTE on condition 2. The approved design expressed this as "its evidence
 * reaches the PayoffTerminus", read literally as containing the payoff ply.
 * That test is unsatisfiable in practice for the archetypes that most
 * deserve to lead: forcedTrapSignals records a sacrifice's ForcedSequence
 * plies, and understanding/gameArc.ts already documents that "the mating
 * move itself is structurally never part of any ForcedSequence's own
 * plies". A double-rook-sacrifice-into-mate would therefore have been
 * demoted to supporting in favour of a bare "CHECKMATE" title — the
 * opposite of the intent. Beat participation expresses the same idea ("this
 * archetype is about the arc the story selected") in terms the data model
 * actually supports.
 */
export function resolveArchetypeRoles(
  signals: readonly ArchetypeSignal[],
  centralConflict: CentralConflict | null,
  outcome: GameOutcome
): { readonly leadArchetype: StoryArchetype | null; readonly supportingArchetypes: readonly StoryArchetype[] } {
  const all = [...new Set(signals.map((s) => s.archetype))].sort((a, b) => ARCHETYPE_ORDER[a] - ARCHETYPE_ORDER[b]);
  if (!centralConflict) {
    return { leadArchetype: null, supportingArchetypes: all };
  }

  // R1 — when the board and the recorded result disagree, the DISAGREEMENT
  // is the story. A game that finished drawn on the clock while one side
  // held a forced mate cannot honestly be titled after a pattern that ran
  // through it, however genuine that pattern is: the most surprising true
  // thing about the game is how it ended. No archetype leads here.
  if (boardContradictsResult(outcome)) {
    return { leadArchetype: null, supportingArchetypes: all };
  }

  const triggerPly = centralConflict.consequenceChain.triggerPly;

  // Among the qualifying signals, the winner is picked by the one existing
  // archetype priority table — never a new hook- or caption-specific rule.
  const qualifying = signals
    .filter((signal) => signal.plies.includes(triggerPly) && signal.beatIds.length > 0)
    .sort((a, b) => ARCHETYPE_ORDER[a.archetype] - ARCHETYPE_ORDER[b.archetype]);

  const lead = qualifying[0];
  if (!lead) return { leadArchetype: null, supportingArchetypes: all };
  return {
    leadArchetype: lead.archetype,
    supportingArchetypes: all.filter((a) => a !== lead.archetype)
  };
}

const ARCHETYPE_ORDER: Readonly<Record<StoryArchetype, number>> = {
  'forced-trap': 0,
  'king-hunt': 1,
  'pawn-journey': 2,
  'stalemate-swindle': 3,
  // A thrown-away win is the least "genre" of the archetypes and the most
  // situational, so it sorts last — it never outranks a pattern that ran
  // through the whole game.
  'stalemate-blunder': 4
};

/** Deterministic order: archetype name (fixed, alphabetical), then first ply ascending — a stable serialization order, not an editorial ranking. */
export function buildArchetypeSignals(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  outcome: GameOutcome,
  settings: StorySettings,
  beats: readonly StoryBeat[]
): readonly ArchetypeSignal[] {
  const all = [
    ...kingHuntSignals(understanding, beats),
    ...pawnJourneySignals(game, understanding, settings, beats),
    ...stalemateSwindleSignals(analysis, understanding, settings, beats),
    ...stalemateBlunderSignals(analysis, understanding, outcome, settings, beats),
    ...forcedTrapSignals(understanding, beats)
  ];

  return all.sort((a, b) => {
    const orderDiff = ARCHETYPE_ORDER[a.archetype] - ARCHETYPE_ORDER[b.archetype];
    if (orderDiff !== 0) return orderDiff;
    return (a.plies[0] ?? 0) - (b.plies[0] ?? 0);
  });
}
