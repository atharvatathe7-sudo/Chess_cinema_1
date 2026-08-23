import type { PlyAnalysis } from '../analysis/types';
import type { ForcedSequence, GameArcSummary, NarrativeArchetypeSignal, TurningPoint } from './types';
import { boardFromFen, materialBalance, totalMaterial } from './geometry';

/**
 * Structural game arc: deterministic, chess-rule evidence only. No move
 * duration, no camera bounding box, no narrative selection — see the
 * reference-material disposition notes carried over from the design
 * specification for why those stay out of this layer.
 */

const OPENING_PLY_CEILING = 24; // ~12 full moves, a defensible fixed fallback
const ENDGAME_MATERIAL_FLOOR = 2600; // total non-king material (both sides) below this reads as an endgame

export function computeGameArc(plies: readonly PlyAnalysis[]): GameArcSummary {
  const materialTrajectory = plies.map((p) => ({
    ply: p.ply,
    materialDiff: materialBalance(boardFromFen(p.fenAfter))
  }));

  const openingEndPly = Math.min(OPENING_PLY_CEILING, plies.length);

  let middlegameEndPly = plies.length;
  for (const p of plies) {
    if (totalMaterial(boardFromFen(p.fenAfter)) < ENDGAME_MATERIAL_FLOOR) {
      middlegameEndPly = p.ply;
      break;
    }
  }
  middlegameEndPly = Math.max(middlegameEndPly, openingEndPly);

  return {
    openingEndPly,
    middlegameEndPly,
    materialTrajectory,
    evidence: {
      basis: 'chess-rule',
      sourcePlies: plies.map((p) => p.ply),
      note: `opening ceiling ${OPENING_PLY_CEILING} plies; endgame material floor ${ENDGAME_MATERIAL_FLOOR}`
    }
  };
}

/**
 * Groups consecutive ForcedSequences whose forcingReason is 'check' when one
 * ends exactly where the next begins (endPly + 1 === startPly) AND the new
 * sequence's own checking move belongs to the same side that started the
 * group. This is the real shape a continuous alternating-check king hunt
 * takes once detectForcedSequences's own chaining rules (Phase 2.2,
 * unmodified here) split it: a king's escape reply is never itself
 * "forcing" by forcingReasonForReply's own definition, so each fresh check
 * starts a new, short ForcedSequence rather than extending the previous
 * one. Grouping by exact adjacency recovers the underlying continuous run
 * from that existing evidence alone — never by ply proximity in general,
 * never across a non-check sequence, and never across a gap.
 *
 * The same-side check matters because ply adjacency ALONE is not
 * sufficient evidence of one continuous hunt: a ForcedSequence's own
 * plies.length can be odd (e.g. check, forced reply, one more forcing
 * move — a real shape, confirmed against the Evergreen Game's own
 * sequence-3 = [33,34,35]), in which case its endPly belongs to the
 * CHECKING side itself, not the opponent — so the very next ply belongs to
 * the OPPONENT, and an adjacent check-type sequence starting there would be
 * the opponent's own, unrelated counter-attack, not a continuation of the
 * same hunt. ForcedSequence carries no side field, so side is derived from
 * ply parity relative to the group's own first sequence — both sides
 * strictly alternate every ply in any legal game, so this is exact, not a
 * heuristic.
 */
function groupAdjacentCheckSequences(sequences: readonly ForcedSequence[]): ForcedSequence[][] {
  const checkSequences = sequences
    .filter((s) => s.forcingReason === 'check')
    .slice()
    .sort((a, b) => a.startPly - b.startPly);

  const groups: ForcedSequence[][] = [];
  for (const seq of checkSequences) {
    const lastGroup = groups[groups.length - 1];
    const lastSeq = lastGroup?.[lastGroup.length - 1];
    const isAdjacent = lastSeq !== undefined && seq.startPly === lastSeq.endPly + 1;
    const isSameCheckingSide = lastGroup !== undefined && (seq.startPly - lastGroup[0]!.startPly) % 2 === 0;
    if (isAdjacent && isSameCheckingSide) {
      lastGroup!.push(seq);
    } else {
      groups.push([seq]);
    }
  }
  return groups;
}

/**
 * Narrative archetype signals — always plural, always confidence < 1, built
 * only from concrete evidence already computed elsewhere (ForcedSequence,
 * TurningPoint). This is deliberately a minimal, extensible starting set,
 * not an exhaustive catalogue of the reference material's five archetypes:
 * Phase 2.2's job is to surface reliably-derivable signals, not to pick a
 * genre. See the Phase 2.2 specification's reference-material disposition
 * notes for what was explicitly rejected or deferred.
 */
export function computeNarrativeSignals(
  sequences: readonly ForcedSequence[],
  turningPoints: readonly TurningPoint[]
): NarrativeArchetypeSignal[] {
  const signals: NarrativeArchetypeSignal[] = [];

  const groups = groupAdjacentCheckSequences(sequences);

  const kingHuntGroup = groups.find((group) => {
    const mergedPlies = group.flatMap((s) => s.plies);
    if (mergedPlies.length < 4) return false;

    if (group.length === 1) {
      // Exactly the original, single-sequence condition — preserved
      // byte-for-byte so no previously-passing case changes behavior.
      const seq = group[0]!;
      return turningPoints.some((tp) => tp.ply === seq.endPly && (tp.kind === 'forced-mate-delivery' || tp.kind === 'mate-appeared'));
    }

    // A genuinely merged, multi-sequence run: the mating move itself is
    // structurally never part of any ForcedSequence's own plies (a king's
    // last forced reply never "forces" the delivering move that follows
    // it), so requiring the mate-related turning point to land on the
    // merged run's own final ply would never be satisfiable for a real
    // alternating-check king hunt. Instead, the run qualifies if the
    // mate-related turning point falls anywhere within the plies this
    // evidence actually covers.
    const pliesSet = new Set(mergedPlies);
    return turningPoints.some((tp) => pliesSet.has(tp.ply) && (tp.kind === 'forced-mate-delivery' || tp.kind === 'mate-appeared'));
  });

  if (kingHuntGroup) {
    const mergedPlies = kingHuntGroup.flatMap((s) => s.plies);
    signals.push({
      archetype: 'king-hunt',
      supportingEvidence: [
        ...kingHuntGroup.map((s) => s.evidence),
        {
          basis: 'inference',
          confidence: 0.55,
          sourcePlies: mergedPlies,
          note:
            kingHuntGroup.length === 1
              ? 'a forced check sequence of 4+ plies ending in mate'
              : `${kingHuntGroup.length} adjacent forced check sequences (${mergedPlies.length} plies total) forming one continuous checking run ending in mate`
        }
      ],
      confidence: 0.55
    });
  }

  return signals;
}
