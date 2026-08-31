#!/usr/bin/env node
/**
 * Chess Cinema — Intelligence Evaluation System: corpus runner.
 *
 * READ-ONLY against the application. This script imports and calls the app's
 * own already-shipped functions (state/actions, state/analysisActions,
 * state/directionActions, state/moments, export/drawHook) through a real
 * browser, exactly the way ui/panel.ts drives them when a human clicks
 * Load PGN -> Analyze Game -> Generate Cinematic. It changes nothing about
 * how a cinematic is generated; it only records what the director decided.
 *
 * Why a browser and not plain Node: the analysis engine is Stockfish WASM in
 * a Web Worker (src/analysis/engineAssets.ts builds blob URLs and calls
 * `new Worker`). There is no Node code path for it, and inventing one would
 * mean a second engine integration — exactly what this project has avoided
 * everywhere else. So the runner reuses the same Playwright + Vite dev
 * server pattern the existing e2e suite already uses.
 *
 * Usage:
 *   node tools/evaluation/runCorpus.mjs
 *   node tools/evaluation/runCorpus.mjs --corpus tools/evaluation/corpus/real
 *   node tools/evaluation/runCorpus.mjs --filter evergreen
 *   node tools/evaluation/runCorpus.mjs --base-url http://localhost:5173
 */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CAPTURE_SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const args = {
    corpus: join(PROJECT_ROOT, 'tools/evaluation/corpus'),
    out: join(PROJECT_ROOT, 'tools/evaluation/out'),
    baseUrl: null,
    port: 4319,
    filter: null
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--corpus') { args.corpus = resolve(value); i++; }
    else if (flag === '--out') { args.out = resolve(value); i++; }
    else if (flag === '--base-url') { args.baseUrl = value; i++; }
    else if (flag === '--port') { args.port = Number(value); i++; }
    else if (flag === '--filter') { args.filter = value; i++; }
    else if (flag === '--help' || flag === '-h') { console.log(HELP); process.exit(0); }
    else { throw new Error(`Unknown argument: ${flag}`); }
  }
  return args;
}

const HELP = `Chess Cinema corpus runner
  --corpus <dir>    Folder of .pgn files, searched recursively (default tools/evaluation/corpus)
  --out <dir>       Where per-game capture JSON is written (default tools/evaluation/out)
  --base-url <url>  Use an already-running dev server instead of spawning one
  --port <n>        Port to spawn the dev server on (default 4319)
  --filter <substr> Only run PGN files whose path contains this substring`;

/** Recursively collects .pgn paths, sorted, so a run is order-deterministic. */
async function findPgnFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await findPgnFiles(full)));
    else if (extname(entry.name).toLowerCase() === '.pgn') files.push(full);
  }
  return files;
}

