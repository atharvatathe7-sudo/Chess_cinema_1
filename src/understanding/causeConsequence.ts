import type { Color } from '../chess/ChessEngine';
import type { Evaluation, MultiPvResult, PlyAnalysis } from '../analysis/types';
import { toComparableCp } from '../analysis/evaluation';
import type {
  AlternativeLine,
  BestAlternativeRecord,
  CauseConsequenceRecord,
  ForcedSequence,
  ForcingReason,
  PlySignals,
  SignificanceRecord,
  TacticalMotifInstance,
  ThreatRecord,
  TurningPoint,
  TurningPointKind
} from './types';
import { boardFromFen, materialBalance } from './geometry';
import { verifyMechanism } from './mechanismVerification';

function moverRelativeCp(evaluation: Evaluation, mover: Color): number {
  const white = toComparableCp(evaluation);
  return mover === 'w' ? white : -white;
}

/**
 * BestAlternativeRecord, per Revision 3 §5.1. topMove/topMoveEvaluation/
 * playedMoveWasTopMove/playedMoveEffectivelyEquivalent are all direct reads
 * of data Phase 2.1 already computed — zero engine cost. Only
 * bestMoveUniqueness/alternativesConsidered need MultiPV, and only when the
 * caller actually has it (this ply was inside the shared follow-up budget);
 * otherwise uniqueness is honestly 'unknown', never assumed.
 */
export function buildBestAlternativeRecord(
  ply: PlyAnalysis,
  matchesEngineBest: boolean,
  multiPv: MultiPvResult | undefined,
  equivalenceEpsilonCp: number
): BestAlternativeRecord {
  const topMove = ply.bestMove !== null ? { uci: ply.bestMove, principalVariation: ply.principalVariation } : null;
  const playedMoveEffectivelyEquivalent = ply.swingForMoverCp >= -equivalenceEpsilonCp;

  let bestMoveUniqueness: BestAlternativeRecord['bestMoveUniqueness'] = 'unknown';
  let alternativesConsidered: AlternativeLine[] = [];

  if (multiPv && multiPv.lines.length > 0) {
    const top = multiPv.lines[0]!;
    const topMoverCp = moverRelativeCp(top.evaluation, ply.sideToMove);
    alternativesConsidered = multiPv.lines.map((line) => ({
      rank: line.rank,
      moveUci: line.move,
      principalVariation: line.principalVariation,
      evaluation: line.evaluation,
      deltaFromTopCp: Math.max(0, topMoverCp - moverRelativeCp(line.evaluation, ply.sideToMove))
    }));
    if (multiPv.lines.length >= 2) {
      const second = multiPv.lines[1]!;
      const deltaSecond = Math.max(0, topMoverCp - moverRelativeCp(second.evaluation, ply.sideToMove));
      bestMoveUniqueness = deltaSecond > equivalenceEpsilonCp ? 'unique' : 'shared';
    }
  }

  return {
    topMove,
    topMoveEvaluation: ply.evaluationBefore,
    playedMoveWasTopMove: matchesEngineBest,
    playedMoveEffectivelyEquivalent,
    bestMoveUniqueness,
    alternativesConsidered,
    evidence: {
      basis: 'engine-eval',
      sourcePlies: [ply.ply],
      note:
        alternativesConsidered.length > 0
          ? `multipv considered ${alternativesConsidered.length} line(s)`
          : 'no multipv data for this ply — outside the follow-up budget'
    }
  };
}

/**
 * Phase 15 — every resolution label now requires evidence of its OWN kind,
 * not merely a large evaluation swing.
 *
 * The bug this fixes: 'repelled' was assigned from
 * `moverRelativeSwingAtConsequence <= -100` alone. A move that LOSES half a
 * queen produces exactly that number, so outright blunders were labelled
 * "the threat being repelled" — a defensive claim that the record's own
 * threatsRemoved actively contradicted. state/moments.ts had to carry a
 * caption-time patch (resolutionIsUnsupported) to suppress the phrase after
 * the fact; that check is promoted here into a precondition on the value
 * itself, so no consumer can ever see an uncorroborated 'repelled' again.
 *
 * Each label's required corroboration:
 *   forced-mate        terminal mate for the mover, or a mate evaluation at
 *                      the consequence that favours the mover
 *   drawn              terminal draw (checked before the swing bands: a
 *                      stalemate save reads as a large POSITIVE swing and
 *                      would otherwise mislabel a draw as a decisive win)
 *   decisive-advantage the evaluation itself moved decisively for the mover
 *   material-gain      a real mover-relative material gain at the consequence
 *   repelled           at least one threat was actually removed
 *   unresolved         the existing safe fallback — asserts nothing
 */
