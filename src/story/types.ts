import type { PieceId, TerminationKind } from '../pgn/types';
import type { Evidence } from '../understanding/types';
import type { GameOutcome, GameResult } from './gameOutcome';

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

/**
 * How we KNOW two plies belong to the same chain. Structural provenance, not
 * a chess claim: 'same-sequence' says these plies are in one ForcedSequence,
 * not that anything in particular happened chess-wise.
 */
export type StructuralLinkType =
  | 'same-sequence'
  | 'multi-move-consequence'
  | 'threat-refutation'
  /** Phase 15 — a forced mate stood for the same side across this ply. */
  | 'mate-transition-continuity'
  /** Phase 15 — the chain arrived at a genuinely terminal position. */
  | 'terminal-arrival';

/**
 * Phase 16 — WHAT happened in chess terms at a ply, as opposed to how we know
 * the ply belongs to the chain. Each value is emitted only when its own
 * evidence is established; see story/consequenceChain.ts's classifier.
 *
 * These are FACTS, never causal claims. 'defender-lost' asserts "a defender of
 * X was removed and X became winnable" — it never asserts that this is why the
 * game was won. That stronger statement additionally requires the claim ladder
 * (StoryConfidence.causalClaimAllowed) to permit it.
 */
export type CausalFact =
  /** A material swing of real size was measured across this ply's own board diff. */
  | 'material-lost'
  /** The evaluation moved decisively against the mover AND did not recover — never a single spike. */
  | 'evaluation-collapse'
  /** This ply is a reply inside a ForcedSequence: the side to move had no free choice. */
  | 'forced-response'
  /** The moving side reduced the opposing king's legal escape squares (KingMobilityRecord). */
  | 'escape-square-removed'
  /** A defender was removed or walked away, and its target became profitably takeable. */
  | 'defender-lost';

export type CausalLinkType = StructuralLinkType | CausalFact;

export interface CausalLink {
  readonly ply: number;
  /**
   * Structural provenance. Deliberately still typed as CausalLinkType (the
   * widened union) rather than narrowed, so existing consumers compile
   * unchanged; in practice the classifier only ever assigns a
   * StructuralLinkType here — the chess facts live in `causalFacts`, on their
   * own axis, because a link has both a reason-we-know-it and a
   * what-happened, and collapsing them would destroy the first.
   */
  readonly linkType: CausalLinkType;
  readonly evidenceId: string;
  /**
   * Phase 16 — chess-semantic facts observed at this ply, ascending by the
   * fixed order in CAUSAL_FACT_ORDER. Absent when nothing cleared its
   * evidence gate; never an empty array, so "no facts" and "not classified"
   * cannot be confused.
   */
  readonly causalFacts?: readonly CausalFact[];
}

export interface CentralConflict {
  readonly primaryTurningPointId: string;
  /** Ascending by ply. Excludes the primary turning point's own ply (resolve it via primaryTurningPointId). */
  readonly causalChain: readonly CausalLink[];
  /** Ranked TurningPoint ids, excluding the winner and any turning point absorbed into causalChain. */
  readonly secondaryConflicts: readonly string[];
  /**
   * Phase 15 — the directional chain this conflict sits at the centre of.
   * `causalChain` above is retained unchanged (it is the flat union of
   * antecedents and consequents) so existing consumers keep working; new
   * consumers should read this instead, because it is the only one that
   * knows which direction a link points and where the story ends up.
   */
  readonly consequenceChain: ConsequenceChain;
  /** Gate 2's verdict. See storyCandidates.ts. */
  readonly tier: StoryTier;
}

export type NoConflictReason =
  | 'no-turning-points'
  | 'below-significance-floor'
  /** Phase 15 — events existed, but none survived Gate 1's consequence/persistence tests. */
  | 'no-admissible-candidate'
  /**
   * Phase 15 — a result is asserted that nothing observable supports: no
   * terminal position, no termination reason, and a final position that does
   * not look decided. Claiming a story here would be narrating a game whose
   * ending we cannot see.
   */
  | 'unsupported-outcome';

// ============================================================
// Consequence chain and payoff (Phase 15)
// ============================================================

