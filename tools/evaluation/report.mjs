#!/usr/bin/env node
/**
 * Chess Cinema — Intelligence Evaluation System: failure-pattern report.
 *
 * Reads the labelling dataset and reports where the cinematic director is
 * getting the story wrong, so the next director phase is aimed by evidence
 * rather than by hunch.
 *
 * Two clearly separated halves, because they have very different epistemic
 * weight and must never be read as one number:
 *
 *   HUMAN VERDICTS  — counts of failure_category over games a person has
 *                     actually watched and judged. This is the ground truth.
 *                     Coverage is stated up front; an unlabelled game is
 *                     counted as unlabelled, never as a pass.
 *
 *   MACHINE SIGNALS — structural facts measured across every capture
 *                     (e.g. how often the story's decisive ply is exactly
 *                     the top raw Stockfish swing). These are hypothesis
 *                     generators, not verdicts: they say what the pipeline
 *                     did, not whether it was right.
 *
 * Usage: node tools/evaluation/report.mjs
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = join(PROJECT_ROOT, 'tools/evaluation/out');
const LABELS_FILE = join(PROJECT_ROOT, 'tools/evaluation/labels/labels.json');
const REPORT_DIR = join(PROJECT_ROOT, 'tools/evaluation/report');
const REPORT_FILE = join(REPORT_DIR, 'failure-patterns.md');

const FAILURE_CATEGORIES = [
  'evaluation-swing-mistaken-for-narrative',
  'setup-move-chosen-over-payoff',
  'causal-chain-missed',
  'multi-move-sequence-collapsed-to-one-move',
  'fabricated-significance',
  'other'
];

const pct = (n, total) => (total === 0 ? '—' : `${((n / total) * 100).toFixed(0)}%`);

function tally(items, keyOf) {
  const counts = new Map();
  for (const item of items) {
    const key = keyOf(item) ?? 'unspecified';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function table(rows, headers) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => '| ' + cells.map((c, i) => String(c).padEnd(widths[i])).join(' | ') + ' |';
  return [line(headers), '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|', ...rows.map(line)].join('\n');
}

async function loadCaptures() {
  if (!existsSync(OUT_DIR)) return [];
  const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.json') && f !== '_index.json').sort();
  const captures = [];
  for (const file of files) {
    const capture = JSON.parse(await readFile(join(OUT_DIR, file), 'utf8'));
    if (capture.ok) captures.push(capture);
  }
  return captures;
}

async function main() {
  if (!existsSync(LABELS_FILE)) {
    console.error(`No labels file at ${relative(PROJECT_ROOT, LABELS_FILE)} — run buildLabels.mjs first.`);
    process.exit(1);
  }
  await mkdir(REPORT_DIR, { recursive: true });

  const dataset = JSON.parse(await readFile(LABELS_FILE, 'utf8'));
  const records = dataset.records ?? [];
  const captures = await loadCaptures();

  const labelled = records.filter((r) => r.status === 'labelled');
  const capturedUnlabelled = records.filter((r) => r.status === 'captured-unlabelled');
  const awaiting = records.filter((r) => r.status === 'awaiting-pgn');

  const lines = [];
  const push = (s = '') => lines.push(s);

  push('# Chess Cinema — director failure-pattern report');
  push();
  push(`Generated ${new Date().toISOString()} from \`${relative(PROJECT_ROOT, LABELS_FILE)}\`.`);
  push();

  // ---------------------------------------------------------------- coverage
  push('## 1. Dataset coverage');
  push();
  push(
    table(
      [
        ['labelled (human verdict recorded)', labelled.length, pct(labelled.length, records.length)],
        ['captured, awaiting human verdict', capturedUnlabelled.length, pct(capturedUnlabelled.length, records.length)],
        ['awaiting PGN (known, not supplied)', awaiting.length, pct(awaiting.length, records.length)],
        ['TOTAL records', records.length, '100%']
      ],
      ['state', 'games', 'share']
    )
  );
  push();
  if (labelled.length === 0) {
    push(
      '> **No human verdicts are recorded yet.** Every failure-category count below is therefore empty. ' +
        'This is a real gap, not a passing score: nothing in this dataset yet says the director is right or wrong. ' +
        'The machine signals in section 4 are measurements only.'
    );
    push();
  } else if (capturedUnlabelled.length + awaiting.length > labelled.length) {
    push(
      `> **Caution:** ${labelled.length} of ${records.length} records are labelled. ` +
        'Percentages below describe only the labelled subset and should not be read as the director\'s overall accuracy.'
    );
    push();
  }

  // ---------------------------------------------------------------- verdicts
  push('## 2. Verdicts');
  push();
  if (labelled.length === 0) {
    push('_No verdicts recorded._');
  } else {
    const verdicts = tally(labelled, (r) => r.verdict);
    push(
      table(
        ['correct', 'partially correct', 'wrong'].map((v) => [v, verdicts.get(v) ?? 0, pct(verdicts.get(v) ?? 0, labelled.length)]),
        ['verdict', 'games', 'share of labelled']
      )
    );
    push();
    const dimensions = [
      ['caption_correct', 'caption described what really happened'],
      ['camera_correct', 'camera framed the right board area'],
      ['sequence_correct', 'multi-move sequence kept intact'],
      ['causally_correct', 'cause linked to its later effect']
    ];
    push(
      table(
        dimensions.map(([field, label]) => {
          const answered = labelled.filter((r) => typeof r[field] === 'boolean');
          const passed = answered.filter((r) => r[field] === true).length;
          return [label, `${passed}/${answered.length}`, pct(passed, answered.length)];
        }),
        ['dimension', 'passed', 'pass rate']
      )
    );
  }
  push();

  // -------------------------------------------------------- failure patterns
  push('## 3. Failure categories');
  push();
  const failures = labelled.filter((r) => r.verdict !== 'correct' && r.failure_category);
  if (failures.length === 0) {
    push(
      labelled.length === 0
        ? '_No labelled games, so no failure categories._'
        : '_No failures recorded among labelled games._'
    );
  } else {
    const byCategory = tally(failures, (r) => r.failure_category);
    push(
      table(
        FAILURE_CATEGORIES.filter((c) => byCategory.has(c)).map((c) => [
          c,
          byCategory.get(c),
          pct(byCategory.get(c), failures.length)
        ]),
        ['failure_category', 'games', 'share of failures']
      )
    );
    push();
    const ranked = [...byCategory.entries()].sort((a, b) => b[1] - a[1]);
    const [topCategory, topCount] = ranked[0];
    const tied = ranked.filter(([, n]) => n === topCount).map(([c]) => c);
    push(
      tied.length === 1
        ? `**Most common failure mode: \`${topCategory}\` (${topCount} of ${failures.length} failures, ${pct(topCount, failures.length)}).** This is the priority target for the next director phase.`
        : `**Tied for most common failure mode (${topCount} each): ${tied.map((c) => `\`${c}\``).join(', ')}.** Needs more labelled games to separate them.`
    );
    push();

    push('### By game type');
    push();
    const types = [...new Set(failures.map((r) => r.game_type ?? 'unspecified'))].sort();
    const rows = [];
    for (const type of types) {
      const inType = failures.filter((r) => (r.game_type ?? 'unspecified') === type);
      const catCounts = tally(inType, (r) => r.failure_category);
      const dominant = [...catCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      rows.push([type, inType.length, `${dominant[0]} (${dominant[1]})`]);
    }
    push(table(rows, ['game_type', 'failures', 'most common category']));
  }
  push();

  // -------------------------------------------------------- machine signals
  push('## 4. Machine signals (measured, NOT human-verified)');
  push();
  push(
    'These are structural facts about what the pipeline did across every successful capture. ' +
      'They do not say whether a choice was right — only how often a given shape occurs. ' +
      'Use them to form hypotheses and to decide which games are worth labelling next.'
  );
  push();
  if (captures.length === 0) {
    push('_No captures found. Run `node tools/evaluation/runCorpus.mjs` first._');
  } else {
    const withStory = captures.filter((c) => c.divergence?.storyPrimaryPly !== null && c.divergence?.storyPrimaryPly !== undefined);
    const storyEqualsTopSwing = withStory.filter(
      (c) => c.divergence.topRawSwing && c.divergence.storyPrimaryPly === c.divergence.topRawSwing.ply
    );
    const terminalGames = captures.filter((c) => c.game?.finalPositionIsTerminal === true);
    const terminalNoCamera = terminalGames.filter((c) => c.divergence?.terminalMoveHasCameraFocus === false);
    const storyBeforeTerminal = terminalGames.filter(
      (c) =>
        typeof c.divergence?.storyPrimaryPly === 'number' &&
        typeof c.divergence?.terminalPly === 'number' &&
        c.divergence.storyPrimaryPly < c.divergence.terminalPly
    );

    /**
     * The upstream understanding layer routinely identifies a multi-ply
     * archetype (a king hunt, a pawn journey) while the camera ends up
     * framing a single ply. That gap is measurable without judging it, and
     * it is exactly the shape of the `multi-move-sequence-collapsed-to-one-move`
     * category, so it is worth counting.
     */
    const longArchetype = captures.filter((c) =>
      (c.story?.archetypeSignals ?? []).some((a) => (a.plies ?? []).length >= 3)
    );
    const longArchetypeCollapsed = longArchetype.filter((c) => (c.divergence?.cameraFocusPlies ?? []).length <= 1);

    push(
      table(
        [
          [
            'story decisive ply == top raw Stockfish swing ply',
            `${storyEqualsTopSwing.length}/${withStory.length}`,
            pct(storyEqualsTopSwing.length, withStory.length)
          ],
          [
            'terminal move never gets its own camera focus',
            `${terminalNoCamera.length}/${terminalGames.length}`,
            pct(terminalNoCamera.length, terminalGames.length)
          ],
          [
            'story decisive ply lands before the final move',
            `${storyBeforeTerminal.length}/${terminalGames.length}`,
            pct(storyBeforeTerminal.length, terminalGames.length)
          ],
          [
            'multi-ply archetype (>=3 plies) framed by <=1 camera move',
            `${longArchetypeCollapsed.length}/${longArchetype.length}`,
            pct(longArchetypeCollapsed.length, longArchetype.length)
          ]
        ],
        ['signal', 'games', 'rate']
      )
    );
    push();
    push('### Per game');
    push();
    push(
      table(
        captures.map((c) => [
          c.gameId,
          c.divergence?.storyPrimaryPly ?? '—',
          c.divergence?.topRawSwing?.ply ?? '—',
          c.divergence?.terminalPly ?? '—',
          c.divergence?.terminalMoveHasCameraFocus === null ? 'n/a' : String(c.divergence?.terminalMoveHasCameraFocus),
          (c.moments ?? []).length
        ]),
        ['game', 'story ply', 'top swing ply', 'terminal ply', 'terminal has camera', 'moments']
      )
    );
  }
  push();

  // ----------------------------------------------------------- what is next
  push('## 5. What this report cannot tell you yet');
  push();
  const gaps = [];
  if (awaiting.length > 0) {
    gaps.push(
      `${awaiting.length} game(s) named in the evaluation brief have no PGN in the corpus yet ` +
        `(${awaiting.map((r) => `\`${r.game_id}\``).join(', ')}). Their prior verdicts were never supplied to this tool and have not been guessed.`
    );
  }
  if (capturedUnlabelled.length > 0) {
    gaps.push(`${capturedUnlabelled.length} captured game(s) still need a human verdict before they count toward any failure rate.`);
  }
  if (labelled.length > 0 && labelled.length < 10) {
    gaps.push(`Only ${labelled.length} labelled game(s) — too few to treat category shares as stable.`);
  }
  if (gaps.length === 0) gaps.push('Nothing outstanding: every record is labelled.');
  for (const gap of gaps) push(`- ${gap}`);
  push();

  const markdown = lines.join('\n');
  await writeFile(REPORT_FILE, markdown + '\n');
  console.log(markdown);
  console.log(`\n(written to ${relative(PROJECT_ROOT, REPORT_FILE)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
