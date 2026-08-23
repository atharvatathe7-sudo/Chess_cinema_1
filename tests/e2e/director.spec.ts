import { expect, test } from '@playwright/test';

/**
 * Phase 2.4 integration: the REAL Stockfish engine, driving the complete
 * pipeline parsePgn -> analyzeGame -> understandGame -> buildStoryPlan ->
 * buildCinematicPlan -> lowerToTimeline, over the same curated real PGNs
 * already used across Phase 2.2/2.2.1/2.3/2.3.1's own e2e suites
 * (understanding.spec.ts, story.spec.ts). buildCinematicPlan/lowerToTimeline
 * themselves make no engine calls (see their own module comments) — these
 * tests exist to prove real, not hand-scripted, StoryPlan output lowers
 * correctly into a Timeline the EXISTING, unmodified renderer accepts.
 */

test.describe.configure({ timeout: 180_000 });

interface DirectorProbeResult {
  ok: boolean;
  error?: string;
  timelineValid?: boolean;
  sceneDurationMs?: number;
  moveBeatCount?: number;
  annotationKinds?: string[];
  archetypeTrackArchetypes?: string[];
  cameraKeyframeCount?: number;
  hasClimaxZoom?: boolean;
  determinismMatch?: boolean;
  renderedNonBlank?: boolean;
  renderDeterministic?: boolean;
}

async function probeDirector(page: import('@playwright/test').Page, pgn: string): Promise<DirectorProbeResult> {
  return page.evaluate(async (pgnArg) => {
    const chessPath = '/src/chess/ChessJsEngine.ts';
    const pgnPath = '/src/pgn/parsePgn.ts';
    const analyzePath = '/src/analysis/analyzeGame.ts';
    const stockfishPath = '/src/analysis/StockfishAnalysisEngine.ts';
    const understandPath = '/src/understanding/understandGame.ts';
    const understandingTypesPath = '/src/understanding/types.ts';
    const storyPath = '/src/story/buildStoryPlan.ts';
    const directorPlanPath = '/src/director/buildCinematicPlan.ts';
    const lowerPath = '/src/director/lowerToTimeline.ts';
    const invariantsPath = '/src/timeline/invariants.ts';
    const rendererPath = '/src/render/Renderer.ts';
    const assetManagerPath = '/src/assets/AssetManager.ts';
    const pieceManifestPath = '/src/assets/pieceManifest.ts';
    const pieceLoaderPath = '/src/assets/browserPieceLoader.ts';

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
      buildStoryPlan: (game: unknown, analysis: unknown, understanding: unknown) => unknown;
    };
    const directorPlanMod = (await import(/* @vite-ignore */ directorPlanPath)) as {
      buildCinematicPlan: (game: unknown, analysis: unknown, understanding: unknown, story: unknown) => {
        cameraDirectives: { atPly: number }[];
        annotationDirectives: { kind: string; evidenceRef: { kind: string; archetype?: string } }[];
      };
    };
    const lowerMod = (await import(/* @vite-ignore */ lowerPath)) as {
      lowerToTimeline: (
        game: unknown,
        plan: unknown
      ) => {
        scenes: {
          id: string;
          durationMs: number;
          beats: { kind: string }[];
          cameraPlan: { keyframes: { atMs: number; zoom: number }[] };
        }[];
      };
    };
    const invariantsMod = (await import(/* @vite-ignore */ invariantsPath)) as {
      assertValidTimeline: (timeline: unknown) => void;
    };
    const rendererMod = (await import(/* @vite-ignore */ rendererPath)) as {
      render: (state: unknown, logicalTimeMs: number, ctx: unknown, dims: unknown, assets: unknown) => void;
    };
    const assetManagerMod = (await import(/* @vite-ignore */ assetManagerPath)) as {
      AssetManager: new (manifest: unknown, loader: unknown) => {
        load(): Promise<{ ok: boolean; error?: { message: string } }>;
      };
    };
    const pieceManifestMod = (await import(/* @vite-ignore */ pieceManifestPath)) as { PIECE_MANIFEST: unknown };
    const pieceLoaderMod = (await import(/* @vite-ignore */ pieceLoaderPath)) as { loadImage: unknown };

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

    const story = storyMod.buildStoryPlan(parsed.value, analysis.value, understanding.value);

    const plan1 = directorPlanMod.buildCinematicPlan(parsed.value, analysis.value, understanding.value, story);
    const plan2 = directorPlanMod.buildCinematicPlan(parsed.value, analysis.value, understanding.value, story);
    const determinismMatch = JSON.stringify(plan1) === JSON.stringify(plan2);

    const timeline = lowerMod.lowerToTimeline(parsed.value, plan1);

    let timelineValid = true;
    try {
      invariantsMod.assertValidTimeline(timeline);
    } catch {
      timelineValid = false;
    }

    const scene = timeline.scenes[0]!;
    const annotationKinds = [...new Set(scene.beats.filter((b) => b.kind === 'annotation').map((b: unknown) => (b as { annotation: { type: string } }).annotation.type))];
    const archetypeTrackArchetypes = [
      ...new Set(
        plan1.annotationDirectives
          .filter((d) => d.kind === 'archetype-track' && d.evidenceRef.kind === 'archetypeSignal')
          .map((d) => d.evidenceRef.archetype!)
      )
    ];

    // Render check: the Director-produced Timeline, fed through the
    // EXISTING, unmodified renderer, exactly the same AppState shape
    // ui/panel.ts already builds.
    const assets = new assetManagerMod.AssetManager(pieceManifestMod.PIECE_MANIFEST, pieceLoaderMod.loadImage);
    const assetsLoaded = await assets.load();
    let renderedNonBlank = false;
    let renderDeterministic = false;
    if (assetsLoaded.ok) {
      const canvas = document.createElement('canvas');
      canvas.width = 400;
      canvas.height = 400;
      const ctx = canvas.getContext('2d')!;
      const dims = { width: 400, height: 400 };
      const state = {
        game: { gameRecord: parsed.value, timeline },
        playback: { activeSceneId: scene.id, logicalTimeMs: Math.min(300, scene.durationMs), playing: false, rate: 1 },
        ui: { pendingError: null },
        assets: { pieces: 'ready' },
        analysis: { status: 'idle', progress: null, result: null, error: null }
      };
      rendererMod.render(state, state.playback.logicalTimeMs, ctx, dims, assets);
      const dataA = ctx.getImageData(0, 0, 400, 400).data;
      const nonWhiteA = Array.from(dataA).some((v, i) => i % 4 !== 3 && v !== 255);
      renderedNonBlank = nonWhiteA;

      rendererMod.render(state, state.playback.logicalTimeMs, ctx, dims, assets);
      const dataB = ctx.getImageData(0, 0, 400, 400).data;
      renderDeterministic = dataA.length === dataB.length && dataA.every((v, i) => v === dataB[i]);
    }

    return {
      ok: true,
      timelineValid,
      sceneDurationMs: scene.durationMs,
      moveBeatCount: scene.beats.filter((b) => b.kind === 'move').length,
      annotationKinds,
      archetypeTrackArchetypes,
      cameraKeyframeCount: scene.cameraPlan.keyframes.length,
      hasClimaxZoom: scene.cameraPlan.keyframes.some((k) => k.zoom > 1),
      determinismMatch,
      renderedNonBlank,
      renderDeterministic
    };
  }, pgn);
}

