import { ChessJsEngine } from '../chess/ChessJsEngine';
import { AssetManager } from '../assets/AssetManager';
import { PIECE_MANIFEST } from '../assets/pieceManifest';
import { loadImage } from '../assets/browserPieceLoader';
import { createInitialState, type AppState } from '../state/AppState';
import { Store } from '../state/store';
import { goToNextMove, goToPreviousMove, loadPgn, restart, seekTo, setPlaying } from '../state/actions';
import { cancelAnalysis, runAnalysis } from '../state/analysisActions';
import { StockfishAnalysisEngine } from '../analysis/StockfishAnalysisEngine';
import { formatEvaluation, formatSwingCp } from '../analysis/evaluation';
import { currentMoveNumber, totalMoveCount } from '../timeline/navigation';
import { PreviewLoop, previewTick } from '../preview/PreviewLoop';
import { runExport } from '../export/runExport';
import { PngSequenceEncoder } from '../export/PngSequenceEncoder';
import type { RenderDims } from '../render/coords';
import { mountTimelineControl } from './TimelineControl';

const MAX_BOARD_SIZE = 480;
const BOARD_VIEWPORT_FRACTION = 0.94;
const EXPORT_FPS = 24;

/**
 * Phase 1.1's UI: load a PGN, play/pause, restart, step to the previous
 * or next move, and scrub a touch-friendly timeline — plus export. Still
 * no board editing, drag-to-move, or annotation authoring (see
 * docs/architecture.md Correction 5). Every control here only ever
 * dispatches the existing playback actions (seekTo/setPlaying/restart/
 * goToNextMove/goToPreviousMove) — none of it holds its own notion of
 * position or time; Timeline + playback.logicalTimeMs stay the sole
 * source of truth, per Corrections 1 and 2.
 */
