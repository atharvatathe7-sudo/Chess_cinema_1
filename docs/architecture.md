# Chess Cinema — Phase 1 Architecture

Status: **approved with corrections**, implementation target. The legacy
`Chess_a-phase1c.html` at the repo root is reference material only — it is
never patched incrementally. All new work lives under `src/`.

This document is the corrected, canonical version of the Phase 1 plan. It
supersedes the earlier chat-only proposal. The corrections below were
mandatory changes requested during review; they are folded directly into
the design rather than listed as an addendum, except where explicitly
called out as "Correction N" for traceability.

## 1. Goals and non-goals for Phase 1

Goal: a reliable foundation — single state model, single renderer shared
by preview and export, deterministic frame-accurate export — proven by
tests, not by demo polish.

Explicitly **not** built in Phase 1: Stockfish/analysis engine, tactical
motif detection, AI story generation, cinematic director, advanced VFX,
audio, WebM/MP4 encoding, or an advanced timeline editor. The
architecture must accommodate all of these later without a rewrite (see
§10), but none of them are implemented now.

Phase 1 UI is deliberately minimal: load a PGN, play/pause/scrub through
the game, trigger a PNG-sequence export. No board editing, no
drag-to-move, no arrow/highlight drawing UI. Phase 1 validates the
architecture, not editor UX (**Correction 5**).

## 2. Folder structure

```
chess-cinema/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── vitest.config.ts
├── index.html
├── src/
│   ├── main.ts
│   │
│   ├── chess/                       # chess domain layer (rules only)
│   │   ├── ChessEngine.ts
│   │   ├── ChessJsEngine.ts
│   │   ├── engineErrors.ts
│   │   └── *.test.ts
│   │
│   ├── pgn/                         # PGN parsing + piece-identity tracking
│   │   ├── types.ts                 # GameRecord, MoveRecord, PieceId
│   │   ├── parsePgn.ts
│   │   ├── assignPieceIdentities.ts
│   │   └── *.test.ts
│   │
│   ├── timeline/                    # Scene/Beat IR — authoritative timing
│   │   ├── types.ts                 # Timeline, Scene, Beat, CameraPlan
│   │   ├── buildTrivialTimeline.ts
│   │   ├── invariants.ts            # lane/overlap validation, reused by tests + store
│   │   └── *.test.ts
│   │
│   ├── state/                       # application state (thin, no derived data stored)
│   │   ├── AppState.ts
│   │   ├── store.ts
│   │   └── *.test.ts
│   │
│   ├── render/                      # the single shared renderer
│   │   ├── Renderer.ts              # render(state, logicalTimeMs, ctx, dims)
│   │   ├── resolveCamera.ts         # pure derivation from CameraPlan
│   │   ├── resolveAnimations.ts     # pure derivation from Scene.beats (per pieceId)
│   │   ├── resolvePosition.ts       # pure derivation of "board at time T"
│   │   ├── drawBoard.ts
│   │   ├── drawPieces.ts
│   │   ├── drawAnnotations.ts
│   │   └── *.test.ts
│   │
│   ├── assets/                      # asset loading, explicit states
│   │   ├── AssetManager.ts
│   │   ├── pieces/                  # placeholder vector piece set (Phase 1)
│   │   └── *.test.ts
│   │
│   ├── preview/                     # on-screen driver (virtual clock)
│   │   └── PreviewLoop.ts
│   │
│   ├── export/                      # deterministic, streaming driver
│   │   ├── FrameSource.ts           # frameIndex -> logicalTimeMs (pure)
│   │   ├── runExport.ts             # backpressured render->encode loop
│   │   ├── PngSequenceEncoder.ts    # streaming zip (STORE), no compression dep
│   │   ├── capabilities.ts
│   │   └── *.test.ts
│   │
│   ├── ui/
│   │   └── panel.ts                 # minimal: load PGN, play/pause/scrub, export
│   │
│   └── errors/
│       ├── Result.ts
│       └── AppError.ts
│
├── tests/
│   ├── acceptance/
│   │   ├── rendererParity.test.ts   # Correction 6 — the central invariant test
│   │   └── timelineAuthority.test.ts# Correction 7
│   └── e2e/
│       └── smoke.spec.ts            # Playwright, Chrome only
│
└── docs/
    └── architecture.md              # this file
```

