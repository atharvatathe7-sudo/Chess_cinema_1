import type { PieceId } from '../pgn/types';
import type { Evidence } from '../understanding/types';

/**
 * Phase 2.3 — Story Engine data model.
 *
 * StoryPlan is the structured, deterministic bridge between Phase 2.2's
 * GameUnderstanding (chess facts + significance) and a future cinematic/
 * narration layer. This module performs narrative SELECTION — deciding
 * which already-established facts form the game's central throughline —
 * never narrative GENERATION. See the NO NATURAL LANGUAGE note at the
 * bottom of this file, which restates understanding/types.ts's own
 * contract for this layer.
 */

export const STORY_SCHEMA_VERSION = 1;

// ============================================================
// Beats
// ============================================================

/**
 * Deliberately NOT 'hook' | 'tension' | 'tactical-sequence': 'hook' is a
 * presentation/directorial decision left to a later cinematic layer;
 * 'tension' is too interpretive to be a structural fact; 'tactical-sequence'
 * is already represented structurally via ForcedSequence membership
 * (see 'building-sequence' below, which is exactly that).
 */
export type BeatRole = 'setup' | 'building-sequence' | 'climax' | 'consequence' | 'resolution';

export interface StoryBeat {
  readonly id: string;
  readonly role: BeatRole;
  /** Ply numbers, ascending, non-empty. */
  readonly plies: readonly number[];
  /**
   * References into GameUnderstanding — never a copy of the evidence
   * living on those records. A consumer resolves turningPointId/
   * causeConsequenceId/sequenceId/motifIds/threatIds against
   * GameUnderstanding directly to reach the actual Evidence.
   */
  readonly evidenceRefs: {
    readonly turningPointId?: string;
    readonly causeConsequenceId?: string;
    readonly sequenceId?: string;
    readonly motifIds?: readonly string[];
    readonly threatIds?: readonly string[];
  };
  /** Read directly from the anchoring TurningPoint's SignificanceRecord.score — never recomputed. */
  readonly salience: number;
}

// ============================================================
// Central conflict
// ============================================================

export type CausalLinkType = 'same-sequence' | 'multi-move-consequence' | 'threat-refutation';

export interface CausalLink {
  readonly ply: number;
  readonly linkType: CausalLinkType;
  readonly evidenceId: string;
}

export interface CentralConflict {
  readonly primaryTurningPointId: string;
  /** Ascending by ply. Excludes the primary turning point's own ply (resolve it via primaryTurningPointId). */
  readonly causalChain: readonly CausalLink[];
  /** Ranked TurningPoint ids, excluding the winner and any turning point absorbed into causalChain. */
  readonly secondaryConflicts: readonly string[];
}

export type NoConflictReason = 'no-turning-points' | 'below-significance-floor';

// ============================================================
// Move retention
// ============================================================

export type MoveTreatment = 'spine' | 'setup' | 'compressible' | 'theory' | 'pruned';

// ============================================================
// Archetypes
// ============================================================

export type StoryArchetype = 'king-hunt' | 'pawn-journey' | 'stalemate-swindle' | 'forced-trap';

export interface ArchetypeSignal {
  readonly archetype: StoryArchetype;
  /** Ascending. Every ply this signal is about — not only the ones that overlap a beat. */
  readonly plies: readonly number[];
  /** StoryBeat ids whose plies overlap this signal's plies. May be empty — a signal is never dropped for lack of overlap. */
  readonly beatIds: readonly string[];
  /**
   * Reused directly (not a new provenance type). For 'king-hunt' this is the
   * existing NarrativeArchetypeSignal's own supportingEvidence, carried
   * through unchanged. For the other three archetypes, no pre-existing
   * Evidence object exists anywhere upstream to reference (isPromotion,
   * drawReason, isSacrifice are plain facts with no evidence wrapper) — so
   * this wraps them the same way understanding/motifs.ts wraps raw geometry
   * the first time, not a new provenance system.
   */
  readonly evidence: Evidence;
}

// ============================================================
// Piece contribution — factual only, no interpretation
// ============================================================

export interface PieceContribution {
  readonly pieceId: PieceId;
  readonly spineEventCount: number;
  readonly motifIds: readonly string[];
  readonly wasPromoted: boolean;
  readonly wasCaptured: boolean;
  // Deliberately no isHero / heroScore / protagonistScore / psychological or
  // player-intent field. That judgment belongs to a later narration layer.
}

// ============================================================
// Explanation opportunities
// ============================================================

export type ExplanationKind = 'clear-best-move' | 'only-good-move' | 'multiple-equivalent-options' | 'insufficient-data';

export interface ExplanationOpportunity {
  readonly ply: number;
  readonly kind: ExplanationKind;
  /** References the CauseConsequenceRecord (and thus its embedded BestAlternativeRecord) this opportunity is about. */
  readonly causeConsequenceId: string;
}

// ============================================================
// Settings — every editorial threshold explicit, none hard-coded
// ============================================================

export interface StorySettings {
  /** Minimum significance.score a turning point needs to become the central conflict. 0 = excludes nothing (TurningPoint construction already gates for chess significance). */
  readonly significanceFloorForConflict: number;
  readonly maxSecondaryConflicts: number;
  /** Minimum number of moves a pieceId must have made to count as a "journey" rather than a bare single-push promotion. */
  readonly minPawnJourneyPlies: number;
  /** Minimum material deficit (PIECE_VALUE units, geometry.ts scale) against the stalemating side, shortly before the stalemate, to qualify as a "swindle". */
  readonly swindleMaterialDeficitFloor: number;
}

export const DEFAULT_STORY_SETTINGS: StorySettings = {
  significanceFloorForConflict: 0,
  maxSecondaryConflicts: 3,
  minPawnJourneyPlies: 3,
  swindleMaterialDeficitFloor: 500
};

// ============================================================
// Top-level output
// ============================================================

export interface StoryPlan {
  readonly schemaVersion: typeof STORY_SCHEMA_VERSION;
  readonly centralConflict: CentralConflict | null;
  /** Present iff centralConflict is null. */
  readonly noConflictReason?: NoConflictReason;
  readonly beats: readonly StoryBeat[];
  /** One entry per ply, ascending, covering every ply — 'pruned' is a label, never a deletion. */
  readonly moveTreatment: readonly { readonly ply: number; readonly treatment: MoveTreatment }[];
  readonly archetypeSignals: readonly ArchetypeSignal[];
  readonly pieceContributions: readonly PieceContribution[];
  readonly explanationOpportunities: readonly ExplanationOpportunity[];
  readonly settings: StorySettings;
}

/**
 * ============================================================
 * NO NATURAL LANGUAGE — the one rule for this entire module
 * ============================================================
 *
 * Every string field in this file is one of exactly three kinds, the same
 * discipline understanding/types.ts already establishes:
 *   1. Established chess notation or IDs already produced upstream (ply
 *      references, GameUnderstanding record ids) — referenced, never
 *      re-authored.
 *   2. Closed enum-like labels (BeatRole, MoveTreatment, StoryArchetype,
 *      CausalLinkType, ExplanationKind, NoConflictReason) — structural
 *      classification, not prose.
 *   3. Evidence.note — a short technical/audit string, never end-user
 *      display copy.
 *
 * No field anywhere holds a sentence, a title, a hook, a caption, a
 * duration, a camera instruction, a psychological claim, or a statement of
 * the form "the player should have...". That synthesis is Phase 2.4+'s
 * responsibility, built from this structured selection.
 */