export function mountPanel(root: HTMLElement): void {
  const store = new Store<AppState>(createInitialState());
  const engine = new ChessJsEngine();
  const assets = new AssetManager<HTMLImageElement>(PIECE_MANIFEST, loadImage);

  const boardCssSize = Math.min(window.innerWidth * BOARD_VIEWPORT_FRACTION, MAX_BOARD_SIZE);

  root.innerHTML = `
    <style>
      .cc-btn {
        min-height: 44px;
        min-width: 44px;
        padding: 10px 14px;
        font-size: 15px;
        border-radius: 8px;
        border: 1px solid #ccc;
        background: #f5f5f5;
        touch-action: manipulation;
      }
      .cc-btn:active { background: #e2e2e2; }
      .cc-btn:disabled { opacity: 0.45; }
    </style>
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;">
      <h1 style="font-size:16px;margin:0;">Chess Cinema — Phase 2.1</h1>
      <textarea id="pgn-input" rows="4" style="width:100%;box-sizing:border-box;" placeholder="Paste PGN here">1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7</textarea>
      <button id="load-btn" class="cc-btn">Load PGN</button>
      <div id="error" style="color:#b00020;"></div>

      <div id="board-wrap" style="width:${boardCssSize}px;height:${boardCssSize}px;margin:0 auto;">
        <canvas id="board" style="width:100%;height:100%;display:block;border:1px solid #ccc;box-sizing:border-box;"></canvas>
      </div>

      <div id="move-indicator" style="text-align:center;font-size:13px;color:#555;font-variant-numeric:tabular-nums;"></div>

      <div id="timeline-container"></div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;">
        <button id="restart-btn" class="cc-btn" disabled>⏮ Restart</button>
        <button id="prev-btn" class="cc-btn" disabled>◀ Prev</button>
        <button id="play-btn" class="cc-btn" disabled>Play</button>
        <button id="next-btn" class="cc-btn" disabled>Next ▶</button>
      </div>

      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;">
        <button id="export-btn" class="cc-btn" disabled>Export PNG sequence</button>
        <span id="export-progress"></span>
      </div>

      <hr style="border:none;border-top:1px solid #ddd;margin:4px 0;" />

      <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;">
        <button id="analyze-btn" class="cc-btn" disabled>Analyze Game</button>
        <button id="cancel-analysis-btn" class="cc-btn" disabled>Cancel</button>
      </div>
      <div id="analysis-status" style="text-align:center;font-size:13px;color:#555;font-variant-numeric:tabular-nums;"></div>
      <div id="analysis-candidates" style="font-size:13px;"></div>
    </div>
  `;

  const pgnInput = root.querySelector<HTMLTextAreaElement>('#pgn-input')!;
  const loadBtn = root.querySelector<HTMLButtonElement>('#load-btn')!;
  const errorEl = root.querySelector<HTMLDivElement>('#error')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#board')!;
  const moveIndicator = root.querySelector<HTMLDivElement>('#move-indicator')!;
  const timelineContainer = root.querySelector<HTMLDivElement>('#timeline-container')!;
  const restartBtn = root.querySelector<HTMLButtonElement>('#restart-btn')!;
  const prevBtn = root.querySelector<HTMLButtonElement>('#prev-btn')!;
  const playBtn = root.querySelector<HTMLButtonElement>('#play-btn')!;
  const nextBtn = root.querySelector<HTMLButtonElement>('#next-btn')!;
  const exportBtn = root.querySelector<HTMLButtonElement>('#export-btn')!;
  const exportProgress = root.querySelector<HTMLSpanElement>('#export-progress')!;
  const analyzeBtn = root.querySelector<HTMLButtonElement>('#analyze-btn')!;
  const cancelAnalysisBtn = root.querySelector<HTMLButtonElement>('#cancel-analysis-btn')!;
  const analysisStatus = root.querySelector<HTMLDivElement>('#analysis-status')!;
  const analysisCandidates = root.querySelector<HTMLDivElement>('#analysis-candidates')!;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(boardCssSize * dpr);
  canvas.height = Math.round(boardCssSize * dpr);
  const ctx = canvas.getContext('2d')!;
  const dims: RenderDims = { width: canvas.width, height: canvas.height };

  const previewLoop = new PreviewLoop(store, ctx, dims, assets);

  /** Renders immediately rather than waiting for the next rAF tick — used after
   * every discrete navigation action so scrubbing/stepping feels instant. Calls
   * the same previewTick (and therefore the same render/Renderer.render) the
   * running PreviewLoop itself calls every frame — not a second render path. */
  function renderNow(): void {
    previewTick(store, ctx, dims, assets);
  }

  const timeline = mountTimelineControl(timelineContainer, {
    onSeek: (logicalTimeMs) => {
      setPlaying(store, false);
      seekTo(store, logicalTimeMs);
      renderNow();
    }
  });

  function dispatchNav(action: (s: Store<AppState>) => void): void {
    action(store);
    renderNow();
  }

  function setEnabled(loaded: boolean): void {
    playBtn.disabled = !loaded;
    restartBtn.disabled = !loaded;
    prevBtn.disabled = !loaded;
    nextBtn.disabled = !loaded;
    exportBtn.disabled = !loaded;
    analyzeBtn.disabled = !loaded;
  }

  function renderAnalysis(state: AppState): void {
    const { status, progress, result, error } = state.analysis;
    const running = status === 'running';

    analyzeBtn.disabled = state.game === null || running;
    cancelAnalysisBtn.disabled = !running;
    analyzeBtn.textContent = running ? 'Analyzing…' : 'Analyze Game';

    if (running) {
      analysisStatus.textContent = progress
        ? `Analyzing ${progress.completed} / ${progress.total}`
        : 'Starting analysis…';
    } else if (status === 'error') {
      analysisStatus.textContent = error?.message ?? 'Analysis failed.';
    } else if (status === 'complete' && result) {
      analysisStatus.textContent = `Analysis complete — ${result.plies.length} moves at depth ${result.settings.depth}.`;
    } else {
      analysisStatus.textContent = '';
    }

    if (status === 'complete' && result) {
      if (result.candidates.length === 0) {
        analysisCandidates.innerHTML =
          '<div style="color:#555;">No significant evaluation swings found.</div>';
      } else {
        const rows = result.candidates
          .map((c) => {
            const mover = c.sideToMove === 'w' ? 'White' : 'Black';
            const mate = c.mateTransition === 'none' ? '' : ` · ${c.mateTransition}`;
            return `<li style="padding:6px 0;border-bottom:1px solid #eee;">
              <strong>Move ${c.moveNumber} (${mover}) ${escapeHtml(c.movePlayedSan)}</strong><br />
              <span style="color:#555;font-variant-numeric:tabular-nums;">
                ${escapeHtml(formatEvaluation(c.evaluationBefore))} →
                ${escapeHtml(formatEvaluation(c.evaluationAfter))} ·
                swing ${escapeHtml(formatSwingCp(c.swingForMoverCp))} for ${mover}${escapeHtml(mate)}
              </span>
            </li>`;
          })
          .join('');
        analysisCandidates.innerHTML = `
          <div style="font-weight:600;margin-bottom:4px;">Candidate moments (${result.candidates.length})</div>
          <ul style="list-style:none;padding:0;margin:0;">${rows}</ul>`;
      }
    } else {
      analysisCandidates.innerHTML = '';
    }
  }

  function refreshUiFromState(): void {
    const state = store.getState();
    errorEl.textContent = state.ui.pendingError?.message ?? '';
    playBtn.textContent = state.playback.playing ? 'Pause' : 'Play';

    if (state.game) {
      const scene = state.game.timeline.scenes.find((s) => s.id === state.playback.activeSceneId);
      if (scene) {
        timeline.setValue(state.playback.logicalTimeMs, scene.durationMs);
        const move = currentMoveNumber(scene, state.playback.logicalTimeMs);
        const total = totalMoveCount(scene);
        const seconds = (state.playback.logicalTimeMs / 1000).toFixed(1);
        const totalSeconds = (scene.durationMs / 1000).toFixed(1);
        moveIndicator.textContent = `Move ${move} / ${total}  ·  ${seconds}s / ${totalSeconds}s`;
      }
    } else {
      moveIndicator.textContent = '';
      timeline.setValue(0, 0);
    }

    renderAnalysis(state);
  }

  store.subscribe(refreshUiFromState);

  loadBtn.addEventListener('click', () => {
    const result = loadPgn(store, pgnInput.value, engine);
    setEnabled(result.ok);
    renderNow();
  });

  playBtn.addEventListener('click', () => {
    setPlaying(store, !store.getState().playback.playing);
  });

  restartBtn.addEventListener('click', () => dispatchNav(restart));
  prevBtn.addEventListener('click', () => dispatchNav(goToPreviousMove));
  nextBtn.addEventListener('click', () => dispatchNav(goToNextMove));

  exportBtn.addEventListener('click', () => {
    void handleExport();
  });

  analyzeBtn.addEventListener('click', () => {
    setPlaying(store, false);
    // A fresh engine per run keeps a failed or cancelled run from leaving a
    // half-dead worker behind for the next one.
    const analysisEngine = new StockfishAnalysisEngine();
    void runAnalysis(store, analysisEngine, new ChessJsEngine()).finally(() => {
      analysisEngine.dispose();
    });
  });

  cancelAnalysisBtn.addEventListener('click', () => {
    cancelAnalysis();
  });

  async function handleExport(): Promise<void> {
    const state = store.getState();
    if (!state.game) return;
    setPlaying(store, false);
    exportBtn.disabled = true;
    exportProgress.textContent = 'Exporting… 0%';

    try {
      const encoder = new PngSequenceEncoder();
      const blob = await runExport(state, assets, encoder, {
        fps: EXPORT_FPS,
        dims,
        onProgress: (done, total) => {
          exportProgress.textContent = `Exporting… ${Math.round((done / total) * 100)}%`;
        }
      });
      if (blob) downloadBlob(blob, 'chess-cinema-export.zip');
      exportProgress.textContent = 'Export complete.';
    } catch (cause) {
      exportProgress.textContent = 'Export failed — see console for details.';
      console.error('Export failed:', cause);
    } finally {
      exportBtn.disabled = false;
    }
  }

  void assets.load().then((result) => {
    if (!result.ok) {
      errorEl.textContent = result.error.message;
      return;
    }
    previewLoop.start();
  });
}

/** Move text and engine strings are inserted as HTML, so they are escaped first. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