/**
 * Where a story's consequences come to rest.
 *
 * The previous model had no such concept: consequence range was
 * `max(evaluationConsequence.atPly, materialConsequence.atPly,
 * multiMoveConsequence.endPly, climaxPly)`, all of which are local to the
 * move, so a story could never reach the move that actually ended the game.
 * Games whose mate was 3 plies after the climax simply had no consequence
 * beat at all, and the mate arrived as an unrelated terminal annotation.
 */
export type PayoffTerminus =
  | { readonly kind: 'checkmate'; readonly atPly: number }
  | { readonly kind: 'stalemate'; readonly atPly: number }
  | { readonly kind: 'material-settled'; readonly atPly: number; readonly netMaterialChange: number }
  | { readonly kind: 'eval-settled'; readonly atPly: number; readonly finalSwingCp: number }
  /**
   * The game ended off the board — resignation, timeout, agreement. Carries
   * the result and termination so a consumer can state BOTH what the board
   * said and what the clock/players decided, which is the only honest way to
   * narrate a game that ended drawn while one side held a forced mate.
   */
  | { readonly kind: 'off-board-result'; readonly result: GameResult; readonly termination: TerminationKind }
  | { readonly kind: 'unresolved' };

export interface ConsequenceChain {
  readonly triggerPly: number;
  /**
   * Phase 16 — the chess facts of the TRIGGER move itself. The trigger is not
   * a member of antecedents/consequents (it is resolved via
   * primaryTurningPointId), so without this its own facts — the "45.Bxf6
   * removes a defender" half of the explanation — had nowhere to live.
   * Absent when nothing cleared its evidence gate.
   */
  readonly triggerFacts?: readonly CausalFact[];
  /** Strictly before triggerPly, ascending. */
  readonly antecedents: readonly CausalLink[];
  /** Strictly after triggerPly, ascending. */
  readonly consequents: readonly CausalLink[];
  readonly payoff: PayoffTerminus;
  /**
   * True only when the consequents actually arrive at the game's final ply.
   * This is what Gate 2 partitions on — an off-board ending does NOT make
   * every candidate reach the result, or the tiering would be meaningless.
   */
  readonly reachesResult: boolean;
  readonly evidence: Evidence;
}

/** Gate 2's partition. A always outranks B, which always outranks C. */
export type StoryTier = 'A' | 'B' | 'C';

// ============================================================
// Move retention
// ============================================================

export type MoveTreatment = 'spine' | 'setup' | 'compressible' | 'theory' | 'pruned';

// ============================================================
// Archetypes
// ============================================================

export type StoryArchetype = 'king-hunt' | 'pawn-journey' | 'stalemate-swindle' | 'stalemate-blunder' | 'forced-trap';

/**
 * Phase 16 — archetypes that are EVIDENCE ONLY.
 *
 * Such an archetype is still detected, still carried on StoryPlan, still
 * available to the hook and to narrative text, and still counted among
 * lead/supporting roles. What it does NOT do is claim a track of its own on
 * the board.
 *
 * 'stalemate-blunder' is evidence-only because it is, by construction, a
 * single-ply observation about the very last move of the game. An
 * archetype-track directive there overlaps the central-conflict highlight and,
 * since AnnotationDirectiveKind priority ranks archetype-track above it, would
 * take the Climax's own caption away — replacing the game's decisive moment
 * with a label about its final move. The observation is worth keeping; the
 * annotation track is not worth the Climax.
 */
export const EVIDENCE_ONLY_ARCHETYPES: ReadonlySet<StoryArchetype> = new Set<StoryArchetype>(['stalemate-blunder']);

export interface ArchetypeSignal {
  readonly archetype: StoryArchetype;
  /**
   * Phase 16 (MUST HAVE 7) — the ply of a sacrifice that STRUCTURALLY ENABLED
   * this archetype's payoff, when one is established.
   *
   * Present only on a king-hunt signal, and only when all three conditions in
   * archetypes.ts's enablingSacrificePly hold. Its absence is meaningful: it
   * says the weaker fact ("a sacrifice happened during the hunt") may be true
   * but the stronger one ("the sacrifice enabled the mate") is not evidenced,
   * so nothing downstream may assert it.
   */
  readonly enablingSacrificePly?: number;
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
  /**
   * Phase 16 — the mirror of swindleMaterialDeficitFloor. Minimum material
   * ADVANTAGE the stalemating side must have held shortly before delivering
   * stalemate for it to read as a thrown-away win. Same units and same
   * magnitude as the swindle floor, because it is the same question asked
   * with the opposite sign.
   */
  readonly blunderMaterialAdvantageFloor: number;
  /**
   * Corroborating evaluation advantage (centipawns, mover-relative) required
   * alongside the material advantage. Material alone is NOT sufficient: a
   * materially-up side can be in a genuinely drawn or locked position, where
   * a stalemate throws away nothing. Set to the same scale story/
   * storyCandidates.ts uses for a consequence worth naming.
   */
  readonly blunderEvalAdvantageFloor: number;
}

