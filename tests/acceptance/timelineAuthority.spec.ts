import { expect, test } from '@playwright/test';

const PGN = '1. e4 e5 2. Nf3 Nc6';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html');
  await page.evaluate(() => (window as any).__harness.ready());
});

/**
 * Correction 7: Timeline is the authoritative source for scene timing,
 * and there is no hidden animation/global state that can alter
 * rendering.
 */
test('render() has no memory between calls: interleaved calls never contaminate each other', async ({ page }) => {
  const { first, second } = await page.evaluate(({ pgn }) => {
    const h = (window as any).__harness;
    const stateA = h.buildFixtureState(pgn);
    const stateB = h.buildFixtureState(pgn);

    h.renderDirect('canvas-a', stateA, 300);
    const first = h.hashCanvas('canvas-a');

    // Render a bunch of different (state, time) pairs on a DIFFERENT
    // canvas in between, exercising whatever module-level state might
    // exist, before returning to the exact same call as above.
    h.renderDirect('canvas-b', stateB, 1200);
    h.renderDirect('canvas-b', stateB, 0);
    h.renderDirect('canvas-b', h.withTimeMs(stateB, 5000), 5000);

    h.renderDirect('canvas-a', stateA, 300);
    const second = h.hashCanvas('canvas-a');

    return { first, second };
  }, { pgn: PGN });

  expect(second).toBe(first);
});

test('shifting a beat\'s atMs changes the rendered frame at a fixed logicalTimeMs (position is derived from Timeline data)', async ({ page }) => {
  const { unshiftedHash, shiftedHash } = await page.evaluate(({ pgn }) => {
    const h = (window as any).__harness;
    const state = h.buildFixtureState(pgn);
    const scene = state.game.timeline.scenes[0];
    const firstBeat = scene.beats[0];

    // Unshifted: render at the midpoint of the first beat's original window.
    const t = firstBeat.atMs + firstBeat.durationMs / 2;
    h.renderDirect('canvas-a', state, t);
    const unshiftedHash = h.hashCanvas('canvas-a');

    // Shift only beats[0].atMs later by 200ms — nothing else in AppState changes.
    const shiftedBeat = { ...firstBeat, atMs: firstBeat.atMs + 200 };
    const shiftedScene = { ...scene, beats: [shiftedBeat, ...scene.beats.slice(1)] };
    const shiftedTimeline = { scenes: [shiftedScene] };
    const shiftedState = {
      ...state,
      game: { ...state.game, timeline: shiftedTimeline }
    };

    h.renderDirect('canvas-a', shiftedState, t);
    const shiftedHash = h.hashCanvas('canvas-a');

    return { unshiftedHash, shiftedHash };
  }, { pgn: PGN });

  // At the same logicalTimeMs, the piece is at a different point along its
  // path once the beat's atMs moved — proving the renderer takes timing
  // from Timeline data, not from any separately-tracked "when did this
  // animation start" state.
  expect(shiftedHash).not.toBe(unshiftedHash);
});

test('a Timeline that violates the lane invariants is rejected before it can reach the store or renderer', async ({ page }) => {
  const rejected = await page.evaluate(() => {
    const h = (window as any).__harness;
    const badTimeline = {
      scenes: [
        {
          id: 'bad-scene',
          startPositionFen: 'startpos',
          startPly: 0,
          cameraPlan: { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] },
          durationMs: 600,
          beats: [
            {
              kind: 'move',
              san: 'e4',
              pieceId: 'w-p-not-a-real-piece',
              from: 'e2',
              to: 'e4',
              atMs: 0,
              durationMs: 600,
              isEnPassant: false,
              resultingPly: 1
            }
          ]
        }
      ]
    };
    const violations = h.validateTimeline(badTimeline);
    return violations.length > 0 && violations[0].code === 'unknown-piece-id';
  });

  expect(rejected).toBe(true);
});
