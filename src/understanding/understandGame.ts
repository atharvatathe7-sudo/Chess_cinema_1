import type { GameAnalysis } from '../analysis/types';
import type { AnalysisEngine } from '../analysis/AnalysisEngine';
import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { analysisCancelledError } from '../analysis/analysisErrors';
import {
  DEFAULT_UNDERSTANDING_SETTINGS,
  UNDERSTANDING_SCHEMA_VERSION,
  type GameUnderstanding,
  type PlySemantics,
  type PlySignals,
  type ThreatRecord,
  type TurningPoint,
  type UnderstandingSettings
} from './types';
import { computeBaseSignals, qualityClassFor } from './quality';
import { detectMotifs } from './motifs';
import { detectThreats } from './threats';
import { detectForcedSequences, forcingReasonForReply } from './sequences';
import { computeSignificance, withAdditionalReason } from './significance';
import { runFollowUpQueries } from './followUpBudget';
import { buildBestAlternativeRecord, buildCauseConsequenceRecord, buildTurningPoint } from './causeConsequence';
import { computeGameArc, computeNarrativeSignals } from './gameArc';
import { boardFromFen, materialBalance } from './geometry';

/**
 * Top-level Phase 2.2 orchestration: (GameRecord's own GameAnalysis) ->
 * GameUnderstanding. Consumes Phase 2.1's output only — it does not
 * re-run the per-position analysis loop, does not touch the Renderer,
 * Timeline, or AppState, and calls the AnalysisEngine only for the
 * bounded MultiPV follow-up (see followUpBudget.ts). Everything else is
 * pure, deterministic orchestration over data Phase 2.1 already computed
 * plus this module's own chess-rule geometry.
 */

export interface UnderstandGameOptions {
  readonly settings?: UnderstandingSettings;
  /** Same isCancelled polling convention analyzeGame.ts already uses — no new cancellation mechanism. */
  readonly isCancelled?: () => boolean;
}

export async function understandGame(
  analysis: GameAnalysis,
  engine: AnalysisEngine,
  options: UnderstandGameOptions = {}
): Promise<Result<GameUnderstanding, AppError>> {
  const settings = options.settings ?? DEFAULT_UNDERSTANDING_SETTINGS;
  const plies = analysis.plies;

  if (plies.length === 0) {
    return ok({
      schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
      plies: [],
      motifs: [],
      threats: [],
      sequences: [],
      turningPoints: [],
      gameArc: computeGameArc([]),
      narrativeSignals: [],
      settings
    });
  }

  if (options.isCancelled?.()) return err(analysisCancelledError());

  // Deterministic, engine-free passes over the whole game first.
  const motifs = detectMotifs(plies, settings.minMaterialValueForMotif);
  const threats = detectThreats(plies);
  const sequences = detectForcedSequences(plies);

  // The one bounded, budgeted engine follow-up — MultiPV only, at a
  // deterministically pre-selected subset of positions.
  const followUp = await runFollowUpQueries(plies, engine, settings.engineBudget, options.isCancelled);
  if (!followUp.ok) return err(followUp.error);
  const multiPvByPly = followUp.value.multiPvByPly;

  const pliesByNumber = new Map(plies.map((p) => [p.ply, p]));
  const sequenceByPly = new Map<number, (typeof sequences)[number]>();
  for (const seq of sequences) for (const p of seq.plies) sequenceByPly.set(p, seq);
  const sequenceTerminalPlies = new Set(sequences.map((s) => s.endPly));

  function pushInto<T>(map: Map<number, T[]>, key: number, value: T): void {
    const existing = map.get(key);
    if (existing) {
      existing.push(value);
    } else {
      map.set(key, [value]);
    }
  }

  const motifsByPly = new Map<number, typeof motifs>();
  for (const m of motifs) pushInto(motifsByPly, m.ply, m);

  const threatsCreatedByPly = new Map<number, ThreatRecord[]>();
  const threatsResolvedByPly = new Map<number, ThreatRecord[]>();
  for (const t of threats) {
    pushInto(threatsCreatedByPly, t.ply, t);
    if (t.refutedBy) pushInto(threatsResolvedByPly, t.refutedBy.ply, t);
  }

  const plySemantics: PlySemantics[] = [];
  const turningPoints: TurningPoint[] = [];

  for (const ply of plies) {
    if (options.isCancelled?.()) return err(analysisCancelledError());

    const base = computeBaseSignals(ply);
    const motifsForPly = motifsByPly.get(ply.ply) ?? [];
    const sequenceForPly = sequenceByPly.get(ply.ply);
    const threatsCreatedHere = threatsCreatedByPly.get(ply.ply) ?? [];
    const threatsResolvedHere = threatsResolvedByPly.get(ply.ply) ?? [];

    const signals: PlySignals = {
      ...base,
      motifIds: motifsForPly.map((m) => m.id),
      ...(sequenceForPly ? { forcedSequenceId: sequenceForPly.id } : {}),
      isTurningPoint: false
    };

    const qualityClass = qualityClassFor(ply);

    const multiPv = multiPvByPly.get(ply.ply);
    const bestAlternative = buildBestAlternativeRecord(ply, base.matchesEngineBest, multiPv, settings.equivalenceEpsilonCp);

    const reply = pliesByNumber.get(ply.ply + 1);
    const forcingReason = reply ? forcingReasonForReply(ply, reply) : null;

    const boardBefore = boardFromFen(ply.fenBefore);
    const boardAfter = boardFromFen(ply.fenAfter);
    const materialDelta = materialBalance(boardAfter) - materialBalance(boardBefore);

    let significance = computeSignificance(ply, {
      signals,
      motifs,
      isSequenceTerminal: sequenceTerminalPlies.has(ply.ply),
      materialDelta
    });
    if (bestAlternative.bestMoveUniqueness === 'unique' && bestAlternative.playedMoveWasTopMove) {
      significance = withAdditionalReason(significance, 'only-move-under-pressure', ply.swingCp);
    }

    const causeConsequence = buildCauseConsequenceRecord({
      ply,
      signals,
      motifsForPly,
      threatsCreatedHere,
      threatsResolvedHere,
      bestAlternative,
      reply,
      forcingReason,
      sequence: sequenceForPly,
      allPliesByNumber: pliesByNumber
    });

    const turningPoint = buildTurningPoint(ply, causeConsequence, significance);
    const finalSignals: PlySignals = { ...signals, isTurningPoint: turningPoint !== null };

    plySemantics.push({
      ply: ply.ply,
      qualityClass,
      signals: finalSignals,
      evidence: {
        basis: 'engine-eval',
        sourcePlies: [ply.ply],
        note: `qualityClass=${qualityClass} from swingForMoverCp=${ply.swingForMoverCp}`
      }
    });

    if (turningPoint) turningPoints.push(turningPoint);
  }

  const gameArc = computeGameArc(plies);
  const narrativeSignals = computeNarrativeSignals(sequences, turningPoints);

  return ok({
    schemaVersion: UNDERSTANDING_SCHEMA_VERSION,
    plies: plySemantics,
    motifs,
    threats,
    sequences,
    turningPoints,
    gameArc,
    narrativeSignals,
    settings
  });
}