test('a quiet game lowers to a valid, renderable Timeline with no climax camera move', async ({ page }) => {
  await page.goto('/');
  const result = await probeDirector(page, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7');

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.timelineValid).toBe(true);
  expect(result.cameraKeyframeCount).toBe(1);
  expect(result.hasClimaxZoom).toBe(false);
  expect(result.determinismMatch).toBe(true);
  expect(result.renderedNonBlank).toBe(true);
  expect(result.renderDeterministic).toBe(true);
});

test('Scholars Mate produces a valid Timeline with a climax zoom and a terminal-result highlight', async ({ page }) => {
  await page.goto('/');
  const result = await probeDirector(page, '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#');

  expect(result.ok).toBe(true);
  expect(result.timelineValid).toBe(true);
  expect(result.hasClimaxZoom).toBe(true);
  expect(result.annotationKinds).toContain('highlight');
  expect(result.determinismMatch).toBe(true);
  expect(result.renderedNonBlank).toBe(true);
});

test('the Evergreen Game king-hunt produces an archetype-track annotation and a valid Timeline', async ({ page }) => {
  await page.goto('/');
  const result = await probeDirector(
    page,
    '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#'
  );

  expect(result.ok).toBe(true);
  expect(result.timelineValid).toBe(true);
  expect(result.archetypeTrackArchetypes).toContain('king-hunt');
  expect(result.hasClimaxZoom).toBe(true);
  expect(result.determinismMatch).toBe(true);
  expect(result.renderedNonBlank).toBe(true);
});

test('a real pawn-promotion race produces a pawn-journey archetype-track and a valid Timeline', async ({ page }) => {
  await page.goto('/');
  const result = await probeDirector(page, '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q');

  expect(result.ok).toBe(true);
  expect(result.timelineValid).toBe(true);
  expect(result.archetypeTrackArchetypes).toContain('pawn-journey');
  expect(result.determinismMatch).toBe(true);
  expect(result.renderedNonBlank).toBe(true);
});

test('a real stalemate game produces a terminal-result-highlight and a valid Timeline', async ({ page }) => {
  await page.goto('/');
  const result = await probeDirector(
    page,
    '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6'
  );

  expect(result.ok).toBe(true);
  expect(result.timelineValid).toBe(true);
  expect(result.annotationKinds).toContain('highlight');
  expect(result.determinismMatch).toBe(true);
  expect(result.renderedNonBlank).toBe(true);
});

