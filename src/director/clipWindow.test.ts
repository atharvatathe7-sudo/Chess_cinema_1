import { describe, expect, it } from 'vitest';
import type { CausalLink, CentralConflict, ConsequenceChain, PayoffTerminus } from '../story/types';
import { centralConflict, consequenceChain } from '../story/storyFixtures';
import { storyPlanFrom } from './directorFixtures';
import { deriveClipWindow } from './clipWindow';
import { DEFAULT_DIRECTOR_SETTINGS, type DirectorSettings } from './types';

/**
 * Phase 18A — pure unit coverage for deriveClipWindow, using StoryPlan's own
 * hand-supply fixture helpers (centralConflict/consequenceChain) directly —
 * never the real buildStoryPlan pipeline, since these tests are about
 * WINDOWING an already-selected story, not about story SELECTION itself.
 */

function link(ply: number): CausalLink {
  return { ply, linkType: 'same-sequence', evidenceId: 'seq-a' };
}

function planFor(triggerPly: number, chainOverrides: Partial<ConsequenceChain>, conflictOverrides: Partial<CentralConflict> = {}) {
  return storyPlanFrom({
    centralConflict: centralConflict('tp-x', triggerPly, {
      consequenceChain: consequenceChain(triggerPly, chainOverrides),
      ...conflictOverrides
    }),
    noConflictReason: undefined
  });
}

const SETTINGS = DEFAULT_DIRECTOR_SETTINGS;

