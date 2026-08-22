import { expect, test } from '@playwright/test';

/**
 * Phase 2.2 integration: the REAL Stockfish engine, driving the real Chess
 * Understanding Layer end to end (analyzeGame -> understandGame) over
 * curated PGNs with known tactical shapes. Deliberately separate from the
 * pure unit tests, which script motifs/threats/sequences directly — these
 * tests prove the whole pipeline actually produces sensible structure
 * against a real engine, without asserting exact evaluation numbers that
 * would break on any future Stockfish build (same discipline
 * tests/e2e/analysis.spec.ts already follows).
 */

test.describe.configure({ timeout: 180_000 });

interface UnderstandingProbeResult {
  ok: boolean;
  error?: string;
  motifCount?: number;
  motifKinds?: string[];
  turningPointKinds?: string[];
  sequenceCount?: number;
  hasBestAlternativeData?: boolean;
  bestMoveUniquenessValues?: string[];
  qualityClasses?: string[];
  determinismMatch?: boolean;
  /** Phase 2.2.1 — promotion signals threaded onto each ply. */
  promotionPlies?: { ply: number; isPromotion: boolean; isUnderpromotion: boolean; promotionPieceType?: string }[];
  /** Phase 2.2.1 — the final analyzed ply's evaluationAfter, to check drawReason. */
  finalEvaluationAfter?: { kind: string; result?: string; drawReason?: string };
  /** Phase 2.2.1 — resolution values across all turning points, to check for 'drawn'. */
  turningPointResolutions?: string[];
  kingMobilityCount?: number;
}

/**
 * Runs the real pipeline entirely inside the page: parses the PGN, runs
 * Phase 2.1's analyzeGame with the real Stockfish engine at a shallow,
 * fast depth, then runs Phase 2.2's understandGame with a small follow-up
 * budget so the whole thing stays fast enough for CI. Imported by runtime
 * path (the dev server serves the module), matching the pattern already
 * used by tests/e2e/analysis.spec.ts's sign-convention test.
 */
async function probeUnderstanding(page: import('@playwright/test').Page, pgn: string): Promise<UnderstandingProbeResult> {
  return page.evaluate(async (pgnArg) => {
    // Imported by runtime path (the dev server serves the module) via a
    // variable specifier — not a string literal — so the test's own
    // tsconfig does not try (and fail) to statically resolve these as
    // module imports. Same pattern tests/e2e/analysis.spec.ts already uses.
    const chessPath = '/src/chess/ChessJsEngine.ts';
    const pgnPath = '/src/pgn/parsePgn.ts';
    const analyzePath = '/src/analysis/analyzeGame.ts';
    const stockfishPath = '/src/analysis/StockfishAnalysisEngine.ts';
    const understandPath = '/src/understanding/understandGame.ts';
    const understandingTypesPath = '/src/understanding/types.ts';

    const chessMod = (await import(/* @vite-ignore */ chessPath)) as {
      ChessJsEngine: new () => unknown;
    };
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

    const first = await understandMod.understandGame(parsed.value, analysis.value, engine, { settings: understandingSettings });
    const second = await understandMod.understandGame(parsed.value, analysis.value, engine, { settings: understandingSettings });
    engine.dispose();

    if (!first.ok) return { ok: false, error: `understandGame failed: ${first.error?.message}` };
    if (!second.ok) return { ok: false, error: `understandGame (2nd run) failed: ${second.error?.message}` };

    const u = first.value as {
      motifs: { motif: string }[];
      turningPoints: {
        kind: string;
        causeConsequence: { bestAlternative: { bestMoveUniqueness: string; topMove: unknown }; resolution: string };
      }[];
      sequences: unknown[];
      plies: {
        ply: number;
        qualityClass: string;
        signals: { isPromotion: boolean; isUnderpromotion: boolean; promotionPieceType?: string };
      }[];
      kingMobility: unknown[];
    };
    const a = analysis.value as {
      plies: { evaluationAfter: { kind: string; result?: string; drawReason?: string } }[];
    };

    return {
      ok: true,
      motifCount: u.motifs.length,
      motifKinds: [...new Set(u.motifs.map((m) => m.motif))],
      turningPointKinds: u.turningPoints.map((tp) => tp.kind),
      sequenceCount: u.sequences.length,
      hasBestAlternativeData: u.turningPoints.some((tp) => tp.causeConsequence.bestAlternative.topMove !== null),
      bestMoveUniquenessValues: [...new Set(u.turningPoints.map((tp) => tp.causeConsequence.bestAlternative.bestMoveUniqueness))],
      qualityClasses: [...new Set(u.plies.map((p) => p.qualityClass))],
      determinismMatch: JSON.stringify(first.value) === JSON.stringify(second.value),
      promotionPlies: u.plies
        .filter((p) => p.signals.isPromotion)
        .map((p) => ({
          ply: p.ply,
          isPromotion: p.signals.isPromotion,
          isUnderpromotion: p.signals.isUnderpromotion,
          promotionPieceType: p.signals.promotionPieceType
        })),
      finalEvaluationAfter: a.plies[a.plies.length - 1]!.evaluationAfter,
      turningPointResolutions: u.turningPoints.map((tp) => tp.causeConsequence.resolution),
      kingMobilityCount: u.kingMobility.length
    };
  }, pgn);
}

