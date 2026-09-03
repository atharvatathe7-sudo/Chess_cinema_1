import { describe, expect, it } from 'vitest';
import type { CauseConsequenceRecord } from '../understanding/types';
import { buildConfidence } from './confidence';
import { causeConsequence, centralConflict, consequenceChain, turningPoint, understandingFrom } from './storyFixtures';
import type { CausalLink, ConsequenceChain } from './types';

/**
 * Phase 16 — the causal-confidence wiring correction.
 *
 * The mismatch this fixes: understanding/causeConsequence.ts measures
 * `resolution` at the TRIGGER's own consequence ply, so any trigger whose
 * payoff lands later reads 'unresolved' — including every losing move whose
 * mate arrives a few plies afterwards. Meanwhile the consequence chain had
 * already walked, on evidence, all the way to that checkmate. Two
 * representations of "what followed" disagreed and only the weaker one was
 * wired into the claim ladder.
 *
 * The correction lets the chain-level payoff satisfy that precondition. It is
 * a representation fix, NOT a loosening: mechanismVerified is still required,
 * the chain must actually have REACHED the payoff, and only an ending the
 * engine observed on the board counts.
 */

/** A trigger whose mechanism is verified (or not), with a chosen local resolution. */
function conflictWith(options: {
  mechanism: CauseConsequenceRecord['mechanism'];
  mechanismVerified: boolean;
  resolution: CauseConsequenceRecord['resolution'];
  chain: Partial<ConsequenceChain>;
}) {
  const ply = 52;
  const cc: CauseConsequenceRecord = {
    ...causeConsequence(ply),
    mechanism: options.mechanism,
    mechanismVerified: options.mechanismVerified,
    resolution: options.resolution
  };
  const understanding = understandingFrom({ plies: [], turningPoints: [turningPoint(ply, 'decisive-swing', cc, 500)] });
  const conflict = centralConflict('tp-52', ply, { consequenceChain: consequenceChain(ply, options.chain) });
  return { understanding, conflict };
}

const CONSEQUENT: CausalLink = { ply: 55, linkType: 'mate-transition-continuity', evidenceId: 'mate-52' };

const REACHED_CHECKMATE: Partial<ConsequenceChain> = {
  consequents: [CONSEQUENT],
  payoff: { kind: 'checkmate', atPly: 55 },
  reachesResult: true
};

describe('POSITIVE — a reached, engine-observed payoff corroborates the consequence', () => {
  it('allows the causal claim when the mechanism is verified and the chain reached a checkmate, despite a trigger-local "unresolved"', () => {
    // The exact benchmark shape: the losing move's own consequence ply says
    // nothing ('unresolved'), because the mate is three plies away — but the
    // chain got there on evidence.
    const { understanding, conflict } = conflictWith({
      mechanism: 'positional',
      mechanismVerified: true,
      resolution: 'unresolved',
      chain: REACHED_CHECKMATE
    });
    const confidence = buildConfidence(conflict, understanding, undefined);

    expect(confidence.resolutionCorroborated).toBe(false);
    expect(confidence.payoffCorroborated).toBe(true);
    expect(confidence.causalClaimAllowed).toBe(true);
    expect(confidence.level).toBe('high');
    expect(confidence.reasons.join(' ')).toContain('chain payoff (checkmate)');
  });

  it('does the same for a reached stalemate', () => {
    const { understanding, conflict } = conflictWith({
      mechanism: 'king-safety',
      mechanismVerified: true,
      resolution: 'unresolved',
      chain: { consequents: [CONSEQUENT], payoff: { kind: 'stalemate', atPly: 55 }, reachesResult: true }
    });
    expect(buildConfidence(conflict, understanding, undefined).causalClaimAllowed).toBe(true);
  });

  it('still allows the claim on the old path, when the trigger-local resolution itself is corroborated', () => {
    const { understanding, conflict } = conflictWith({
      mechanism: 'fork',
      mechanismVerified: true,
      resolution: 'material-gain',
      chain: { consequents: [CONSEQUENT], payoff: { kind: 'material-settled', atPly: 53, netMaterialChange: 900 } }
    });
    const confidence = buildConfidence(conflict, understanding, undefined);
    expect(confidence.resolutionCorroborated).toBe(true);
    expect(confidence.payoffCorroborated).toBe(false);
    expect(confidence.causalClaimAllowed).toBe(true);
  });
});