## 3. Corrections applied (source of truth for the review comments)

### Correction 1 — Camera is not authoritative state

`AppState` has **no `camera` field**. A camera is only ever produced by
`resolveCamera(scene.cameraPlan, logicalTimeMs): Camera`, a pure
function called from inside `render/Renderer.ts` (and by the UI status
readout if needed). There is nothing to desync because there is nothing
stored — camera is recomputed every time it's needed from
`Timeline.Scene.cameraPlan` and the time being rendered.

### Correction 2 — Timeline is authoritative; no redundant animation state

`AppState` has **no persisted `animations` slice**. A move's timing and
end-to-end trajectory live only in `Timeline.Scene.beats` (as `MoveBeat`
entries with `atMs`, `durationMs`, `pieceId`, `from`, `to`). Whether a
piece is mid-flight at a given instant, and where it is, is computed by
`resolveAnimations(scene.beats, logicalTimeMs)` — a pure function with
no memory between calls. There is exactly one place that can decide
"where is this piece right now": the Timeline, evaluated at a time.

The only state that may exist outside the Timeline is **transient
interaction state** the UI needs while the user is actively doing
something that hasn't yet been committed as a Beat (Phase 1 has no such
UI, but the type is reserved: `UiState.transient`, explicitly documented
as "cleared on commit or cancel, never read by `render/`, never a source
of playback/export truth"). Phase 1 does not populate this field with
anything animation-shaped; it exists as a documented boundary for the
future editable-timeline stage, not as a Phase 1 mechanism.

### Correction 3 — Animation lanes keyed by stable piece identity

Board squares are reused by different pieces over a game (a square
vacated by one piece may later be occupied by a different piece). Keying
animation/lane state by square is therefore ambiguous over time. Instead:

- Every piece present at the start position is assigned a **stable
  `PieceId`** (e.g. `w-P-b2`, `b-N-g8` — colour, starting type, starting
  square; stable for the life of the game record even through promotion).
- `assignPieceIdentities()` (in `pgn/`) replays the parsed move list once
  against `ChessEngine` and, for every ply, resolves: which `PieceId`
  moved, which `PieceId` (if any) was captured, and — for castling — the
  paired rook's `PieceId`/from/to. This produces `MoveRecord`s carrying
  `pieceId`, `capturedPieceId?`, and `rookMove?` (itself carrying a
  `pieceId`).
- `Beat` (move kind) carries the mover's `pieceId` (and, for castling,
  a second beat or an embedded `rookMove` — see `timeline/types.ts`).
- `resolveAnimations` and `drawPieces` key their per-piece work by
  `PieceId`, not by square.

**Lane invariants (enforced and tested, see `timeline/invariants.ts`):**

1. Every `PieceId` referenced by a `MoveBeat` in a `Scene` must have been
   introduced by the start position or a prior promotion — no orphan ids.
2. For a single `PieceId`, the time windows `[atMs, atMs + durationMs)`
   of its `MoveBeat`s within a `Scene` must never overlap. (This is what
   "at most one active lane per piece" means — it is a property of the
   Timeline data, not of any runtime counter.)
3. A `PieceId` that has been captured may not appear in a later
   `MoveBeat` within the same game (captured pieces are inert for the
   rest of the timeline).
4. A castling `MoveBeat` for a king must carry a `rookMove` whose
   `pieceId` is the correct starting-rook id for that side/colour.

These invariants are pure functions over `Timeline` data, callable both
from unit tests and (cheaply) from the store on timeline mutation, so a
malformed or hand-edited timeline is caught immediately rather than
silently mis-rendered.

### Correction 4 — Streaming, bounded-memory PNG export

`export/runExport.ts` drives frame production and encoding **with
backpressure**: it renders exactly one frame into a single reused
`OffscreenCanvas`, hands it to `PngSequenceEncoder.addFrame()`, `await`s
completion (PNG encode + write into the streaming archive), and only then
renders the next frame. No array of frames/blobs is ever accumulated —
peak memory is bounded by one frame's raw pixel buffer plus the
in-progress archive's already-encoded bytes (the necessary size of the
output itself, not a multiple of it).

