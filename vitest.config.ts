import { defineConfig } from 'vitest/config';

// Vitest covers pure-logic unit tests only (no canvas/DOM rendering).
// Anything that needs real Canvas 2D rendering (the Renderer itself, and
// the acceptance tests that compare pixel output) runs under Playwright
// against real Chromium instead of a Node canvas shim — see
// docs/architecture.md "Testing architecture" for the rationale. Those
// files use the *.spec.ts suffix and are excluded here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
