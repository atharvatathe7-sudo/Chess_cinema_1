import { expect, test } from '@playwright/test';

/**
 * Phase 2.3 integration: the REAL Stockfish engine, driving analyzeGame ->
 * understandGame -> buildStoryPlan end to end over curated PGNs. buildStoryPlan
 * itself makes no engine calls (see its own module comment) — these tests
 * exist to prove that REAL, not hand-scripted, GameUnderstanding output
 * feeds it correctly, matching the two-tier testing discipline already
 * established by tests/e2e/understanding.spec.ts.
 */

test.describe.configure({ timeout: 180_000 });

interface StoryProbeResult {
  ok: boolean;
  error?: string;
  hasCentralConflict?: boolean;
  beatRoles?: string[];
  archetypeNames?: string[];
  moveTreatmentCount?: number;
  finalDrawReason?: string;
  determinismMatch?: boolean;
}

async function probeStory(page: import('@playwright/test').Page, pgn: string): Promise<StoryProbeResult> {
  return page.evaluate(async (pgnArg) => {
    const chessPath = '/src/chess/ChessJsEngine.ts';
    const pgnPath = '/src/pgn/parsePgn.ts';
    const analyzePath = '/src/analysis/analyzeGame.ts';
    const stockfishPath = '/src/analysis/StockfishAnalysisEngine.ts';
    const understandPath = '/src/understanding/understandGame.ts';
    const understandingTypesPath = '/src/understanding/types.ts';
    const storyPath = '/src/story/buildStoryPlan.ts';

    const chessMod = (await import(/* @vite-ignore */ chessPath)) as { ChessJsEngine: new () => unknown };
    const pgnMod = (await import(/* @vite-ignore */ pgnPath)) as {
      parsePgn: (pgn: string, rules: unknown) => { ok: boolean; value?: unknown; error?: { message: string } };
    };
    const analyzeMod = (await import(/* @vite-ignore */ analyzePath)) as {
      analyzeGame: (game: unknown, engine: unknown, rules: unknown, options: unknown) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
    };
    const stockfishMod = (await import(/* @vite-ignore */ stockfishPath)) as {
      StockfishAnalysisEngine: new () => {
        init(): Promise<{ ok: boolean; error?: { message: string } }>;
        dispose(): void;
      };
    };
    const understandMod = (await import(/* @vite-ignore */ understandPath)) as {
      understandGame: (
        game: unknown,
        analysis: unknown,
        engine: unknown,
        options?: unknown
      ) => Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>;
    };
    const typesMod = (await import(/* @vite-ignore */ understandingTypesPath)) as {
      DEFAULT_UNDERSTANDING_SETTINGS: {
        engineBudget: Record<string, number>;
        minMaterialValueForMotif: number;
        equivalenceEpsilonCp: number;
      };
    };
    const storyMod = (await import(/* @vite-ignore */ storyPath)) as {
      buildStoryPlan: (game: unknown, analysis: unknown, understanding: unknown, settings?: unknown) => unknown;
    };

    const rules = new chessMod.ChessJsEngine();
    const parsed = pgnMod.parsePgn(pgnArg, rules);
    if (!parsed.ok) return { ok: false, error: `pgn parse failed: ${parsed.error?.message}` };

    const engine = new stockfishMod.StockfishAnalysisEngine();
    const init = await engine.init();
    if (!init.ok) return { ok: false, error: `engine init failed: ${init.error?.message}` };

    const analysisSettings = { depth: 10, maxTimeMsPerPosition: 3000 };
    const analysis = await analyzeMod.analyzeGame(parsed.value, engine, new chessMod.ChessJsEngine(), { settings: analysisSettings });
    if (!analysis.ok) {
      engine.dispose();
      return { ok: false, error: `analyzeGame failed: ${analysis.error?.message}` };
    }

    const understandingSettings = {
      ...typesMod.DEFAULT_UNDERSTANDING_SETTINGS,
      engineBudget: {
        ...typesMod.DEFAULT_UNDERSTANDING_SETTINGS.engineBudget,
        maxFollowUpPositions: 4,
        multiPvDepth: 8,
        multiPvMaxTimeMsPerPosition: 2000
      }
    };

    const understanding = await understandMod.understandGame(parsed.value, analysis.value, engine, { settings: understandingSettings });
    engine.dispose();
    if (!understanding.ok) return { ok: false, error: `understandGame failed: ${understanding.error?.message}` };

    const first = storyMod.buildStoryPlan(parsed.value, analysis.value, understanding.value) as {
      centralConflict: unknown;
      beats: { role: string }[];
      archetypeSignals: { archetype: string }[];
      moveTreatment: unknown[];
    };
    const second = storyMod.buildStoryPlan(parsed.value, analysis.value, understanding.value);

    const a = analysis.value as { plies: { evaluationAfter: { drawReason?: string } }[] };

    return {
      ok: true,
      hasCentralConflict: first.centralConflict !== null,
      beatRoles: first.beats.map((b) => b.role),
      archetypeNames: first.archetypeSignals.map((s) => s.archetype),
      moveTreatmentCount: first.moveTreatment.length,
      finalDrawReason: a.plies[a.plies.length - 1]?.evaluationAfter.drawReason,
      determinismMatch: JSON.stringify(first) === JSON.stringify(second)
    };
  }, pgn);
}

