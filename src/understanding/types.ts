import type { Color, PieceType } from '../chess/ChessEngine';
import type { PieceId } from '../pgn/types';
import type { Evaluation, MateTransition } from '../analysis/types';

/**
 * Phase 2.2 — Chess Understanding Layer data model.
 *
 * This module defines GameUnderstanding, the structured semantic
 * representation that sits between Phase 2.1's raw engine analysis
 * (GameAnalysis) and the future Story Engine (Phase 2.3). Nothing in this
 * file renders anything, times anything, or writes prose — see the
 * string-field restriction at the bottom of this file.
 */

export const UNDERSTANDING_SCHEMA_VERSION = 1;

// ============================================================
// Evidence — the only channel through which anything short of a hard,
// deterministic fact is asserted.
// ============================================================

export type EvidenceBasis = 'engine-eval' | 'chess-rule' | 'inference';

export interface Evidence {
  readonly basis: EvidenceBasis;
  /** Required when basis === 'inference'; never present otherwise. Always < 1. */
  readonly confidence?: number;
  readonly sourcePlies: readonly number[];
  /**
   * Short technical/audit string ("swingForMoverCp=-450, exceeds blunder
   * threshold"). Internal only — never end-user display copy, never
   * natural-language narration. See the module-level note at the bottom of
   * this file.
   */
  readonly note: string;
}

// ============================================================
// Axis 1 — Move quality (ENGINE-RELATIVE ONLY)
// ============================================================

/**
 * ============================================================
 * MOVE-QUALITY SCOPE — the one rule for this type
 * ============================================================
 *
 * MoveQualityClass answers exactly one question: how did this move compare
 * to the engine's own best line at this position? Nothing more.
 *
 * It is NEVER a proxy for:
 *   - chess significance / tactical importance   -> SignificanceRecord
 *   - brilliance / dramatic weight                -> not computed by Phase 2.2 at all
 *   - narrative value                              -> Phase 2.3, entirely downstream
 *
 * A move can be 'optimal' with extremely high significance (a forced-mate
 * delivery: it lost nothing relative to best play, AND it decided the
 * game). A move can be an 'inaccuracy' with near-zero significance (a
 * small, technically-suboptimal move inside an already-crushing or
 * already-drawn position that changes nothing about the game's outcome).
 * qualityClass and SignificanceRecord.score are computed from overlapping
 * raw inputs but are never derived from one another.
 */
export type MoveQualityClass = 'optimal' | 'inaccuracy' | 'mistake' | 'blunder' | 'missed-win';

/** Independent, non-exclusive per-ply facts. Any number may be true simultaneously, on any qualityClass. */
export interface PlySignals {
  readonly matchesEngineBest: boolean;
  readonly isSacrifice: boolean;
  readonly deliversCheck: boolean;
  readonly deliversMate: boolean;
  readonly motifIds: readonly string[];
  readonly forcedSequenceId?: string;
  readonly isTurningPoint: boolean;
  /**
   * Phase 2.2.1 — stable piece identity, threaded straight from
   * GameRecord.moves (assigned once, in Phase 1, by
   * pgn/assignPieceIdentities.ts). Not recomputed here; this is the same
   * PieceId a motif/threat/sequence on this ply can be joined back to.
   */
  readonly pieceId: PieceId;
  readonly capturedPieceId?: PieceId;
  /** True iff this ply's move was a promotion — direct read of MoveRecord.promotion, no inference. */
  readonly isPromotion: boolean;
  /** True iff isPromotion and the promotion piece is not a queen. */
  readonly isUnderpromotion: boolean;
  readonly promotionPieceType?: PieceType;
}

export interface PlySemantics {
  readonly ply: number;
  readonly qualityClass: MoveQualityClass;
  readonly signals: PlySignals;
  readonly evidence: Evidence;
}

// ============================================================
// Axis 2 — Chess significance (symmetric: not loss-only)
// ============================================================

export type SignificanceReason =
  | 'large-swing-either-direction'
  | 'decisive-mate-transition'
  | 'only-move-under-pressure'
  | 'confirmed-tactical-motif'
  | 'forced-sequence-terminal'
  | 'material-decisive';

export interface SignificanceRecord {
  readonly score: number;
  readonly reasons: readonly SignificanceReason[];
}

