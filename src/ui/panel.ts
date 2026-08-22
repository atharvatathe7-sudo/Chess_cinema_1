import { ChessJsEngine } from '../chess/ChessJsEngine';
import { AssetManager } from '../assets/AssetManager';
import { PIECE_MANIFEST } from '../assets/pieceManifest';
import { loadImage } from '../assets/browserPieceLoader';
import { createInitialState, type AppState } from '../state/AppState';
import { Store } from '../state/store';
import { loadPgn, seekTo, setPlaying } from '../state/actions';
import { PreviewLoop } from '../preview/PreviewLoop';
import { runExport } from '../export/runExport';
import { PngSequenceEncoder } from '../export/PngSequenceEncoder';
import type { RenderDims } from '../render/coords';

const BOARD_SIZE = 480;
const EXPORT_FPS = 24;

/**
 * Phase 1's entire UI: load a PGN, play/pause/scrub, export a PNG
 * sequence. No board editing, no drag-to-move, no annotation authoring
 * — Phase 1 validates the architecture, not editor UX (see
 * docs/architecture.md Correction 5).
 */
export function mountPanel(root: HTMLElement): void {
  const store = new Store<AppState>(createInitialState());
  const engine = new ChessJsEngine();
  const assets = new AssetManager<HTMLImageElement>(PIECE_MANIFEST, loadImage);

  root.innerHTML = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:16px;display:flex;flex-direction:column;gap:12px;">
      <h1 style="font-size:16px;margin:0;">Chess Cinema — Phase 1</h1>
      <textarea id="pgn-input" rows="4" style="width:100%;box-sizing:border-box;" placeholder="Paste PGN here">1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7</textarea>
      <button id="load-btn">Load PGN</button>
      <div id="error" style="color:#b00020;"></div>
      <canvas id="board" width="${BOARD_SIZE}" height="${BOARD_SIZE}" style="border:1px solid #ccc;max-width:100%;"></canvas>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="play-btn" disabled>Play</button>
        <input id="scrub" type="range" min="0" max="0" value="0" style="flex:1;" disabled />
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button id="export-btn" disabled>Export PNG sequence</button>
        <span id="export-progress"></span>
      </div>
    </div>
  `;

  const pgnInput = root.querySelector<HTMLTextAreaElement>('#pgn-input')!;
  const loadBtn = root.querySelector<HTMLButtonElement>('#load-btn')!;
  const errorEl = root.querySelector<HTMLDivElement>('#error')!;
  const canvas = root.querySelector<HTMLCanvasElement>('#board')!;
  const playBtn = root.querySelector<HTMLButtonElement>('#play-btn')!;
  const scrub = root.querySelector<HTMLInputElement>('#scrub')!;
  const exportBtn = root.querySelector<HTMLButtonElement>('#export-btn')!;
  const exportProgress = root.querySelector<HTMLSpanElement>('#export-progress')!;

  const dpr = window.devicePixelRatio || 1;
  canvas.width = BOARD_SIZE * dpr;
  canvas.height = BOARD_SIZE * dpr;
  const ctx = canvas.getContext('2d')!;
  const dims: RenderDims = { width: canvas.width, height: canvas.height };

  const previewLoop = new PreviewLoop(store, ctx, dims, assets);

  function setEnabled(loaded: boolean): void {
    playBtn.disabled = !loaded;
    scrub.disabled = !loaded;
    exportBtn.disabled = !loaded;
  }

  function refreshUiFromState(): void {
    const state = store.getState();
    errorEl.textContent = state.ui.pendingError?.message ?? '';
    playBtn.textContent = state.playback.playing ? 'Pause' : 'Play';
    if (state.game) {
      const scene = state.game.timeline.scenes.find((s) => s.id === state.playback.activeSceneId);
      if (scene) {
        scrub.max = String(scene.durationMs);
        if (Number(scrub.value) !== state.playback.logicalTimeMs) {
          scrub.value = String(state.playback.logicalTimeMs);
        }
      }
    }
  }

  store.subscribe(refreshUiFromState);

  loadBtn.addEventListener('click', () => {
    const result = loadPgn(store, pgnInput.value, engine);
    setEnabled(result.ok);
  });

  playBtn.addEventListener('click', () => {
    setPlaying(store, !store.getState().playback.playing);
  });

  scrub.addEventListener('input', () => {
    setPlaying(store, false);
    seekTo(store, Number(scrub.value));
  });

  exportBtn.addEventListener('click', () => {
    void handleExport();
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
