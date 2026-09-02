# Chess Cinema — Intelligence Evaluation System

A **read-only** harness for measuring whether the cinematic director picks the
right *story* for a game. It runs PGNs through the application's own pipeline,
records every decision the director made, and gives you a structured place to
say whether that decision was correct.

It changes nothing about how Chess Cinema generates videos. It imports the
app's shipped functions and reads the resulting state — no module in `src/` is
patched, stubbed, or re-implemented here.

## Why it exists

Real-world testing surfaced one recurring product problem: the director
sometimes tells the wrong story. Specifically it appears to

- conflate a large Stockfish evaluation swing with genuine narrative importance,
- miss causal chains (an early blunder that only pays off much later),
- under-emphasise the actual payoff move in favour of an earlier setup move.

Those were scattered observations. This tool turns them into a dataset you can
count, so the next director phase is aimed by evidence instead of by hunch.

## Layout

```
tools/evaluation/
  corpus/canonical/   the 5 fixture games, committed
  corpus/real/        drop your own .pgn files here
  runCorpus.mjs       runs the pipeline, writes one capture JSON per game
  buildLabels.mjs     merges captures into the labelling dataset
  report.mjs          failure-pattern report
  schema/             JSON Schema for a label record
  labels/labels.json  THE DATASET — human verdicts live here (committed)
  labels/pending-games.json  known games whose PGN/verdict hasn't been supplied
  out/                generated captures (gitignored, regenerable)
  report/             generated report (gitignored, regenerable)
```

## Workflow

```bash
# 1. Run the corpus. Spawns its own dev server; ~4-11s per game (real Stockfish).
node tools/evaluation/runCorpus.mjs

# ...or just your own games, or one game:
node tools/evaluation/runCorpus.mjs --corpus tools/evaluation/corpus/real
node tools/evaluation/runCorpus.mjs --filter evergreen

# 2. Fold the captures into the dataset (never overwrites human fields).
node tools/evaluation/buildLabels.mjs

# 3. Label: open tools/evaluation/labels/labels.json and fill in the HUMAN
#    fields for each record (see below).

# 4. Report.
node tools/evaluation/report.mjs
```

## Pulling your own games from Chess.com

`fetchChessCom.mjs` pulls a player's recent games from the public Chess.com API
(no key or login needed) and writes them into `corpus/real/`, deliberately
balanced across wins, losses and draws so the director is graded on a
representative spread rather than only on games that went well.

```bash
# online — needs outbound access to api.chess.com
node tools/evaluation/fetchChessCom.mjs --user <username> --count 30

# see what it would pick without writing anything
node tools/evaluation/fetchChessCom.mjs --user <username> --count 30 --dry-run

# offline — if this machine cannot reach api.chess.com:
#   1. elsewhere, save each monthly archive JSON from
#      https://api.chess.com/pub/player/<user>/games/YYYY/MM
#   2. put the .json files in a folder, then:
node tools/evaluation/fetchChessCom.mjs --user <username> --from-dir ./archives
```

Useful flags: `--time-class blitz|rapid|bullet|daily`, `--min-moves 8`
(skips very short/aborted games), `--contact "you@example.com"` (Chess.com asks
for an identifying User-Agent).

Files are named `real-<date>-<outcome>-<termination>.pgn`, and Chess.com's own
headers are preserved with a few factual ones appended (`CCOutcomeForUser`,
`CCUserColour`, `CCTermination`, `CCTimeClass`, `CCSourceUrl`). `CCGameType` is
only set where the API decides it outright (stalemate, resignation) — calling a
game "tactical" or "positional" is a human judgement, so the tool leaves
`game_type` for you.

## Adding one of your own games

1. Save the PGN as `tools/evaluation/corpus/real/<game-id>.pgn`. Optional
   headers `[Termination "..."]` and `[CCGameType "..."]` are picked up as
   metadata; `CCGameType` seeds `game_type` for the report's breakdown.
2. `node tools/evaluation/runCorpus.mjs --corpus tools/evaluation/corpus/real`
3. `node tools/evaluation/buildLabels.mjs`
4. Fill in the human fields, then `node tools/evaluation/report.mjs`.

If the game is one already listed in `labels/pending-games.json`, name the file
with that exact `game_id` and the placeholder record is upgraded in place.

## Labelling a record

Each record in `labels/labels.json` mixes two kinds of field.

**Machine fields** (`tool_*`, `result`, `pgn_file`, `capture_file`, …) are
rewritten from the latest capture every time you run `buildLabels.mjs`. Don't
hand-edit them.

**Human fields** are yours, and tooling never writes them:

| field | meaning |
|---|---|
| `actual_important_event` | What actually mattered in this game, in your words. The ground truth. |
| `missed_events` | Things that mattered but the director never surfaced. |
| `caption_correct` | Did the caption text describe what really happened? |
| `camera_correct` | Did the camera frame the right board area at the right time? |
| `sequence_correct` | Was a multi-move sequence kept intact rather than collapsed to one move? |
| `causally_correct` | Was the cause linked to its later effect? |
| `verdict` | `correct` / `partially correct` / `wrong` |
| `failure_category` | Why it went wrong (see below). Leave null when `verdict` is `correct`. |
| `game_type`, `rating_band` | Drive the report's per-type breakdown. |

`failure_category` is a closed vocabulary so counts stay comparable:

- `evaluation-swing-mistaken-for-narrative` — a big engine swing was treated as the story when it wasn't.
- `setup-move-chosen-over-payoff` — the enabling move was framed instead of the move that actually delivered.
- `causal-chain-missed` — an earlier cause was never linked to its later effect.
- `multi-move-sequence-collapsed-to-one-move` — a forcing sequence was reduced to a single beat.
- `fabricated-significance` — something was labelled decisive that wasn't.
- `other` — plus a note in `failure_category_other`.

A record only counts as labelled once `verdict` is set. Until then the report
lists it as outstanding — an unlabelled game is never counted as a pass.

## Reading the report

Section 3 (**human verdicts**) is ground truth and drives the priority call for
the next director phase. Section 4 (**machine signals**) is measurement only:
it reports what the pipeline did — for example how often the story's decisive
ply is *exactly* the top raw Stockfish swing — without claiming that was right
or wrong. Treat those as hypotheses to go label, not as findings.

## What this tool will not do

It will not invent a verdict. If a game was tested by hand but its PGN and
verdict were never entered here, it stays `awaiting-pgn` and the report says so
out loud. A ground-truth dataset with guessed labels in it is worse than a
small honest one, because every later measurement inherits the guess.