/**
 * Mover-relative swing at which a "defensive success" reading stops being
 * honest: roughly three pawns lost by the side that moved.
 */
const COLLAPSE_CP = -300;

export interface ResolutionCorroboration {
  readonly threatsRemovedCount: number;
  /** True when a mate exists at the consequence and it favours the mover. */
  readonly mateFavoursMoverAtConsequence: boolean;
}

function resolutionFor(
  moverRelativeSwingAtConsequence: number,
  materialNetForMover: number,
  endsInMateForMover: boolean,
  endsInDraw: boolean,
  corroboration: ResolutionCorroboration
): CauseConsequenceRecord['resolution'] {
  if (endsInMateForMover || corroboration.mateFavoursMoverAtConsequence) return 'forced-mate';
  if (endsInDraw) return 'drawn';
  if (moverRelativeSwingAtConsequence >= 300) return 'decisive-advantage';
  if (materialNetForMover >= 200) return 'material-gain';
  // 'repelled' describes a defensive success. Removing a threat is the
  // necessary evidence, but it is not sufficient: when the same move also
  // collapses the mover's own position, the defensive fact is no longer the
  // dominant one, and narrating only it produces exactly the reassuring,
  // false explanation this phase exists to remove ("the threat being
  // repelled" for a move that hands the game away). Beyond COLLAPSE_CP the
  // record has two facts and cannot honestly assert either as THE
  // resolution, so it asserts neither.
  if (moverRelativeSwingAtConsequence <= -100 && moverRelativeSwingAtConsequence > COLLAPSE_CP && corroboration.threatsRemovedCount > 0) {
    return 'repelled';
  }
  return 'unresolved';
}

/**
 * Whether a mate on the board at the consequence belongs to the mover.
 * Evaluations are white-relative (see analysis/types.ts), so a positive
 * mateIn is White's mate.
 */
function mateFavoursMover(evaluation: Evaluation, mover: Color): boolean {
  if (evaluation.kind !== 'mate') return false;
  return mover === 'w' ? evaluation.mateIn > 0 : evaluation.mateIn < 0;
}

export interface CauseConsequenceInputs {
  readonly ply: PlyAnalysis;
  readonly signals: PlySignals;
  readonly motifsForPly: readonly TacticalMotifInstance[];
  readonly threatsCreatedHere: readonly ThreatRecord[];
  readonly threatsResolvedHere: readonly ThreatRecord[];
  readonly bestAlternative: BestAlternativeRecord;
  readonly reply: PlyAnalysis | undefined;
  readonly forcingReason: ForcingReason | null;
  readonly sequence: ForcedSequence | undefined;
  /** The last ply of the game (for clamping consequence lookahead), and every ply, for the sequence-end lookup. */
  readonly allPliesByNumber: ReadonlyMap<number, PlyAnalysis>;
}