// ============================================================
// Tactical motifs (Stage 1 geometry + Stage 2 engine confirmation)
// ============================================================

export type TacticalMotif = 'fork' | 'pin' | 'skewer' | 'discovery' | 'battery' | 'deflection' | 'overload';

export interface TacticalMotifInstance {
  readonly id: string;
  readonly ply: number;
  readonly motif: TacticalMotif;
  readonly squares: {
    readonly attacker: string;
    readonly targets: readonly string[];
    readonly throughSquare?: string;
  };
  /** Stage 1 — always present, basis: 'chess-rule'. */
  readonly geometryEvidence: Evidence;
  /** Stage 2 — present only when engine data confirms the motif actually realized value. */
  readonly significanceEvidence?: Evidence;
}

// ============================================================
// Threats — SEE-gated, category-aware
// ============================================================

export type ThreatKind = 'check-threat' | 'mate-threat' | 'material-winning-threat' | 'positional-restriction-threat';

export interface ThreatRecord {
  readonly id: string;
  readonly ply: number;
  readonly side: Color;
  readonly kind: ThreatKind;
  readonly targetSquare: string;
  readonly targetPiece?: PieceType;
  /** SEE result; required and > 0 for material-winning-threat. */
  readonly netMaterialIfExecuted?: number;
  readonly refutedBy?: { readonly ply: number; readonly moveUci: string };
  readonly evidence: Evidence;
}

// ============================================================
// Forced sequences
// ============================================================

export type ForcingReason = 'check' | 'only-legal-reply' | 'material-forced-recapture';

export interface ForcedSequence {
  readonly id: string;
  readonly startPly: number;
  readonly endPly: number;
  readonly plies: readonly number[];
  readonly forcingReason: ForcingReason;
  /** Set only when the deep-verification budget confirmed this beyond the default search depth. */
  readonly verifiedDepth?: number;
  readonly evidence: Evidence;
}

// ============================================================
// Best-alternative evidence (Revision 3)
// ============================================================

export interface AlternativeLine {
  readonly rank: number;
  readonly moveUci: string;
  readonly principalVariation: readonly string[];
  readonly evaluation: Evaluation;
  readonly deltaFromTopCp: number;
}

export interface BestAlternativeRecord {
  readonly topMove: { readonly uci: string; readonly principalVariation: readonly string[] } | null;
  readonly topMoveEvaluation: Evaluation;
  readonly playedMoveWasTopMove: boolean;
  readonly playedMoveEffectivelyEquivalent: boolean;
  readonly bestMoveUniqueness: 'unique' | 'shared' | 'unknown';
  readonly alternativesConsidered: readonly AlternativeLine[];
  readonly evidence: Evidence;
}

// ============================================================
// Cause -> consequence
// ============================================================

export interface CauseConsequenceRecord {
  readonly id: string;
  readonly ply: number;
  readonly positionBefore: string;
  readonly movePlayed: { readonly san: string; readonly uci: string };
  readonly immediateChange: {
    readonly evaluationDelta: { readonly swingCp: number; readonly swingForMoverCp: number };
    readonly materialDelta: number;
    readonly motifsTriggered: readonly string[];
  };
  readonly threatsCreated: readonly string[];
  readonly threatsRemoved: readonly string[];
  readonly mechanism: TacticalMotif | 'king-safety' | 'positional' | null;
  readonly bestAlternative: BestAlternativeRecord;
  readonly opponentResponse?: {
    readonly ply: number;
    readonly san: string;
    readonly wasForced: boolean;
    readonly forcingReason?: ForcingReason;
  };
  readonly evaluationConsequence: { readonly atPly: number; readonly swingCp: number };
  readonly materialConsequence: { readonly atPly: number; readonly netMaterialChange: number };
  readonly multiMoveConsequence?: { readonly sequenceId: string; readonly endPly: number };
  readonly resolution: 'decisive-advantage' | 'material-gain' | 'forced-mate' | 'repelled' | 'unresolved' | 'drawn';
  readonly evidence: Evidence;
}

export type TurningPointKind =
  | 'decisive-swing'
  | 'mate-appeared'
  | 'mate-flipped'
  | 'mate-disappeared'
  | 'irreversible-material-loss'
  | 'forced-mate-delivery'
  | 'brilliant-defense';

