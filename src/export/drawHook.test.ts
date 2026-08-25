import { describe, expect, it } from 'vitest';
import type { GameAnalysis, PlyAnalysis, Evaluation } from '../analysis/types';
import { DEFAULT_ANALYSIS_SETTINGS } from '../analysis/types';
import type { ArchetypeSignal, StoryPlan } from '../story/types';
import { DEFAULT_STORY_SETTINGS, STORY_SCHEMA_VERSION } from '../story/types';
import { HOOK_FADE_MS, HOOK_TOTAL_MS, HOOK_VISIBLE_MS, hookOpacityAt, selectHook } from './drawHook';

/**
 * Phase 11 — pure-logic coverage only, per vitest.config.ts's own documented
 * split (no canvas/DOM here); the actual Canvas 2D/OffscreenCanvas drawing
 * is covered by tests/e2e/hook.spec.ts (Playwright/Chromium), the same
 * split drawCaptions.ts/drawCaptions.test.ts already use.
 */

/** Minimal but type-correct StoryPlan fixture — only archetypeSignals varies across tests. */
function fixtureStoryPlan(archetypeSignals: readonly ArchetypeSignal[]): StoryPlan {
  return {
    schemaVersion: STORY_SCHEMA_VERSION,
    centralConflict: null,
    beats: [],
    moveTreatment: [],
    archetypeSignals,
    pieceContributions: [],
    explanationOpportunities: [],
    settings: DEFAULT_STORY_SETTINGS
  };
}

function fixtureArchetypeSignal(archetype: ArchetypeSignal['archetype']): ArchetypeSignal {
  return {
    archetype,
    plies: [1],
    beatIds: [],
    evidence: { basis: 'chess-rule', sourcePlies: [1], note: 'fixture' }
  };
}

/** Minimal but type-correct GameAnalysis fixture — only the final ply's evaluationAfter matters to selectHook. */
function fixtureAnalysis(finalEvaluationAfter: Evaluation | null): GameAnalysis {
  const plies: PlyAnalysis[] = [];
  if (finalEvaluationAfter) {
    plies.push({
      ply: 1,
      moveNumber: 1,
      sideToMove: 'w',
      movePlayedSan: 'e4',
      movePlayedUci: 'e2e4',
      fenBefore: 'startpos',
      fenAfter: 'startpos',
      evaluationBefore: { kind: 'cp', cp: 0 },
      evaluationAfter: finalEvaluationAfter,
      bestMove: null,
      principalVariation: [],
      swingCp: 0,
      swingForMoverCp: 0,
      mateTransition: 'none',
      depth: 12
    });
  }
  return { plies, candidates: [], settings: DEFAULT_ANALYSIS_SETTINGS };
}

const TERMINAL_CHECKMATE: Evaluation = { kind: 'terminal', result: 'white-wins' };
const TERMINAL_STALEMATE: Evaluation = { kind: 'terminal', result: 'draw', drawReason: 'stalemate' };
const NON_TERMINAL_CP: Evaluation = { kind: 'cp', cp: 565 };

describe('selectHook — the five canonical games', () => {
  it("Scholar's Mate: no archetype, terminal checkmate -> CHECKMATE", () => {
    const story = fixtureStoryPlan([]);
    const analysis = fixtureAnalysis(TERMINAL_CHECKMATE);
    expect(selectHook(story, analysis)).toEqual({ text: 'CHECKMATE' });
  });

  it('Evergreen: archetype (forced-trap + king-hunt) -> FORCED TRAP, terminal is irrelevant once archetype resolves', () => {
    const story = fixtureStoryPlan([fixtureArchetypeSignal('forced-trap'), fixtureArchetypeSignal('king-hunt')]);
    const analysis = fixtureAnalysis(TERMINAL_CHECKMATE);
    expect(selectHook(story, analysis)).toEqual({ text: 'FORCED TRAP' });
  });

  it('Stalemate: no archetype, terminal stalemate -> STALEMATE', () => {
    const story = fixtureStoryPlan([]);
    const analysis = fixtureAnalysis(TERMINAL_STALEMATE);
    expect(selectHook(story, analysis)).toEqual({ text: 'STALEMATE' });
  });

  it('Promotion race: archetype present, final position NOT terminal -> PAWN JOURNEY (archetype tier never needs terminal data)', () => {
    const story = fixtureStoryPlan([fixtureArchetypeSignal('pawn-journey'), fixtureArchetypeSignal('pawn-journey')]);
    const analysis = fixtureAnalysis(NON_TERMINAL_CP);
    expect(selectHook(story, analysis)).toEqual({ text: 'PAWN JOURNEY' });
  });

  it('Quiet: no archetype, no terminal result -> no hook', () => {
    const story = fixtureStoryPlan([]);
    const analysis = fixtureAnalysis(NON_TERMINAL_CP);
    expect(selectHook(story, analysis)).toBeNull();
  });
});