`PngSequenceEncoder` is a hand-rolled streaming ZIP writer using the
STORE method (no compression, so no compression library is needed — PNG
bytes are already compressed). Each `addFrame` call: encodes the canvas
to a PNG `Blob`/`ArrayBuffer`, writes a local file header + raw bytes
into a growing output stream, updates a running CRC32 and central
directory, and immediately discards the frame's pixel/canvas buffer
before returning. `finish()` writes the central directory and closes the
stream.

Where available, `capabilities.ts` detects the File System Access API
(`showDirectoryPicker`) and `PngSequenceEncoder` writes each entry
directly to a `FileSystemWritableFileStream` instead of an in-memory
buffer — true O(1) memory regardless of export length. This is
feature-detected and surfaced, not silently assumed; when unavailable
(current default on Chrome Android), the in-memory streaming-zip path is
used and is disclosed as such, matching the no-silent-fallback rule.

### Correction 5 — Minimal Phase 1 UI

`ui/panel.ts` provides exactly: a PGN text input + load button, transport
controls (play/pause, scrub), and an export button with a progress
indicator driven by `runExport`'s frame-by-frame callback. No piece
dragging, no arrow/highlight authoring, no timeline editing. This is
sufficient to exercise the full pipeline end to end without building any
editor functionality ahead of need.

### Correction 6 — Acceptance test for the shared-renderer invariant

`tests/acceptance/rendererParity.test.ts` asserts the literal claim:
*given identical `AppState`, assets, `logicalTimeMs`, and render
dimensions, preview and export invoke the same `Renderer.render` and
produce pixel-identical output.* Concretely: it spies on the exported
`render` function (both `PreviewLoop`'s single-tick path and
`runExport`'s single-frame path import and call the same module export —
the spy proves it's literally the same function reference, not just
equivalent code), invokes both paths with the same fixture `AppState`
and `logicalTimeMs` against equally-sized canvases, and compares the
resulting `ImageData` byte-for-byte.

### Correction 7 — Tests proving Timeline authority / no hidden state

`tests/acceptance/timelineAuthority.test.ts` asserts:

- Calling `render(stateA, t)`, then `render(stateB, t2)`, then
  `render(stateA, t)` again yields byte-identical output for the two
  calls with `stateA`/`t` — proving no module-level mutable state
  leaks between calls.
- Changing only `Timeline.Scene.beats[i].atMs` shifts the rendered
  piece position at a fixed `logicalTimeMs` exactly as predicted by
  `resolveAnimations`, with nothing else in `AppState` touched —
  proving position is derived from Timeline data, not from any
  separately-tracked "animation start time."
- Constructing a `Timeline` that violates a lane invariant (§Correction 3)
  is rejected by `timeline/invariants.ts` before it can reach the
  renderer.

## 4. Application state (corrected)

```ts
interface AppState {
  gameRecord: GameRecord;   // immutable parsed PGN: headers + per-ply positions
  timeline: Timeline;       // authoritative Scene/Beat structure (Phase 1: one Scene)
  playback: PlaybackState;  // the only "live, authoritative, mutable" runtime slice
  ui: UiState;              // transient interaction state only — see Correction 2
  assets: AssetState;       // explicit loading/ready/error per asset
}

interface PlaybackState {
  activeSceneId: string;
  logicalTimeMs: number;    // virtual clock (preview) or frame-derived time (export)
  playing: boolean;
  rate: number;
}

interface UiState {
  pendingError: AppError | null;
  // Reserved, unused in Phase 1: `transient?: TransientEdit` — the documented
  // slot for future in-progress-edit state (e.g. a live drag before it is
  // committed as a Beat). Never read by render/, never a timing source.
}

interface AssetState {
  pieces: 'loading' | 'ready' | 'error';
  error?: AppError;
}
```

No `camera`, no `animations`, no mutable `game` position slice — all
three are pure derivations (`resolveCamera`, `resolveAnimations`,
`resolvePosition`) computed from `gameRecord`/`timeline`/`playback` on
demand.

## 5. Chess domain layer

Unchanged from the approved proposal: `ChessEngine` interface,
`ChessJsEngine` as its only implementation (chess.js pinned as an npm
dependency, upgraded to a current release with the modern camelCase API
rather than carrying forward the legacy 0.12.0 API the old file used — a
deliberate, low-risk decision since Phase 1 is a from-scratch consumer of
this interface). No fallback engine: a load failure is a fatal
`AppError`, surfaced and blocking, never silently substituted.

