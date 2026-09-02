import type { PlyAnalysis } from '../analysis/types';
import type { CauseConsequenceRecord, Evidence, ForcedSequence, TacticalMotifInstance, ThreatRecord } from './types';
import { boardFromFen, coordsOf } from './geometry';

/**
 * Phase 15 — mechanism verification.
 *
 * The problem this replaces: pickMechanism used to return
 * `motifsForPly[0]!.motif` — whichever tactical pattern happened to come
 * first in board-scan order — with no test that the pattern had anything to
 * do with the move. Real games produced "a battery led to..." for a bishop
 * retreat that stood next to four batteries it did not create, and "a skewer
 * led to..." for a rook move whose skewer was never converted.
 *
 * A mechanism may now only be named when the data proves it MATERIALLY
 * PARTICIPATED, via four tests that each require no chess judgement:
 *
 *   V1 ANCHORING   the motif's geometry touches the squares this move used
 *   V2 NOVELTY     the pattern is genuinely new on this ply, not pre-existing
 *   V3 REALIZATION a target was actually captured, or its occupant was forced
 *                  to move, inside the forced window this move opened
 *   V4 NECESSITY   no threat OUTSIDE the motif's target set can account for
 *                  the consequence — so the motif is the only explanation on
 *                  offer
 *
 * A motif is named only when V1 AND V2 AND (V3 OR V4).
 *
 * Deliberately NOT consulted: significanceEvidence. It is a same-ply,
 * uniformly-applied swing check (motifs.ts's confirmMotifSignificance), not
 * a per-motif relevance check — it fires on bystander motifs and misses on
 * genuine forced-mate mechanisms, so it disagrees with causation in both
 * directions.
 *
 * Deliberately NOT used: ply proximity. "The motif was near the move" is the
 * exact reasoning that produced the fabrications.
 */

export type Mechanism = CauseConsequenceRecord['mechanism'];

export type MechanismTest = 'V1' | 'V2' | 'V3' | 'V4';

export interface MechanismVerification {
  /** null whenever nothing could be verified — never a guess, never a fallback motif. */
  readonly mechanism: Mechanism;
  /** True when `mechanism` is non-null AND was established by evidence rather than assumed. */
  readonly verified: boolean;
  /** The motif instance that passed, when the mechanism is motif-sourced. */
  readonly motifId?: string;
  readonly passedTests: readonly MechanismTest[];
  readonly evidence: Evidence;
}

/** Mover-relative swing magnitude below which no 'positional' claim is made. Unchanged from pickMechanism. */
const POSITIONAL_SWING_FLOOR = 50;
/** Consequence magnitudes at which V4 has something to explain at all. */
const NECESSITY_MATERIAL_FLOOR = 200;
const NECESSITY_EVAL_FLOOR = 150;

export interface MechanismInputs {
  readonly ply: PlyAnalysis;
  readonly motifsForPly: readonly TacticalMotifInstance[];
  readonly threatsCreatedHere: readonly ThreatRecord[];
  readonly sequence: ForcedSequence | undefined;
  readonly allPliesByNumber: ReadonlyMap<number, PlyAnalysis>;
  readonly deliversCheck: boolean;
  readonly deliversMate: boolean;
  /** Mover-relative material change measured at the consequence ply. */
  readonly materialNetForMover: number;
  /** Mover-relative evaluation change measured at the consequence ply. */
  readonly swingAtConsequence: number;
}

/**
 * V1 — the motif's own geometry is anchored to a square this move actually
 * used. This is the existing mechanismInvolvesMovedPiece rule from
 * state/moments.ts, moved upstream and applied per candidate motif rather
 * than only to motifsTriggered[0].
 */
export function anchoredToMove(motif: TacticalMotifInstance, moveUci: string): boolean {
  const from = moveUci.slice(0, 2);
  const to = moveUci.slice(2, 4);
  return motif.squares.attacker === from || motif.squares.attacker === to || motif.squares.targets.includes(to);
}

/** V2 — the pattern did not already exist before this ply. */
export function isNovelOnPly(motif: TacticalMotifInstance): boolean {
  return motif.firstSeenPly === motif.ply;
}

/**
 * The plies during which this move's consequence plays out: its own forced
 * sequence when it opened one, otherwise just the immediate reply. Bounded
 * by real structure (ForcedSequence), never by an arbitrary lookahead.
 */
function realizationWindow(inputs: MechanismInputs): readonly number[] {
  const { ply, sequence } = inputs;
  if (sequence) return sequence.plies.filter((p) => p > ply.ply);
  return [ply.ply + 1];
}

/**
 * V3 — at least one of the motif's target squares is captured, or the piece
 * standing on it is compelled to move, inside the realization window.
 *
 * "Captured" is checked structurally: a move landing on the target square
 * whose destination was occupied in that move's own fenBefore. "Compelled to
 * move" requires the window to be a forced sequence — a piece leaving a
 * square of its own free will is not evidence the motif did anything.
 */