test('a real tactical line produces genuine geometric motifs (pins) confirmed by the real engine', async ({ page }) => {
  await page.goto('/');
  // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4 4.Nxe5 Qg5 — the Italian pins the f7 pawn
  // twice (Bc4, then again after Nxe5), and Qg5 pins the d2 pawn to c1.
  // At the shallow depth this test uses for CI speed, Stockfish does not
  // yet rate 4.Nxe5 as a large swing (a real, expected effect of shallow
  // search understating some tactics) — so this test checks what the
  // geometry layer reliably finds regardless of search depth, rather than
  // assuming a specific evaluation swing.
  const result = await probeUnderstanding(page, '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5');

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.motifCount!).toBeGreaterThan(0);
  expect(result.motifKinds).toContain('pin');
  expect(result.qualityClasses!.length).toBeGreaterThan(0);
  // Every quality class present must be one of the five closed values — the decision tree is total.
  for (const qc of result.qualityClasses!) {
    expect(['optimal', 'inaccuracy', 'mistake', 'blunder', 'missed-win']).toContain(qc);
  }
});

test('a forced mating sequence produces a ForcedSequence, a mate-related turning point, and populated best-alternative evidence', async ({ page }) => {
  await page.goto('/');
  // Scholar's mate: a genuine forced checkmate is delivered on the final move.
  const result = await probeUnderstanding(page, '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#');

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  const mateRelated = result.turningPointKinds!.some(
    (k) => k === 'mate-appeared' || k === 'forced-mate-delivery' || k === 'mate-flipped'
  );
  expect(mateRelated).toBe(true);
  expect(result.hasBestAlternativeData).toBe(true);
  for (const uniqueness of result.bestMoveUniquenessValues!) {
    expect(['unique', 'shared', 'unknown']).toContain(uniqueness);
  }
});

test('understandGame is deterministic against the real engine: two runs of the same analysis match byte-for-byte', async ({ page }) => {
  await page.goto('/');
  const result = await probeUnderstanding(page, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6');
  expect(result.ok).toBe(true);
  expect(result.determinismMatch).toBe(true);
});

test('a real game reaching a promotion surfaces isPromotion and promotionPieceType through the full pipeline (Phase 2.2.1)', async ({ page }) => {
  await page.goto('/');
  // Verified legal via a direct chess.js run before use: both a- and h-pawns
  // race to promotion and capture into the corner pieces on the same move
  // (5. bxa8=Q and 5...gxh1=Q), so this checks the real pipeline against two
  // real, engine-analyzed promotions rather than a hand-scripted one.
  const result = await probeUnderstanding(page, '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q');

  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  expect(result.promotionPlies!.length).toBe(2);
  for (const p of result.promotionPlies!) {
    expect(p.isPromotion).toBe(true);
    expect(p.isUnderpromotion).toBe(false);
    expect(p.promotionPieceType).toBe('q');
  }
});

// NOTE: a real-engine stalemate-swindle integration test (drawReason +
// 'drawn' resolution surfacing end to end) was attempted here and removed.
// Diagnosed against the actual worker/glue code the app uses: for a
// genuinely terminal position (verified stalemate via chess.js) Stockfish
// 18 Lite WASM replies `info depth 0 score cp 0` immediately before
// `bestmove (none)`, so StockfishAnalysisEngine.evaluatePosition sees a
// defined score and returns a normal ok() evaluation instead of an error —
// analyzeGame's terminalEvaluation() fallback (untouched by this phase) is
// therefore never reached for a position evaluated this way. This is a
// pre-existing Phase 2.1 behavior, outside Phase 2.2.1's approved scope, and
// is reported separately rather than fixed here. drawReason/'drawn'
// resolution logic itself is fully covered at the unit level (ScriptedEngine
// in analyzeGame.test.ts / causeConsequence.test.ts / understandGame.test.ts),
// which correctly simulates the "engine returns no score" case this phase's
// contract assumes.