`ChessEngine` is also the only thing `assignPieceIdentities()` uses to
replay a game record — nothing outside `chess/` touches chess.js.

## 6. PGN/FEN parsing + piece identity

`parsePgn(text): Result<GameRecord, PgnParseError>` parses via
`ChessEngine`, producing per-ply `PositionSnapshot`s (FEN + `MoveRecord`).
`assignPieceIdentities()` runs as part of this construction (see
Correction 3) so every `MoveRecord` in a `GameRecord` already carries
stable `pieceId`s before it ever reaches `timeline/`.

## 7. Scene/Timeline data model

```ts
interface Timeline { scenes: Scene[]; }

interface Scene {
  id: string;
  startPositionFen: string;
  beats: Beat[];
  cameraPlan: CameraPlan;
  durationMs: number;
}

type Beat =
  | { kind: 'move'; pieceId: string; from: string; to: string;
      atMs: number; durationMs: number;
      capturedPieceId?: string; promotion?: PieceType;
      rookMove?: { pieceId: string; from: string; to: string }; }
  | { kind: 'annotation'; annotation: Annotation; atMs: number; untilMs: number };

interface CameraPlan {
  keyframes: { atMs: number; centerSquare: string; zoom: number }[];
}
```

`buildTrivialTimeline(GameRecord): Timeline` (Phase 1's only generator)
produces a **single `Scene`** spanning the whole game — one `move` Beat
per ply, sequential non-overlapping `atMs` windows, one static
full-board `CameraPlan` keyframe. Multi-scene support exists in the type
system for later cinematic-cut generators; Phase 1 simply never needs
more than one.

## 8. Renderer, camera, animation — the shared pipeline

`render/Renderer.ts` exports one function:

```ts
function render(
  state: AppState,
  logicalTimeMs: number,
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  dims: { width: number; height: number }
): void
```

Pure with respect to its inputs — reads only its arguments and the
already-loaded `assets/pieces` images, never `Date.now()`,
`performance.now()`, or any module-level mutable variable. Internally it
calls `resolvePosition`, `resolveCamera`, and `resolveAnimations`, all
pure functions of `(gameRecord/timeline, logicalTimeMs)`, then
`drawBoard`/`drawPieces`/`drawAnnotations`. This is the only module in
the tree allowed to issue canvas drawing calls for the board.

`preview/PreviewLoop.ts` and `export/runExport.ts` are both thin drivers
around this one function — see §9/§10. Neither contains any drawing
logic, and neither may reimplement any part of it (Correction 6's
acceptance test guards this going forward).

## 9. Preview pipeline

`PreviewLoop` runs a `requestAnimationFrame` loop that advances
`playback.logicalTimeMs` by `realDeltaMs * playback.rate` while playing,
then calls `render(state, playback.logicalTimeMs, previewCtx, dims)`
against the on-screen, DPR-scaled canvas.

## 10. Deterministic export pipeline

`export/FrameSource.ts` is a pure function `frameIndexToTimeMs(i, fps) =>
(i / fps) * 1000` plus `frameCount(scene.durationMs, fps)` — logical time
is computed, never sampled from a clock.

`export/runExport.ts` drives the loop with backpressure (Correction 4):
for each frame index, render into one reused `OffscreenCanvas`, `await`
`encoder.addFrame(...)` before moving to the next index, and report
progress via a callback the minimal UI can bind a progress bar to.

`PngSequenceEncoder` is the only Phase 1 encoder (streaming ZIP of PNGs,
Correction 4). A second `Encoder` implementation (WebCodecs-based
WebM/MP4) is an explicit non-goal for Phase 1 (see §1) and can be added
later without changing `runExport` or `FrameSource`.

## 11. Asset management

`AssetManager` loads a small **placeholder** vector piece set —
real, filled SVG shapes (not text glyphs), so rendering is not dependent
on which fonts happen to be installed on the machine. Visual quality is
explicitly deferred; the goal for Phase 1 is a real, deterministic vector
asset pipeline, not final art. Loading state (`loading`/`ready`/`error`)
lives in `AppState.assets` and is fatal-on-error, not silently skipped.

## 12. Testing architecture

- Unit tests (Vitest) alongside every pure module: `chess/`, `pgn/`
  (including fixtures for castling, en passant, promotion, capture, to
  exercise piece-identity tracking), `timeline/` (including the lane
  invariants), `render/resolveCamera` / `resolveAnimations` /
  `resolvePosition`, `state/store`.
- `tests/acceptance/rendererParity.test.ts` — Correction 6.
- `tests/acceptance/timelineAuthority.test.ts` — Correction 7.
- `export/*.test.ts` — determinism (two runs, identical output) and a
  bounded-memory check (peak "frames in flight" never exceeds 1).
- `tests/e2e/smoke.spec.ts` — one Chrome-only Playwright test: load a
  PGN fixture, play, export, assert completion.

## 13. Chrome desktop/Android compatibility

Chrome-only target. DPR-aware canvas sizing throughout.
`setPointerCapture()` is not yet relevant (Phase 1 has no drag
interaction) but is noted here for when the editable-timeline phase adds
it. File System Access API is feature-detected for true streaming
export where available (desktop Chrome today; Chrome Android support is
inconsistent and is not assumed) with an explicit, disclosed in-memory
fallback (§Correction 4).

## 14. Error handling

`Result<T, E>` at every domain boundary (`ChessEngine`, `parsePgn`,
`Encoder`). `AppError` taxonomy tags each error fatal or recoverable.
Fatal (engine load failure, asset load failure, no export capability at
all): blocking UI state. Recoverable (illegal move during identity
replay — implies a corrupt/invalid PGN, so actually treated as a fatal
parse error — malformed PGN text): typed `Result` returned to the UI,
never swallowed.

## 15a. Implementation notes (deltas from this document discovered while building)

A handful of small, non-conflicting refinements were made while
implementing Phase 1. None change the corrected architecture's intent;
each is noted here so the document stays accurate.

- **`AppState` shape**: `gameRecord` and `timeline` are combined into a
  single `game: LoadedGame | null` field (`{ gameRecord, timeline }`)
  rather than two separate top-level fields, so the type system itself
  rules out a state where one exists without the other — a stronger
  form of the "always travel together" property Correction 2 asks for.
- **`Renderer.render` signature**: takes a fifth argument, `assets:
  AssetManager<HTMLImageElement>` — the loaded piece images are a
  resource handle, not app data, so they don't belong in `AppState`
  (consistent with keeping camera/animation out of state), but the
  renderer still needs them to draw. `render(state, logicalTimeMs, ctx,
  dims, assets)`.
- **`CameraKeyframe`**: stores `centerX`/`centerY` (board-space floats,
  0..8) directly rather than a `centerSquare` string. A full-board
  static camera has no single natural "center square" (the true
  geometric center sits between four squares), so the square-based
  form only ever made sense for future zoomed/cinematic shots. A
  `squareCenter()` helper in `render/coords.ts` remains available for
  any future generator that wants to compute `centerX/centerY` from a
  square.
- **`MoveBeat.san`**: carries Standard Algebraic Notation for UI/history
  display only. It is never read to derive position or timing (that
  stays exclusively `resolvePosition`/`resolveAnimations`, driven by
  `pieceId`/`from`/`to`/`atMs`/`durationMs`) — adding it doesn't
  reopen Correction 2, it's descriptive metadata alongside the
  authoritative fields, the same way `san` already exists on
  `MoveRecord` in the pgn layer.
- **PieceId encoding**: centralized in `pgn/pieceId.ts`
  (`pieceIdFor`/`parsePieceId`) rather than being duplicated informally
  between `assignPieceIdentities` (encode) and `timeline/invariants`
  (decode, to check castling rook correctness).
- **Zip entry timestamps**: `export/zip.ts` stamps a fixed DOS epoch
  date/time on every entry rather than the real wall-clock time. An
  earlier version used `new Date()`, which silently broke the "same
  AppState -> byte-identical export" guarantee (two runs a second apart
  produced different archive bytes even though every frame was
  pixel-identical) — caught by the export determinism acceptance test,
  not by inspection.