test('a genuinely pruned (zero-duration) ply lowers to a Timeline the real Renderer accepts without exception', async ({ page }) => {
  // No real Stockfish needed here: directorFixtures.ts's prunedPlyScenario()
  // already runs the real story/buildStoryPlan() (Vitest-side, see
  // lowerToTimeline.test.ts) to genuinely classify one ply 'pruned'. This
  // test's own job is only the one thing Vitest's Node environment cannot
  // do — prove the resulting zero-duration MoveBeat is actually consumed by
  // the real, unmodified render/Renderer.render without exception.
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const fixturesPath = '/src/director/directorFixtures.ts';
    const directorPlanPath = '/src/director/buildCinematicPlan.ts';
    const lowerPath = '/src/director/lowerToTimeline.ts';
    const invariantsPath = '/src/timeline/invariants.ts';
    const rendererPath = '/src/render/Renderer.ts';
    const assetManagerPath = '/src/assets/AssetManager.ts';
    const pieceManifestPath = '/src/assets/pieceManifest.ts';
    const pieceLoaderPath = '/src/assets/browserPieceLoader.ts';

    const fixturesMod = (await import(/* @vite-ignore */ fixturesPath)) as {
      prunedPlyScenario: () => { game: unknown; analysis: unknown; understanding: unknown; story: unknown };
    };
    const directorPlanMod = (await import(/* @vite-ignore */ directorPlanPath)) as {
      buildCinematicPlan: (game: unknown, analysis: unknown, understanding: unknown, story: unknown) => {
        moveTreatmentPlan: { ply: number; pacing: string; durationMultiplier: number }[];
      };
    };
    const lowerMod = (await import(/* @vite-ignore */ lowerPath)) as {
      lowerToTimeline: (game: unknown, plan: unknown) => {
        scenes: { id: string; beats: { kind: string; durationMs?: number }[] }[];
      };
    };
    const invariantsMod = (await import(/* @vite-ignore */ invariantsPath)) as {
      assertValidTimeline: (timeline: unknown) => void;
    };
    const rendererMod = (await import(/* @vite-ignore */ rendererPath)) as {
      render: (state: unknown, logicalTimeMs: number, ctx: unknown, dims: unknown, assets: unknown) => void;
    };
    const assetManagerMod = (await import(/* @vite-ignore */ assetManagerPath)) as {
      AssetManager: new (manifest: unknown, loader: unknown) => { load(): Promise<{ ok: boolean }> };
    };
    const pieceManifestMod = (await import(/* @vite-ignore */ pieceManifestPath)) as { PIECE_MANIFEST: unknown };
    const pieceLoaderMod = (await import(/* @vite-ignore */ pieceLoaderPath)) as { loadImage: unknown };

    const { game, analysis, understanding, story } = fixturesMod.prunedPlyScenario();
    const plan = directorPlanMod.buildCinematicPlan(game, analysis, understanding, story);
    const prunedEntry = plan.moveTreatmentPlan.find((t) => t.pacing === 'skipped');
    if (!prunedEntry) return { ok: false, error: 'fixture did not produce a skipped-pacing ply' };

    const timeline = lowerMod.lowerToTimeline(game, plan);
    const moveBeats = timeline.scenes[0]!.beats.filter((b) => b.kind === 'move');
    const zeroDurationBeatExists = moveBeats.some((b) => b.durationMs === 0);

    let timelineValid = true;
    try {
      invariantsMod.assertValidTimeline(timeline);
    } catch {
      timelineValid = false;
    }

    const assets = new assetManagerMod.AssetManager(pieceManifestMod.PIECE_MANIFEST, pieceLoaderMod.loadImage);
    const assetsLoaded = await assets.load();
    if (!assetsLoaded.ok) return { ok: false, error: 'asset load failed' };

    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 400;
    const ctx = canvas.getContext('2d')!;
    const dims = { width: 400, height: 400 };
    const state = {
      game: { gameRecord: game, timeline },
      playback: { activeSceneId: timeline.scenes[0]!.id, logicalTimeMs: 0, playing: false, rate: 1 },
      ui: { pendingError: null },
      assets: { pieces: 'ready' },
      analysis: { status: 'idle', progress: null, result: null, error: null }
    };

    let renderThrew = false;
    try {
      rendererMod.render(state, 0, ctx, dims, assets);
    } catch {
      renderThrew = true;
    }
    const data = ctx.getImageData(0, 0, 400, 400).data;
    const nonBlank = Array.from(data).some((v, i) => i % 4 !== 3 && v !== 255);

    return { ok: true, timelineValid, zeroDurationBeatExists, renderThrew, nonBlank };
  });

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.zeroDurationBeatExists).toBe(true);
  expect(result.timelineValid).toBe(true);
  expect(result.renderThrew).toBe(false);
  expect(result.nonBlank).toBe(true);
});