/** PGN seven-tag-roster style headers, read for provenance only — the app does its own parsing. */
function parseHeaders(pgnText) {
  const headers = {};
  for (const match of pgnText.matchAll(/^\s*\[(\w+)\s+"([^"]*)"\]\s*$/gm)) {
    headers[match[1]] = match[2];
  }
  return headers;
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Dev server at ${url} did not become ready within ${timeoutMs}ms`);
}

/**
 * Everything below runs INSIDE the page. It only reads: it calls the app's
 * own pipeline entry points and then copies values off the resulting state.
 * No app module is patched, stubbed, or re-implemented here.
 */
async function capture(page, pgnText) {
  return page.evaluate(async (pgn) => {
    /* eslint-disable */
    // @ts-expect-error — Vite-only absolute module specifier
    const { ChessJsEngine } = await import('/src/chess/ChessJsEngine.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { createInitialState } = await import('/src/state/AppState.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { Store } = await import('/src/state/store.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { loadPgn } = await import('/src/state/actions.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { runAnalysis } = await import('/src/state/analysisActions.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { runDirection } = await import('/src/state/directionActions.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { StockfishAnalysisEngine } = await import('/src/analysis/StockfishAnalysisEngine.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { deriveCinematicMoments } = await import('/src/state/moments.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { selectHook } = await import('/src/export/drawHook.ts');

    const timings = {};
    const store = new Store(createInitialState());

    const tLoad = performance.now();
    const loadResult = loadPgn(store, pgn, new ChessJsEngine());
    timings.loadMs = Math.round(performance.now() - tLoad);
    if (!loadResult.ok) {
      return { ok: false, stage: 'load', error: store.getState().ui.pendingError?.message ?? 'PGN failed to load' };
    }

    const tAnalyze = performance.now();
    const analysisEngine = new StockfishAnalysisEngine();
    await runAnalysis(store, analysisEngine, new ChessJsEngine());
    analysisEngine.dispose();
    timings.analyzeMs = Math.round(performance.now() - tAnalyze);
    if (store.getState().analysis.status !== 'complete') {
      return { ok: false, stage: 'analyze', error: store.getState().analysis.error?.message ?? 'analysis did not complete' };
    }

    const tDirect = performance.now();
    const directionEngine = new StockfishAnalysisEngine();
    await runDirection(store, directionEngine, new ChessJsEngine());
    directionEngine.dispose();
    timings.directMs = Math.round(performance.now() - tDirect);
    if (store.getState().direction.status !== 'complete') {
      return { ok: false, stage: 'direct', error: store.getState().direction.error?.message ?? 'direction did not complete' };
    }

    const state = store.getState();
    const analysis = state.analysis.result;
    const { cinematicPlan, understanding, story } = state.direction.result;
    const scene = state.game.timeline.scenes[0];
    const moves = state.game.gameRecord.moves;

    const sanByPly = new Map(moves.map((m) => [m.ply, m.san]));
    const san = (ply) => sanByPly.get(ply) ?? null;

    const moments = deriveCinematicMoments(cinematicPlan, state.game.timeline, analysis, understanding, story);
    const hook = selectHook(story, analysis);

    // The story's own pick of "the" decisive move, resolved from id to a real move.
    const turningPointById = new Map(understanding.turningPoints.map((tp) => [tp.id, tp]));
    const primaryTp = story.centralConflict ? turningPointById.get(story.centralConflict.primaryTurningPointId) ?? null : null;
    const climaxBeat = story.beats.find((b) => b.role === 'climax') ?? null;

    const lastPly = analysis.plies.length > 0 ? analysis.plies[analysis.plies.length - 1] : null;
    const terminalPly = moves.length > 0 ? moves[moves.length - 1].ply : null;

    // Biggest RAW Stockfish swing, independent of any narrative judgement —
    // this is the thing the director is suspected of over-trusting, so it is
    // recorded side by side with what the story actually chose.
    const byRawSwing = [...analysis.candidates].sort(
      (a, b) => Math.abs(b.swingCp) - Math.abs(a.swingCp) || a.ply - b.ply
    );
    const topRawSwing = byRawSwing[0] ?? null;
    const topRanked = analysis.candidates[0] ?? null; // candidates are already rankScore-ordered

    const momentRows = moments.map((m) => ({
      id: m.id,
      kind: m.kind,
      label: m.label,
      reason: m.reason,
      fromPly: m.fromPly,
      toPly: m.toPly,
      fromSan: san(m.fromPly),
      toSan: san(m.toPly),
      atMs: m.atMs,
      untilMs: m.untilMs,
      targetTimeMs: m.targetTimeMs,
      narratives: m.narratives.map((n) => ({ label: n.label, reason: n.reason })),
      // Exactly what export/drawCaptions.ts burns in: the PRIMARY narrative only.
      captionText: `${m.label} — ${m.reason}`
    }));

    return {
      ok: true,
      timings,
      game: {
        moveCount: moves.length,
        plyCount: analysis.plies.length,
        moves: moves.map((m) => ({ ply: m.ply, san: m.san })),
        terminalPly,
        terminalSan: terminalPly === null ? null : san(terminalPly),
        lastPlyEvaluationAfter: lastPly ? lastPly.evaluationAfter : null,
        finalPositionIsTerminal: cinematicPlan.finalPositionIsTerminal
      },
      analysis: {
        settings: analysis.settings,
        candidateCount: analysis.candidates.length,
        candidates: analysis.candidates.map((c) => ({
          ply: c.ply,
          moveNumber: c.moveNumber,
          sideToMove: c.sideToMove,
          san: c.movePlayedSan,
          swingCp: c.swingCp,
          swingForMoverCp: c.swingForMoverCp,
          mateTransition: c.mateTransition,
          rankScore: c.rankScore,
          evaluationBefore: c.evaluationBefore,
          evaluationAfter: c.evaluationAfter
        }))
      },
      understanding: {
        motifCount: understanding.motifs.length,
        threatCount: understanding.threats.length,
        motifs: understanding.motifs.map((m) => ({ id: m.id, ply: m.ply, motif: m.motif, san: san(m.ply) })),
        sequences: understanding.sequences.map((s) => ({
          id: s.id,
          startPly: s.startPly,
          endPly: s.endPly,
          plies: s.plies,
          forcingReason: s.forcingReason,
          verifiedDepth: s.verifiedDepth ?? null
        })),
        turningPoints: understanding.turningPoints.map((tp) => ({
          id: tp.id,
          ply: tp.ply,
          san: san(tp.ply),
          kind: tp.kind,
          significanceScore: tp.significance.score,
          significanceReasons: tp.significance.reasons,
          mechanism: tp.causeConsequence.mechanism,
          swingForMoverCp: tp.causeConsequence.immediateChange.evaluationDelta.swingForMoverCp,
          materialDelta: tp.causeConsequence.immediateChange.materialDelta,
          threatsCreated: tp.causeConsequence.threatsCreated.length,
          evaluationConsequenceAtPly: tp.causeConsequence.evaluationConsequence.atPly,
          multiMoveConsequence: tp.causeConsequence.multiMoveConsequence ?? null
        })),
        narrativeSignals: understanding.narrativeSignals.map((s) => ({
          archetype: s.archetype ?? null,
          kind: s.kind ?? null,
          plies: s.plies ?? null
        })),
        gameArc: understanding.gameArc
      },
      story: {
        hasCentralConflict: story.centralConflict !== null,
        noConflictReason: story.noConflictReason ?? null,
        centralConflict: story.centralConflict
          ? {
              primaryTurningPointId: story.centralConflict.primaryTurningPointId,
              primaryPly: primaryTp ? primaryTp.ply : null,
              primarySan: primaryTp ? san(primaryTp.ply) : null,
              primaryKind: primaryTp ? primaryTp.kind : null,
              primarySignificance: primaryTp ? primaryTp.significance.score : null,
              causalChain: story.centralConflict.causalChain,
              causalChainLength: story.centralConflict.causalChain.length,
              secondaryConflictIds: story.centralConflict.secondaryConflicts,
              secondaryPlies: story.centralConflict.secondaryConflicts
                .map((id) => turningPointById.get(id))
                .filter(Boolean)
                .map((tp) => ({ ply: tp.ply, san: san(tp.ply), score: tp.significance.score }))
            }
          : null,
        beats: story.beats.map((b) => ({
          id: b.id,
          role: b.role,
          plies: b.plies,
          sans: b.plies.map((p) => san(p)),
          salience: b.salience,
          evidenceRefs: b.evidenceRefs
        })),
        climaxBeat: climaxBeat
          ? { id: climaxBeat.id, plies: climaxBeat.plies, sans: climaxBeat.plies.map((p) => san(p)), salience: climaxBeat.salience }
          : null,
        archetypeSignals: story.archetypeSignals.map((a) => ({
          archetype: a.archetype,
          plies: a.plies,
          beatIds: a.beatIds
        })),
        moveTreatmentCounts: story.moveTreatment.reduce((acc, t) => {
          acc[t.treatment] = (acc[t.treatment] ?? 0) + 1;
          return acc;
        }, {})
      },
      director: {
        schemaVersion: cinematicPlan.schemaVersion,
        finalPositionIsTerminal: cinematicPlan.finalPositionIsTerminal,
        cameraDirectives: cinematicPlan.cameraDirectives.map((d) => ({
          atPly: d.atPly,
          san: san(d.atPly),
          squares: d.squares
        })),
        annotationDirectives: cinematicPlan.annotationDirectives.map((d) => ({
          kind: d.kind,
          fromPly: d.fromPly,
          toPly: d.toPly,
          fromSan: san(d.fromPly),
          toSan: san(d.toPly)
        })),
        annotationKindCounts: cinematicPlan.annotationDirectives.reduce((acc, d) => {
          acc[d.kind] = (acc[d.kind] ?? 0) + 1;
          return acc;
        }, {}),
        settings: cinematicPlan.settings
      },
      moments: momentRows,
      hook: hook ?? null,
      timeline: {
        sceneDurationMs: scene.durationMs,
        moveBeatCount: scene.beats.filter((b) => b.kind === 'move').length,
        cameraKeyframes: scene.cameraPlan.keyframes.map((k) => ({
          atMs: k.atMs,
          centerX: k.centerX,
          centerY: k.centerY,
          zoom: k.zoom
        }))
      },
      /**
       * The comparison the human labeller actually needs, precomputed: what
       * the raw engine thought was biggest, versus what the story chose,
       * versus what the game actually ended on, versus what got shown.
       */
      divergence: {
        topRawSwing: topRawSwing
          ? { ply: topRawSwing.ply, san: topRawSwing.movePlayedSan, swingCp: topRawSwing.swingCp, rankScore: topRawSwing.rankScore }
          : null,
        topRankedCandidate: topRanked
          ? { ply: topRanked.ply, san: topRanked.movePlayedSan, swingCp: topRanked.swingCp, rankScore: topRanked.rankScore }
          : null,
        storyClimaxPlies: climaxBeat ? climaxBeat.plies : null,
        storyPrimaryPly: primaryTp ? primaryTp.ply : null,
        terminalPly,
        cameraFocusPlies: cinematicPlan.cameraDirectives.map((d) => d.atPly),
        momentPlies: moments.map((m) => m.toPly),
        momentKinds: moments.map((m) => m.kind),
        /** True when the camera never framed the move that actually ended the game. */
        terminalMoveHasCameraFocus:
          terminalPly === null ? null : cinematicPlan.cameraDirectives.some((d) => d.atPly === terminalPly),
        /** True when the story's decisive pick is not the biggest raw swing — the suspected failure signature. */
        storyDivergesFromTopRawSwing:
          primaryTp && topRawSwing ? primaryTp.ply !== topRawSwing.ply : null
      }
    };
    /* eslint-enable */
  }, pgnText);
}

async function main() {
  const args = parseArgs(process.argv);
  await mkdir(args.out, { recursive: true });

  const files = (await findPgnFiles(args.corpus)).filter((f) => !args.filter || f.includes(args.filter));
  if (files.length === 0) {
    console.error(`No .pgn files found under ${args.corpus}${args.filter ? ` matching "${args.filter}"` : ''}`);
    process.exit(1);
  }
  console.log(`Found ${files.length} PGN file(s) under ${relative(PROJECT_ROOT, args.corpus)}\n`);

  let server = null;
  let baseUrl = args.baseUrl;
  if (!baseUrl) {
    baseUrl = `http://localhost:${args.port}/`;
    console.log(`Starting dev server on port ${args.port}…`);
    server = spawn('npx', ['vite', '--port', String(args.port), '--strictPort'], {
      cwd: PROJECT_ROOT,
      stdio: 'ignore',
      detached: false
    });
    await waitForServer(baseUrl);
    console.log('Dev server ready.\n');
  }

  const browser = await chromium.launch();
  const index = { schemaVersion: CAPTURE_SCHEMA_VERSION, startedAt: new Date().toISOString(), games: [] };
  let failures = 0;

  try {
    for (const file of files) {
      const gameId = basename(file, extname(file));
      const pgnText = await readFile(file, 'utf8');
      const headers = parseHeaders(pgnText);
      const started = Date.now();
      process.stdout.write(`▶ ${gameId} … `);

      const page = await browser.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', (e) => pageErrors.push(String(e)));

      let result;
      try {
        await page.goto(baseUrl);
        await page.waitForSelector('#pgn-input', { timeout: 30_000 });
        result = await capture(page, pgnText);
      } catch (cause) {
        result = { ok: false, stage: 'runner', error: String(cause) };
      } finally {
        await page.close();
      }

      const record = {
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        gameId,
        capturedAt: new Date().toISOString(),
        source: {
          file: relative(PROJECT_ROOT, file),
          headers,
          declaredResult: headers.Result ?? null,
          declaredTermination: headers.Termination ?? null,
          declaredGameType: headers.CCGameType ?? null
        },
        runtimeMs: Date.now() - started,
        consoleErrors,
        pageErrors,
        ...result
      };

      await writeFile(join(args.out, `${gameId}.json`), JSON.stringify(record, null, 2));

      if (result.ok) {
        console.log(
          `ok (${record.runtimeMs}ms) — ${result.moments.length} moment(s), ` +
            `story ply ${result.divergence.storyPrimaryPly ?? '—'}, ` +
            `top raw swing ply ${result.divergence.topRawSwing?.ply ?? '—'}, ` +
            `terminal ply ${result.divergence.terminalPly ?? '—'}`
        );
      } else {
        failures++;
        console.log(`FAILED at ${result.stage}: ${result.error}`);
      }

      index.games.push({
        gameId,
        file: record.source.file,
        ok: result.ok,
        runtimeMs: record.runtimeMs,
        consoleErrors: consoleErrors.length,
        pageErrors: pageErrors.length
      });
    }
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
    }
  }

  index.finishedAt = new Date().toISOString();
  index.total = files.length;
  index.failed = failures;
  await writeFile(join(args.out, '_index.json'), JSON.stringify(index, null, 2));

  console.log(`\nWrote ${files.length} capture(s) to ${relative(PROJECT_ROOT, args.out)}/`);
  if (failures > 0) {
    console.error(`${failures} game(s) failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
