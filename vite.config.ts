import { defineConfig } from 'vite';

// GitHub Pages serves this project as https://<user>.github.io/Chess_cinema_1/,
// not from the domain root — every asset URL Vite emits at build time (the JS
// bundle reference in index.html, and the /engine/ path
// src/analysis/engineAssets.ts builds from import.meta.env.BASE_URL) must be
// prefixed with this subpath or they 404 under Pages. Scoped to `command ===
// 'build'` only: the dev server (`vite`/`npm run dev`, also what
// playwright.config.ts's webServer runs) must keep serving at root `/`,
// since every existing test navigates to `/` with no baseURL configured —
// applying the Pages subpath there would 404 every one of them. The
// single-file artifact build (scripts/build-artifact.mjs) still runs
// `vite build` internally but never reads index.html or BASE_URL (see
// engineAssets.ts's inline-engine check, which is consulted first), so it is
// unaffected by this either way.
export default defineConfig(({ command }) => ({
  root: '.',
  base: command === 'build' ? '/Chess_cinema_1/' : '/',
  build: {
    target: 'es2022',
    outDir: 'dist'
  }
}));
