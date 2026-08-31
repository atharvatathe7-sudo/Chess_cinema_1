#!/usr/bin/env node
/**
 * Chess Cinema — Intelligence Evaluation System: label file builder.
 *
 * Merges corpus captures (tools/evaluation/out/*.json) into the labelling
 * dataset (tools/evaluation/labels/labels.json).
 *
 * The one rule this file exists to enforce: MACHINE fields are refreshed from
 * the latest capture on every run; HUMAN fields are never written by tooling.
 * Re-running the corpus after a director change must not silently destroy or
 * "update" a verdict a person recorded — that is how an evaluation dataset
 * quietly stops being ground truth.
 *
 * It also carries forward `labels/pending-games.json`: games known to have
 * been tested by hand but whose PGN has not been added to the corpus yet.
 * Those appear as status "awaiting-pgn" so the report can honestly count
 * what is still missing rather than pretending the dataset is complete.
 *
 * Usage: node tools/evaluation/buildLabels.mjs
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = join(PROJECT_ROOT, 'tools/evaluation/out');
const LABELS_DIR = join(PROJECT_ROOT, 'tools/evaluation/labels');
const LABELS_FILE = join(LABELS_DIR, 'labels.json');
const PENDING_FILE = join(LABELS_DIR, 'pending-games.json');

/** Written by this tool on every run — always safe to overwrite. */
const MACHINE_FIELDS = [
  'pgn_file',
  'result',
  'termination_type',
  'tool_selected_moments',
  'tool_caption_text',
  'tool_story_primary_ply',
  'tool_top_raw_swing_ply',
  'tool_terminal_ply',
  'tool_camera_focus_plies',
  'capture_file',
  'captured_at'
];

/** Only ever written by a person editing labels.json. Tooling must not touch these. */
const HUMAN_FIELDS = [
  'game_type',
  'rating_band',
  'actual_important_event',
  'missed_events',
  'caption_correct',
  'camera_correct',
  'sequence_correct',
  'causally_correct',
  'verdict',
  'failure_category',
  'failure_category_other',
  'notes',
  'labelled_by',
  'labelled_at'
];

function emptyHumanFields() {
  const blank = {};
  for (const field of HUMAN_FIELDS) blank[field] = field === 'missed_events' ? null : null;
  return blank;
}

/** A record counts as labelled once a person has recorded an overall verdict. */
function isLabelled(record) {
  return record.verdict === 'correct' || record.verdict === 'partially correct' || record.verdict === 'wrong';
}

function terminationFromCapture(capture) {
  const declared = capture.source?.declaredTermination;
  if (declared) return declared;
  const evaluation = capture.game?.lastPlyEvaluationAfter;
  if (evaluation && evaluation.kind === 'terminal') return 'terminal';
  return 'unterminated';
}

function machineFieldsFrom(capture) {
  return {
    pgn_file: capture.source?.file ?? null,
    result: capture.source?.declaredResult ?? null,
    termination_type: terminationFromCapture(capture),
    tool_selected_moments: (capture.moments ?? []).map((m) => ({
      kind: m.kind,
      label: m.label,
      toPly: m.toPly,
      toSan: m.toSan
    })),
    tool_caption_text: (capture.moments ?? []).map((m) => m.captionText),
    tool_story_primary_ply: capture.divergence?.storyPrimaryPly ?? null,
    tool_top_raw_swing_ply: capture.divergence?.topRawSwing?.ply ?? null,
    tool_terminal_ply: capture.divergence?.terminalPly ?? null,
    tool_camera_focus_plies: capture.divergence?.cameraFocusPlies ?? null,
    capture_file: relative(PROJECT_ROOT, join(OUT_DIR, `${capture.gameId}.json`)),
    captured_at: capture.capturedAt ?? null
  };
}

async function main() {
  await mkdir(LABELS_DIR, { recursive: true });

  const existing = existsSync(LABELS_FILE) ? JSON.parse(await readFile(LABELS_FILE, 'utf8')) : { records: [] };
  const byId = new Map((existing.records ?? []).map((r) => [r.game_id, r]));

  // 1. Known-but-not-yet-supplied games keep a seat in the dataset.
  if (existsSync(PENDING_FILE)) {
    const pending = JSON.parse(await readFile(PENDING_FILE, 'utf8'));
    for (const entry of pending.games ?? []) {
      if (!byId.has(entry.game_id)) {
        byId.set(entry.game_id, {
          game_id: entry.game_id,
          status: 'awaiting-pgn',
          ...emptyHumanFields(),
          game_type: entry.game_type ?? null,
          rating_band: entry.rating_band ?? null,
          notes: entry.notes ?? null,
          pgn_file: null,
          result: null,
          termination_type: null,
          tool_selected_moments: null,
          tool_caption_text: null,
          tool_story_primary_ply: null,
          tool_top_raw_swing_ply: null,
          tool_terminal_ply: null,
          tool_camera_focus_plies: null,
          capture_file: null,
          captured_at: null
        });
      }
    }
  }

  // 2. Every capture refreshes only its machine fields.
  const captureFiles = existsSync(OUT_DIR)
    ? (await readdir(OUT_DIR)).filter((f) => f.endsWith('.json') && f !== '_index.json').sort()
    : [];

  let created = 0;
  let refreshed = 0;
  let preserved = 0;

  for (const file of captureFiles) {
    const capture = JSON.parse(await readFile(join(OUT_DIR, file), 'utf8'));
    if (!capture.ok) {
      console.warn(`! skipping ${capture.gameId}: capture failed at ${capture.stage}`);
      continue;
    }
    const machine = machineFieldsFrom(capture);
    const prior = byId.get(capture.gameId);

    if (!prior) {
      byId.set(capture.gameId, {
        game_id: capture.gameId,
        status: 'captured-unlabelled',
        ...emptyHumanFields(),
        game_type: capture.source?.declaredGameType ?? null,
        ...machine
      });
      created++;
    } else {
      // Human fields survive untouched; only machine fields move.
      for (const field of MACHINE_FIELDS) prior[field] = machine[field];
      prior.status = isLabelled(prior) ? 'labelled' : 'captured-unlabelled';
      if (prior.game_type === null && capture.source?.declaredGameType) {
        prior.game_type = capture.source.declaredGameType;
      }
      refreshed++;
      if (isLabelled(prior)) preserved++;
    }
  }

  const records = [...byId.values()].sort((a, b) => a.game_id.localeCompare(b.game_id));
  for (const record of records) {
    if (record.status !== 'awaiting-pgn') record.status = isLabelled(record) ? 'labelled' : 'captured-unlabelled';
  }

  const dataset = {
    schemaVersion: 1,
    schema: 'tools/evaluation/schema/label.schema.json',
    updatedAt: new Date().toISOString(),
    records
  };
  await writeFile(LABELS_FILE, JSON.stringify(dataset, null, 2) + '\n');

  const counts = records.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`Wrote ${relative(PROJECT_ROOT, LABELS_FILE)}`);
  console.log(`  records            : ${records.length}`);
  console.log(`  labelled           : ${counts['labelled'] ?? 0}`);
  console.log(`  captured-unlabelled: ${counts['captured-unlabelled'] ?? 0}`);
  console.log(`  awaiting-pgn       : ${counts['awaiting-pgn'] ?? 0}`);
  console.log(`  (created ${created}, refreshed ${refreshed}, human verdicts preserved ${preserved})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