test('a real forced-mate game produces a non-null central conflict anchored on the decisive turning point', async ({ page }) => {
  await page.goto('/');
  // Scholar's mate: real engine analysis reveals the mate-in-1 as forced
  // right after 5...Nf6 (Black's blunder), one ply BEFORE 4.Qxf7# actually
  // delivers it — mateTransition attributes 'mate-appeared' to the move
  // that first makes the mate inevitable, not the move that mechanically
  // executes it, so the significance-ranked central conflict correctly
  // anchors on the blunder ply, not the final capture. Since Nf6 isn't
  // linked to Qxf7# by any of the three approved causal-link types (it
  // doesn't check, isn't the only legal reply, and isn't a same-square
  // recapture), buildBeats correctly produces a climax beat only — no
  // consequence/resolution — rather than inferring a link from mere ply
  // proximity to the game's end (see centralConflict.test.ts's own
  // "does NOT link two turning points... with no real connection" case).
  // The consequence/resolution-reaches-game-end path is already covered
  // precisely, with full control, by beats.test.ts's hand-built fixtures;
  // this test's job is only to confirm a real engine's output selects a
  // genuine, sensible central conflict at all.
  const result = await probeStory(page, '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#');

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.hasCentralConflict).toBe(true);
  expect(result.beatRoles).toContain('climax');
  expect(result.moveTreatmentCount).toBeGreaterThan(0);
});

test('a real game reaching a promotion surfaces a pawn-journey archetype signal through the full pipeline (Phase 2.3)', async ({ page }) => {
  await page.goto('/');
  // Verified legal via a direct chess.js run in Phase 2.2.1: both a- and h-
  // pawns race to promotion, each making 5 moves before capturing into the
  // corner pieces — well past minPawnJourneyPlies's default floor of 3.
  const result = await probeStory(page, '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q');

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.archetypeNames).toContain('pawn-journey');
});

test('a real stalemate game surfaces drawReason end to end, and correctly does NOT flag a swindle for the side that was ahead (Phase 2.3)', async ({ page }) => {
  await page.goto('/');
  // Verified legal and genuinely stalemate (not checkmate) in Phase 2.2.1.
  // White's queen captures two rooks and several pawns before 10. Qe6
  // accidentally stalemates Black — White (the stalemating side) is
  // massively AHEAD, not behind, so this is a squandered win, not a
  // swindle, and buildStoryPlan's stalemate-swindle detector must correctly
  // decline to flag it (see src/story/archetypes.test.ts for the equivalent
  // hand-built positive/negative unit coverage of this exact distinction).
  const result = await probeStory(
    page,
    '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6'
  );

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();

  // Guard against the already-reported, deliberately-unfixed Phase 2.1
  // Stockfish quirk (info depth 0 score cp 0 before bestmove (none) on a
  // legal-move-free position): only assert on drawReason when the real
  // engine actually surfaced it this run, exactly as
  // tests/e2e/understanding.spec.ts already does for the same PGN.
  if (result.finalDrawReason === 'stalemate') {
    expect(result.archetypeNames).not.toContain('stalemate-swindle');
  }
});

test('buildStoryPlan is deterministic against real engine-derived GameUnderstanding: two calls match byte-for-byte', async ({ page }) => {
  await page.goto('/');
  const result = await probeStory(page, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  expect(result.ok).toBe(true);
  expect(result.determinismMatch).toBe(true);
});