export const DEFAULT_STORY_SETTINGS: StorySettings = {
  significanceFloorForConflict: 0,
  maxSecondaryConflicts: 3,
  minPawnJourneyPlies: 3,
  swindleMaterialDeficitFloor: 500,
  blunderMaterialAdvantageFloor: 500,
  blunderEvalAdvantageFloor: 150
};

// ============================================================
// Top-level output
// ============================================================

// ============================================================
// Confidence (Phase 15)
// ============================================================

/**
 * Two distinct states, deliberately NOT collapsed into one number:
 *
 *   'none'  — no meaningful cinematic story. Structural, not probabilistic:
 *             either nothing survived Gate 1, or the recorded result is
 *             unsupported by anything observable in the game.
 *   'low'   — a strong event exists, but the evidence for a CAUSAL claim
 *             about it does not. The story is told with weaker wording.
 *   'medium'/'high' — increasing evidential support.
 *
 * `causalClaimAllowed` is the single gate on narration of the form
 * "X led to Y". It is false unless all four of its preconditions hold, so a
 * caption layer can never assemble that sentence from data that does not
 * support it.
 */
export type ConfidenceLevel = 'none' | 'low' | 'medium' | 'high';

export interface StoryConfidence {
  readonly level: ConfidenceLevel;
  /** True only when mechanism is verified, resolution corroborated, consequents non-empty, and trigger/payoff are linked. */
  readonly causalClaimAllowed: boolean;
  readonly mechanismVerified: boolean;
  readonly resolutionCorroborated: boolean;
  /**
   * Phase 16 — chain-level corroboration, kept as its own fact rather than
   * folded into resolutionCorroborated so an audit can see WHICH kind of
   * evidence supported the claim.
   *
   * True when the consequence chain actually arrived at a terminal position
   * the engine observed (checkmate/stalemate). This is strictly stronger
   * evidence than the trigger-local `resolution` label, which is measured only
   * at the trigger's own consequence ply and therefore reads 'unresolved' for
   * any trigger whose payoff lands later in the game.
   */
  readonly payoffCorroborated: boolean;
  readonly hasConsequents: boolean;
  readonly reachesResult: boolean;
  /** Short audit strings — never display copy. */
  readonly reasons: readonly string[];
}

export interface StoryPlan {
  readonly schemaVersion: typeof STORY_SCHEMA_VERSION;
  readonly centralConflict: CentralConflict | null;
  /** Present iff centralConflict is null. */
  readonly noConflictReason?: NoConflictReason;
  readonly beats: readonly StoryBeat[];
  /** One entry per ply, ascending, covering every ply — 'pruned' is a label, never a deletion. */
  readonly moveTreatment: readonly { readonly ply: number; readonly treatment: MoveTreatment }[];
  readonly archetypeSignals: readonly ArchetypeSignal[];
  /**
   * Phase 15 — the archetype (if any) entitled to own the game's headline.
   * An archetype leads only when it contains the selected trigger AND its
   * own evidence reaches the payoff; otherwise it is supporting. Previously
   * every archetype was equal, and a 112-ply pawn-journey span could take
   * the caption and the hook away from the actual central conflict.
   */
  readonly leadArchetype: StoryArchetype | null;
  readonly supportingArchetypes: readonly StoryArchetype[];
  readonly pieceContributions: readonly PieceContribution[];
  readonly explanationOpportunities: readonly ExplanationOpportunity[];
  readonly confidence: StoryConfidence;
  /** Phase 15 — resolved once, first, and consulted by every gate. */
  readonly outcome: GameOutcome;
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