describe('deriveClipWindow', () => {
  it('1. normal story: antecedents, consequents, and a definite payoff all pass through with the chain\'s own real ply numbers', () => {
    const story = planFor(10, {
      antecedents: [link(7), link(8), link(9)],
      consequents: [link(11), link(12)],
      payoff: { kind: 'eval-settled', atPly: 12, finalSwingCp: 300 },
      reachesResult: true
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window).toEqual({
      kind: 'windowed',
      startPly: 7,
      setupPlies: [7, 8, 9],
      criticalPly: 10,
      consequencePlies: [11, 12],
      payoffPly: 12,
      endPly: 12,
      truncated: false
    });
  });

  it('2. no antecedents: startPly falls back to the critical ply itself, never a generic "N moves before" heuristic', () => {
    const story = planFor(5, {
      antecedents: [],
      consequents: [link(6)],
      payoff: { kind: 'checkmate', atPly: 6 }
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.startPly).toBe(5);
    expect(window.setupPlies).toEqual([]);
  });

  it('3a. unresolved chain with consequents: endPly falls back to the last evidenced consequent, payoffPly is null', () => {
    const story = planFor(5, {
      antecedents: [link(4)],
      consequents: [link(6), link(7)],
      payoff: { kind: 'unresolved' },
      reachesResult: false
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.payoffPly).toBeNull();
    expect(window.endPly).toBe(7);
    expect(window.startPly).toBe(4);
  });

  it('3b. unresolved chain with no consequents either: endPly falls back to the critical ply itself — never the game\'s final move just because the PGN continues', () => {
    const story = planFor(5, { payoff: { kind: 'unresolved' } });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.payoffPly).toBeNull();
    expect(window.endPly).toBe(5);
    expect(window.startPly).toBe(5);
  });

  it('4. checkmate payoff: endPly is the payoff\'s own atPly', () => {
    const story = planFor(8, {
      antecedents: [link(6), link(7)],
      payoff: { kind: 'checkmate', atPly: 8 }
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.payoffPly).toBe(8);
    expect(window.endPly).toBe(8);
  });

  it('5. stalemate payoff: endPly is the payoff\'s own atPly', () => {
    const story = planFor(7, {
      antecedents: [link(5), link(6)],
      consequents: [link(9)],
      payoff: { kind: 'stalemate', atPly: 9 }
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.payoffPly).toBe(9);
    expect(window.endPly).toBe(9);
  });

  it('6. material-settled and eval-settled payoffs: endPly is the payoff\'s own evidenced ply, not the trigger and not any later consequent', () => {
    const materialPayoff: PayoffTerminus = { kind: 'material-settled', atPly: 11, netMaterialChange: 900 };
    const materialStory = planFor(9, { antecedents: [link(8)], consequents: [link(10), link(11)], payoff: materialPayoff });
    const materialWindow = deriveClipWindow(materialStory, SETTINGS);
    expect(materialWindow.kind).toBe('windowed');
    if (materialWindow.kind !== 'windowed') throw new Error('unreachable');
    expect(materialWindow.payoffPly).toBe(11);
    expect(materialWindow.endPly).toBe(11);

    const evalPayoff: PayoffTerminus = { kind: 'eval-settled', atPly: 13, finalSwingCp: 450 };
    const evalStory = planFor(9, { antecedents: [link(8)], consequents: [link(10), link(13)], payoff: evalPayoff });
    const evalWindow = deriveClipWindow(evalStory, SETTINGS);
    expect(evalWindow.kind).toBe('windowed');
    if (evalWindow.kind !== 'windowed') throw new Error('unreachable');
    expect(evalWindow.payoffPly).toBe(13);
    expect(evalWindow.endPly).toBe(13);
  });

  it('7. off-board-result payoff: payoffPly is null, endPly falls back to the last evidenced consequent — never the raw game result ply', () => {
    const story = planFor(5, {
      antecedents: [link(4)],
      consequents: [link(6)],
      payoff: { kind: 'off-board-result', result: '1/2-1/2', termination: 'agreement' }
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.payoffPly).toBeNull();
    expect(window.endPly).toBe(6);
  });

  it('8a. long-chain truncation trims SETUP first, and never cuts mid-consequence: the critical->payoff span survives untouched even when it alone still exceeds the ceiling', () => {
    const tightSettings: DirectorSettings = { ...SETTINGS, maxClipSpanPlies: 10 };
    const story = planFor(50, {
      antecedents: [link(10), link(20), link(30), link(40), link(49)],
      consequents: [link(51), link(52)],
      payoff: { kind: 'checkmate', atPly: 52 }
    });
    const window = deriveClipWindow(story, tightSettings);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.truncated).toBe(true);
    expect(window.startPly).toBe(43); // endPly(52) - maxClipSpanPlies(10) + 1
    expect(window.setupPlies).toEqual([49]); // only the setup plies still >= the trimmed startPly survive
    expect(window.criticalPly).toBe(50);
    expect(window.consequencePlies).toEqual([51, 52]); // never cut
    expect(window.endPly).toBe(52); // never cut
  });

  it('8b. long-chain truncation: startPly is clamped to the critical ply and never trims past it, even if the ceiling still cannot be satisfied', () => {
    const verytightSettings: DirectorSettings = { ...SETTINGS, maxClipSpanPlies: 5 };
    const story = planFor(50, {
      antecedents: [link(10)],
      consequents: [link(80)],
      payoff: { kind: 'checkmate', atPly: 80 }
    });
    const window = deriveClipWindow(story, verytightSettings);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.truncated).toBe(true);
    expect(window.startPly).toBe(50); // clamped to criticalPly — the ceiling still isn't satisfied (span 31 > 5), but nothing past the critical ply is ever trimmed
    expect(window.setupPlies).toEqual([]);
    expect(window.endPly).toBe(80);
  });

  it('8c. a span within the ceiling is left completely untouched', () => {
    const story = planFor(10, {
      antecedents: [link(8), link(9)],
      consequents: [link(11)],
      payoff: { kind: 'checkmate', atPly: 11 }
    });
    const window = deriveClipWindow(story, { ...SETTINGS, maxClipSpanPlies: 40 });
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.truncated).toBe(false);
    expect(window.startPly).toBe(8);
  });

  it('9. secondaryConflicts never influence the window: identical chains with different secondaryConflicts produce byte-identical windows', () => {
    const chainOverrides: Partial<ConsequenceChain> = {
      antecedents: [link(4)],
      consequents: [link(6)],
      payoff: { kind: 'checkmate', atPly: 6 }
    };
    const withoutSecondary = planFor(5, chainOverrides, { secondaryConflicts: [] });
    const withSecondary = planFor(5, chainOverrides, { secondaryConflicts: ['tp-99', 'tp-100'] });
    expect(deriveClipWindow(withSecondary, SETTINGS)).toEqual(deriveClipWindow(withoutSecondary, SETTINGS));
  });

  it('10. abstention: centralConflict === null produces {kind: "abstained"} carrying StoryPlan\'s own noConflictReason verbatim', () => {
    const story = storyPlanFrom({ centralConflict: null, noConflictReason: 'below-significance-floor' });
    expect(deriveClipWindow(story, SETTINGS)).toEqual({ kind: 'abstained', reason: 'below-significance-floor' });
  });

  it('11. an arbitrary nonzero startPly is preserved verbatim — plies are never renumbered to a local 0..N range', () => {
    const story = planFor(205, {
      antecedents: [link(201), link(202), link(203)],
      consequents: [link(207), link(208)],
      payoff: { kind: 'checkmate', atPly: 208 }
    });
    const window = deriveClipWindow(story, SETTINGS);
    expect(window.kind).toBe('windowed');
    if (window.kind !== 'windowed') throw new Error('unreachable');
    expect(window.startPly).toBe(201);
    expect(window.setupPlies).toEqual([201, 202, 203]);
    expect(window.criticalPly).toBe(205);
    expect(window.consequencePlies).toEqual([207, 208]);
    expect(window.endPly).toBe(208);
  });
});
