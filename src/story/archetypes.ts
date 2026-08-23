import type { GameAnalysis } from '../analysis/types';
import type { GameRecord } from '../pgn/types';
import type { GameUnderstanding } from '../understanding/types';
import type { ArchetypeSignal, StoryArchetype, StoryBeat, StorySettings } from './types';

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
    signals.push({
      archetype: 'king-hunt',
      plies,
      beatIds: beatIdsOverlapping(plies, beats),
      evidence: signal.supportingEvidence[0]!
    });
  }
  return signals;
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

const ARCHETYPE_ORDER: Readonly<Record<StoryArchetype, number>> = {
  'forced-trap': 0,
  'king-hunt': 1,
  'pawn-journey': 2,
  'stalemate-swindle': 3
};

/** Deterministic order: archetype name (fixed, alphabetical), then first ply ascending — a stable serialization order, not an editorial ranking. */
export function buildArchetypeSignals(
  game: GameRecord,
  analysis: GameAnalysis,
  understanding: GameUnderstanding,
  settings: StorySettings,
  beats: readonly StoryBeat[]
): readonly ArchetypeSignal[] {
  const all = [
    ...kingHuntSignals(understanding, beats),
    ...pawnJourneySignals(game, understanding, settings, beats),
    ...stalemateSwindleSignals(analysis, understanding, settings, beats),
    ...forcedTrapSignals(understanding, beats)
  ];

  return all.sort((a, b) => {
    const orderDiff = ARCHETYPE_ORDER[a.archetype] - ARCHETYPE_ORDER[b.archetype];
    if (orderDiff !== 0) return orderDiff;
    return (a.plies[0] ?? 0) - (b.plies[0] ?? 0);
  });
}