export function isRealized(motif: TacticalMotifInstance, inputs: MechanismInputs): boolean {
  const targets = new Set(motif.squares.targets);
  const window = realizationWindow(inputs);
  const windowIsForced = inputs.sequence !== undefined;

  for (const plyNumber of window) {
    const laterPly = inputs.allPliesByNumber.get(plyNumber);
    if (!laterPly) continue;
    const from = laterPly.movePlayedUci.slice(0, 2);
    const to = laterPly.movePlayedUci.slice(2, 4);

    if (targets.has(to)) {
      const boardBefore = boardFromFen(laterPly.fenBefore);
      const { r, f } = coordsOf(to);
      if (boardBefore[r]?.[f]) return true;
    }
    if (windowIsForced && targets.has(from)) return true;
  }
  return false;
}

/**
 * V4 — necessity. There is a real consequence to explain, at least one
 * threat created here lands on the motif's own target set, and NO threat
 * created here lands anywhere else. If some other threat could account for
 * the consequence, this motif is not the necessary explanation and must not
 * be named as one.
 */
export function isNecessary(motif: TacticalMotifInstance, inputs: MechanismInputs): boolean {
  const hasConsequence =
    Math.abs(inputs.materialNetForMover) >= NECESSITY_MATERIAL_FLOOR || Math.abs(inputs.swingAtConsequence) >= NECESSITY_EVAL_FLOOR;
  if (!hasConsequence) return false;

  const targets = new Set(motif.squares.targets);
  const onMotifTargets = inputs.threatsCreatedHere.filter((t) => targets.has(t.targetSquare));
  const elsewhere = inputs.threatsCreatedHere.filter((t) => !targets.has(t.targetSquare));
  return onMotifTargets.length > 0 && elsewhere.length === 0;
}

function unverified(note: string, ply: number): MechanismVerification {
  return {
    mechanism: null,
    verified: false,
    passedTests: [],
    evidence: { basis: 'chess-rule', sourcePlies: [ply], note }
  };
}

/**
 * The one mechanism decision per ply.
 *
 * When motifs exist on the ply, one of them must pass verification or the
 * mechanism is null. It deliberately does NOT fall back to 'positional' in
 * that case: having found candidate mechanisms and disproved them, replacing
 * them with a vaguer claim derived from swing alone would substitute one
 * unsupported statement for another.
 *
 * When NO motif exists on the ply, the non-motif ladder applies unchanged
 * from the original pickMechanism: 'king-safety' rests on deliversCheck /
 * deliversMate, which are hard chess-rule facts, and 'positional' on a swing
 * floor. No motif claim was ever made in that branch, so there is nothing to
 * verify and nothing to withdraw.
 */
export function verifyMechanism(inputs: MechanismInputs): MechanismVerification {
  const { ply, motifsForPly, deliversCheck, deliversMate } = inputs;

  if (motifsForPly.length === 0) {
    if (deliversCheck || deliversMate) {
      return {
        mechanism: 'king-safety',
        verified: true,
        passedTests: [],
        evidence: {
          basis: 'chess-rule',
          sourcePlies: [ply.ply],
          note: deliversMate ? 'move delivers mate' : 'move delivers check'
        }
      };
    }
    if (Math.abs(ply.swingForMoverCp) >= POSITIONAL_SWING_FLOOR) {
      return {
        mechanism: 'positional',
        verified: true,
        passedTests: [],
        evidence: {
          basis: 'engine-eval',
          sourcePlies: [ply.ply],
          note: `no tactical motif on this ply; swingForMoverCp=${ply.swingForMoverCp}`
        }
      };
    }
    return unverified('no tactical motif and no check/swing basis for any mechanism', ply.ply);
  }

  for (const motif of motifsForPly) {
    const passed: MechanismTest[] = [];
    if (!anchoredToMove(motif, ply.movePlayedUci)) continue;
    passed.push('V1');
    if (!isNovelOnPly(motif)) continue;
    passed.push('V2');

    const realized = isRealized(motif, inputs);
    const necessary = isNecessary(motif, inputs);
    if (realized) passed.push('V3');
    if (necessary) passed.push('V4');
    if (!realized && !necessary) continue;

    return {
      mechanism: motif.motif,
      verified: true,
      motifId: motif.id,
      passedTests: passed,
      evidence: {
        basis: 'chess-rule',
        sourcePlies: [ply.ply],
        note: `${motif.motif} ${motif.motifInstanceKey} verified by ${passed.join('+')}`
      }
    };
  }

  return unverified(
    `${motifsForPly.length} motif(s) on this ply, none passed V1+V2+(V3|V4) — mechanism withheld`,
    ply.ply
  );
}