- **Testing split**: pure-logic modules (`chess/`, `pgn/`, `timeline/`,
  `render/resolveCamera`/`resolveAnimations`/`resolvePosition`/`fen`/
  `coords`, `state/`, `export/crc32`/`zip`/`FrameSource`) are unit
  tested under Vitest (Node environment — no DOM/canvas). Anything that
  needs real Canvas 2D rendering (`render/Renderer` itself, the
  acceptance tests, the export determinism/bounded-memory tests, the
  e2e smoke test) runs under Playwright against real Chromium instead
  of a Node canvas shim (no `node-canvas` native dependency needed) —
  this also means the rendering tests run in the project's actual
  target browser. A shared test harness lives at
  `tests/fixtures/harness.{html,ts}`, served by the Vite dev server,
  exposing the real `render`/`previewTick`/`renderExportFrame`/
  `validateTimeline` functions to Playwright's page context.
- **`@playwright/test` pinned to 1.56.1**: this environment has
  Chromium pre-installed at a fixed revision; 1.56.1 is the version
  whose bundled browser matches that revision, avoiding a browser
  download.

## 15. Future extensibility (unchanged from the approved proposal)

Stockfish plugs in as a separate `AnalysisEngine` interface alongside
`ChessEngine`. Motif detection and story structure are pure functions
consuming `GameRecord`/`AnalysisResult`. Cinematic direction is a
smarter `Timeline` generator replacing `buildTrivialTimeline`, same
contract. Visual metaphors are new `Annotation`/`Beat` variants the
already data-driven `drawAnnotations` can consume. An editable timeline
UI is a component that reads/writes `AppState.timeline` through the
store — indistinguishable, from the renderer's point of view, from a
generator's output. None of this requires touching `render/Renderer.ts`,
`preview/PreviewLoop.ts`, or `export/runExport.ts`.