export interface TurningPoint {
  readonly id: string;
  readonly ply: number;
  readonly kind: TurningPointKind;
  readonly significance: SignificanceRecord;
  readonly causeConsequence: CauseConsequenceRecord;
}

// ============================================================
// King mobility (Phase 2.2.1) — chess-rule only, via geometry.ts's
// already-tested legalKingEscapeSquares.
// ============================================================

/**
 * One record per ply, computed from that ply's fenBefore for its own
 * sideToMove — the only king/position combination legalKingEscapeSquares
 * is well-defined for (it only answers for the side actually to move).
 * Consecutive records naturally alternate between both colors across the
 * game, so both kings' mobility is covered without any special-casing.
 */
export interface KingMobilityRecord {
  readonly ply: number;
  readonly color: Color;
  readonly legalEscapeSquares: readonly string[];
  readonly legalEscapeSquareCount: number;
}

// ============================================================
// Game arc (structural, deterministic) + narrative signals (hedged, inferred)
// ============================================================

export interface GameArcSummary {
  readonly openingEndPly: number;
  readonly middlegameEndPly: number;
  readonly materialTrajectory: readonly { readonly ply: number; readonly materialDiff: number }[];
  readonly evidence: Evidence;
}

export interface NarrativeArchetypeSignal {
  readonly archetype: string;
  readonly supportingEvidence: readonly Evidence[];
  readonly confidence: number;
}

// ============================================================
// Settings — bounded, deterministic follow-up engine work
// ============================================================

export interface UnderstandingEngineBudget {
  /** Hard cap on how many positions receive ANY follow-up query, shared between MultiPV and deep re-search. */
  readonly maxFollowUpPositions: number;
  readonly multiPvLines: number;
  readonly multiPvDepth: number;
  readonly multiPvMaxTimeMsPerPosition: number;
  readonly deepVerifyDepth: number;
  readonly deepVerifyMaxTimeMsPerPosition: number;
}

export const DEFAULT_UNDERSTANDING_ENGINE_BUDGET: UnderstandingEngineBudget = {
  maxFollowUpPositions: 24,
  multiPvLines: 3,
  multiPvDepth: 12,
  multiPvMaxTimeMsPerPosition: 3000,
  deepVerifyDepth: 20,
  deepVerifyMaxTimeMsPerPosition: 5000
};

export interface UnderstandingSettings {
  readonly engineBudget: UnderstandingEngineBudget;
  readonly minMaterialValueForMotif: number;
  /** Comparable-cp gap under which two lines count as "approximately equal." Kept separate from quality thresholds. */
  readonly equivalenceEpsilonCp: number;
}

export const DEFAULT_UNDERSTANDING_SETTINGS: UnderstandingSettings = {
  engineBudget: DEFAULT_UNDERSTANDING_ENGINE_BUDGET,
  minMaterialValueForMotif: 320, // minor piece
  equivalenceEpsilonCp: 30
};

// ============================================================
// Top-level output
// ============================================================

export interface GameUnderstanding {
  readonly schemaVersion: typeof UNDERSTANDING_SCHEMA_VERSION;
  readonly plies: readonly PlySemantics[];
  readonly motifs: readonly TacticalMotifInstance[];
  readonly threats: readonly ThreatRecord[];
  readonly sequences: readonly ForcedSequence[];
  readonly turningPoints: readonly TurningPoint[];
  readonly kingMobility: readonly KingMobilityRecord[];
  readonly gameArc: GameArcSummary;
  readonly narrativeSignals: readonly NarrativeArchetypeSignal[];
  readonly settings: UnderstandingSettings;
}

/**
 * ============================================================
 * NO NATURAL LANGUAGE — the one rule for this entire module
 * ============================================================
 *
 * Every string field in this file is one of exactly three kinds:
 *   1. Established chess notation already produced upstream (SAN, UCI long
 *      algebraic, FEN, square names) — referenced, never re-authored.
 *   2. Closed enum-like labels (MoveQualityClass, ThreatKind, ...) —
 *      structural classification, not prose.
 *   3. Evidence.note — a short technical/audit string for debugging and
 *      review, never end-user display copy.
 *
 * No field anywhere holds a sentence describing what happened in
 * storytelling terms, a hook, a title, a caption, a duration, a camera
 * instruction, or a statement of the form "the player should have...".
 * That synthesis is entirely Phase 2.3's responsibility, built from this
 * structured evidence.
 */