describe('selectHook — archetype priority reuse', () => {
  it("resolves Evergreen's own two archetype signals to FORCED TRAP regardless of array order (matches the app's existing ARCHETYPE_COLOR_ORDER tie-break, not array insertion order)", () => {
    const forwardOrder = fixtureStoryPlan([fixtureArchetypeSignal('forced-trap'), fixtureArchetypeSignal('king-hunt')]);
    const reverseOrder = fixtureStoryPlan([fixtureArchetypeSignal('king-hunt'), fixtureArchetypeSignal('forced-trap')]);
    const analysis = fixtureAnalysis(TERMINAL_CHECKMATE);
    expect(selectHook(forwardOrder, analysis)).toEqual({ text: 'FORCED TRAP' });
    expect(selectHook(reverseOrder, analysis)).toEqual({ text: 'FORCED TRAP' });
  });

  it('every archetype resolves to its own existing label when it is the only signal present', () => {
    const analysis = fixtureAnalysis(TERMINAL_CHECKMATE);
    expect(selectHook(fixtureStoryPlan([fixtureArchetypeSignal('king-hunt')]), analysis)).toEqual({ text: 'KING HUNT' });
    expect(selectHook(fixtureStoryPlan([fixtureArchetypeSignal('pawn-journey')]), analysis)).toEqual({ text: 'PAWN JOURNEY' });
    expect(selectHook(fixtureStoryPlan([fixtureArchetypeSignal('stalemate-swindle')]), analysis)).toEqual({ text: 'STALEMATE SWINDLE' });
    expect(selectHook(fixtureStoryPlan([fixtureArchetypeSignal('forced-trap')]), analysis)).toEqual({ text: 'FORCED TRAP' });
  });
});

describe('selectHook — terminal tier edge cases', () => {
  it('a non-draw terminal result (either side winning) always reads CHECKMATE, never a side-specific label', () => {
    const story = fixtureStoryPlan([]);
    expect(selectHook(story, fixtureAnalysis({ kind: 'terminal', result: 'white-wins' }))).toEqual({ text: 'CHECKMATE' });
    expect(selectHook(story, fixtureAnalysis({ kind: 'terminal', result: 'black-wins' }))).toEqual({ text: 'CHECKMATE' });
  });

  it('a draw that is not a stalemate reads DRAW, distinct from STALEMATE', () => {
    const story = fixtureStoryPlan([]);
    const analysis = fixtureAnalysis({ kind: 'terminal', result: 'draw' });
    expect(selectHook(story, analysis)).toEqual({ text: 'DRAW' });
  });

  it('does not fall back to a bare "Terminal" placeholder: a non-terminal final evaluation with no archetype returns null, never a string', () => {
    const story = fixtureStoryPlan([]);
    expect(selectHook(story, fixtureAnalysis({ kind: 'cp', cp: 0 }))).toBeNull();
    expect(selectHook(story, fixtureAnalysis({ kind: 'mate', mateIn: 3 }))).toBeNull();
  });

  it('a game with zero analyzed plies (no final ply to read) and no archetype returns null rather than throwing', () => {
    const story = fixtureStoryPlan([]);
    const analysis = fixtureAnalysis(null);
    expect(selectHook(story, analysis)).toBeNull();
  });
});

describe('hookOpacityAt', () => {
  it('is fully opaque at t=0 (appears instantly, no fade-in)', () => {
    expect(hookOpacityAt(0)).toBe(1);
  });

  it(`stays fully opaque through HOOK_VISIBLE_MS (${HOOK_VISIBLE_MS}ms)`, () => {
    expect(hookOpacityAt(HOOK_VISIBLE_MS - 1)).toBe(1);
  });

  it('fades linearly across the fade window', () => {
    const mid = HOOK_VISIBLE_MS + HOOK_FADE_MS / 2;
    expect(hookOpacityAt(mid)).toBeCloseTo(0.5, 5);
  });

  it(`is fully transparent at and after HOOK_TOTAL_MS (${HOOK_TOTAL_MS}ms)`, () => {
    expect(hookOpacityAt(HOOK_TOTAL_MS)).toBe(0);
    expect(hookOpacityAt(HOOK_TOTAL_MS + 5000)).toBe(0);
  });

  it('is deterministic: identical input always produces identical output', () => {
    expect(hookOpacityAt(850)).toBe(hookOpacityAt(850));
  });
});