## 16. Phase 1.1 — Interactive Timeline & Playback Controls

Adds a touch-friendly scrub bar, Restart/Previous/Next Move controls,
and a move/time indicator to the Phase 1 UI. Purely additive: no new
state, no second renderer, no second clock.

- **`timeline/navigation.ts`**: pure functions over `Scene.beats` —
  `clampToScene`, `nextBeatBoundaryMs`, `previousBeatBoundaryMs`,
  `currentMoveNumber`, `totalMoveCount`. Timeline data stays the only
  source of truth for "where is the previous/next move boundary" and
  "what move are we on"; nothing here reads or writes playback state.
- **`state/actions.ts`** gains `restart`, `goToNextMove`,
  `goToPreviousMove`, all of which just compute a target `logicalTimeMs`
  via `timeline/navigation.ts` and call the existing `seekTo`/
  `setPlaying` — no new fields on `AppState`. `seekTo` itself now clamps
  to `[0, sceneDurationMs]` via `clampToScene`, the one place that needs
  to happen since it's the only function allowed to write
  `playback.logicalTimeMs`.
- **`ui/TimelineControl.ts`**: a hand-built Pointer-Events scrub bar
  (`setPointerCapture`/`releasePointerCapture`, tap-anywhere-to-seek,
  drag-to-scrub). It holds no playback state of its own — every pointer
  event just calls the `onSeek` callback the caller supplies, which
  dispatches the existing `seekTo`/`setPlaying` actions. Visual
  refresh (`setValue`) is driven by the same `store.subscribe` callback
  `ui/panel.ts` already had for the rest of the UI, so there is exactly
  one place the DOM is kept in sync with `AppState`.
- **`ui/panel.ts`**: mounts the new control and buttons, and calls
  `previewTick` synchronously right after dispatching any navigation
  action, in addition to the already-running `PreviewLoop`'s own
  per-frame call — both call sites invoke the same `render/Renderer.render`
  (same pattern already established between preview and export; see
  Correction 6's acceptance test), so this is not a second render path,
  just a second *trigger* for the one render function, added so
  scrubbing feels instant rather than waiting up to one animation frame.
  The board's on-screen CSS size is now computed once at mount from the
  viewport (`min(94vw, 480px)`, explicitly square) instead of relying on
  a canvas's incidental replaced-element aspect ratio.
- Tests: `timeline/navigation.test.ts` (pure boundary logic),
  `render/scrubbing.test.ts` (bidirectional scrub correctness against
  real driven games — capture, castling, capturing promotion — plus a
  general "drawn piece count always equals the base layer's own occupant
  count" invariant that rules out ghost pieces under adversarial,
  non-monotonic scrub order), `state/actions.test.ts` additions
  (restart/next/previous/play→pause→scrub→play), and
  `tests/e2e/scrubbing.spec.ts` (Playwright against the real UI,
  including an emulated-touch-device suite exercising `page.touchscreen`
  and touch-typed pointer events).