describe('NEGATIVE — a payoff alone never buys a causal claim', () => {
  it('withholds the claim when the mechanism is NOT verified, however decisive the payoff', () => {
    // The single most important negative: five of the six benchmark games with
    // a reached checkmate must stay false, because nothing established HOW the
    // move did what it did.
    const { understanding, conflict } = conflictWith({
      mechanism: null,
      mechanismVerified: false,
      resolution: 'unresolved',
      chain: REACHED_CHECKMATE
    });
    const confidence = buildConfidence(conflict, understanding, undefined);

    expect(confidence.payoffCorroborated).toBe(true);
    expect(confidence.causalClaimAllowed).toBe(false);
    expect(confidence.reasons).toContain('mechanism not verified');
  });

  it('withholds the claim when a mechanism is NAMED but not verified', () => {
    const { understanding, conflict } = conflictWith({
      mechanism: 'fork',
      mechanismVerified: false,
      resolution: 'unresolved',
      chain: REACHED_CHECKMATE
    });
    expect(buildConfidence(conflict, understanding, undefined).causalClaimAllowed).toBe(false);
  });

  it('does not count a terminal payoff the chain never REACHED', () => {
    // reachesResult is the arrival test. A payoff kind alone is not arrival.
    const { understanding, conflict } = conflictWith({
      mechanism: 'positional',
      mechanismVerified: true,
      resolution: 'unresolved',
      chain: { consequents: [CONSEQUENT], payoff: { kind: 'checkmate', atPly: 55 }, reachesResult: false }
    });
    const confidence = buildConfidence(conflict, understanding, undefined);
    expect(confidence.payoffCorroborated).toBe(false);
    expect(confidence.causalClaimAllowed).toBe(false);
  });

  it('does not count an off-board result, which rests on the PGN rather than an observed position', () => {
    const { understanding, conflict } = conflictWith({
      mechanism: 'positional',
      mechanismVerified: true,
      resolution: 'unresolved',
      chain: {
        consequents: [CONSEQUENT],
        payoff: { kind: 'off-board-result', result: '1-0', termination: 'resignation' },
        reachesResult: true
      }
    });
    const confidence = buildConfidence(conflict, understanding, undefined);
    expect(confidence.payoffCorroborated).toBe(false);
    expect(confidence.causalClaimAllowed).toBe(false);
  });

  it('does not count a settled or unresolved payoff', () => {
    for (const payoff of [
      { kind: 'material-settled', atPly: 53, netMaterialChange: 900 },
      { kind: 'eval-settled', atPly: 53, finalSwingCp: 400 },
      { kind: 'unresolved' }
    ] as ConsequenceChain['payoff'][]) {
      const { understanding, conflict } = conflictWith({
        mechanism: 'positional',
        mechanismVerified: true,
        resolution: 'unresolved',
        chain: { consequents: [CONSEQUENT], payoff, reachesResult: false }
      });
      expect(buildConfidence(conflict, understanding, undefined).payoffCorroborated).toBe(false);
    }
  });

  it('withholds the claim when nothing followed the trigger at all', () => {
    const { understanding, conflict } = conflictWith({
      mechanism: 'positional',
      mechanismVerified: true,
      resolution: 'unresolved',
      chain: { consequents: [], payoff: { kind: 'checkmate', atPly: 55 }, reachesResult: true }
    });
    const confidence = buildConfidence(conflict, understanding, undefined);
    expect(confidence.hasConsequents).toBe(false);
    expect(confidence.causalClaimAllowed).toBe(false);
  });
});

describe('no-story case is unaffected', () => {
  it('reports every precondition false, including the new one', () => {
    const confidence = buildConfidence(null, understandingFrom({ plies: [] }), 'no-turning-points');
    expect(confidence.level).toBe('none');
    expect(confidence.causalClaimAllowed).toBe(false);
    expect(confidence.payoffCorroborated).toBe(false);
  });
});