/** Assembles the full explanation pattern in structured fields — never prose. See types.ts's NO NATURAL LANGUAGE note. */
export function buildCauseConsequenceRecord(inputs: CauseConsequenceInputs): CauseConsequenceRecord {
  const { ply, signals, motifsForPly, threatsCreatedHere, threatsResolvedHere, bestAlternative, reply, forcingReason, sequence, allPliesByNumber } =
    inputs;

  const boardBefore = boardFromFen(ply.fenBefore);
  const boardAfter = boardFromFen(ply.fenAfter);
  const materialDelta = materialBalance(boardAfter) - materialBalance(boardBefore);

  const consequenceEndPly = sequence ? sequence.endPly : ply.ply;
  const consequencePly = allPliesByNumber.get(consequenceEndPly) ?? ply;
  const consequenceBoard = boardFromFen(consequencePly.fenAfter);
  const startBoard = boardFromFen(ply.fenBefore);

  const swingAtConsequence = moverRelativeCp(consequencePly.evaluationAfter, ply.sideToMove) - moverRelativeCp(ply.evaluationBefore, ply.sideToMove);
  const materialNetForMover =
    ply.sideToMove === 'w'
      ? materialBalance(consequenceBoard) - materialBalance(startBoard)
      : -(materialBalance(consequenceBoard) - materialBalance(startBoard));
  const endsInMateForMover =
    consequencePly.evaluationAfter.kind === 'terminal' &&
    ((ply.sideToMove === 'w' && consequencePly.evaluationAfter.result === 'white-wins') ||
      (ply.sideToMove === 'b' && consequencePly.evaluationAfter.result === 'black-wins'));
  const endsInDraw = consequencePly.evaluationAfter.kind === 'terminal' && consequencePly.evaluationAfter.result === 'draw';

  // Phase 15 — the mechanism is verified here, upstream of every consumer,
  // so no selector or caption can ever see an unverified one.
  const mechanismVerification = verifyMechanism({
    ply,
    motifsForPly,
    threatsCreatedHere,
    sequence,
    allPliesByNumber,
    deliversCheck: signals.deliversCheck,
    deliversMate: signals.deliversMate,
    materialNetForMover,
    swingAtConsequence
  });

  return {
    id: `cc-${ply.ply}`,
    ply: ply.ply,
    positionBefore: ply.fenBefore,
    movePlayed: { san: ply.movePlayedSan, uci: ply.movePlayedUci },
    immediateChange: {
      evaluationDelta: { swingCp: ply.swingCp, swingForMoverCp: ply.swingForMoverCp },
      materialDelta,
      motifsTriggered: motifsForPly.map((m) => m.id)
    },
    threatsCreated: threatsCreatedHere.map((t) => t.id),
    threatsRemoved: threatsResolvedHere.map((t) => t.id),
    mechanism: mechanismVerification.mechanism,
    mechanismVerified: mechanismVerification.verified,
    ...(mechanismVerification.motifId !== undefined ? { mechanismMotifId: mechanismVerification.motifId } : {}),
    bestAlternative,
    ...(reply
      ? {
          opponentResponse: {
            ply: reply.ply,
            san: reply.movePlayedSan,
            wasForced: forcingReason !== null,
            ...(forcingReason !== null ? { forcingReason } : {})
          }
        }
      : {}),
    evaluationConsequence: { atPly: consequenceEndPly, swingCp: swingAtConsequence },
    materialConsequence: { atPly: consequenceEndPly, netMaterialChange: materialNetForMover },
    ...(sequence ? { multiMoveConsequence: { sequenceId: sequence.id, endPly: sequence.endPly } } : {}),
    resolution: resolutionFor(swingAtConsequence, materialNetForMover, endsInMateForMover, endsInDraw, {
      threatsRemovedCount: threatsResolvedHere.length,
      mateFavoursMoverAtConsequence: mateFavoursMover(consequencePly.evaluationAfter, ply.sideToMove)
    }),
    evidence: {
      basis: 'engine-eval',
      sourcePlies: sequence ? sequence.plies : [ply.ply],
      note: `assembled from ply ${ply.ply}${sequence ? ` through sequence ${sequence.id} ending at ply ${sequence.endPly}` : ''}; mechanism ${mechanismVerification.mechanism ?? 'withheld'}`
    }
  };
}

function turningPointKindFor(ply: PlyAnalysis, cc: CauseConsequenceRecord): TurningPointKind | null {
  if (ply.mateTransition === 'mate-appeared') return 'mate-appeared';
  if (ply.mateTransition === 'mate-flipped') return 'mate-flipped';
  if (ply.mateTransition === 'mate-disappeared') return 'mate-disappeared';
  if (cc.resolution === 'forced-mate') return 'forced-mate-delivery';
  if (Math.abs(cc.materialConsequence.netMaterialChange) >= 300 && cc.resolution !== 'unresolved') return 'irreversible-material-loss';
  if (cc.bestAlternative.bestMoveUniqueness === 'unique' && ply.swingForMoverCp >= -10) return 'brilliant-defense';
  if (Math.abs(ply.swingCp) >= 100) return 'decisive-swing';
  return null;
}

export function buildTurningPoint(
  ply: PlyAnalysis,
  cc: CauseConsequenceRecord,
  significance: SignificanceRecord
): TurningPoint | null {
  const kind = turningPointKindFor(ply, cc);
  if (!kind) return null;
  return {
    id: `tp-${ply.ply}`,
    ply: ply.ply,
    kind,
    significance,
    causeConsequence: cc
  };
}
