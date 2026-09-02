#!/usr/bin/env node
/**
 * Chess Cinema — Intelligence Evaluation System: single-game viewer.
 *
 * Prints one capture in a form a person can actually read, for the
 * identify-and-label pass: what the game was, what the director chose, and
 * the machine signals that suggest where it may have gone wrong.
 *
 * Everything printed is read from the capture. Nothing is inferred about
 * whether a choice was right — that judgement is yours, and goes in
 * labels.json.
 *
 * Usage:
 *   node tools/evaluation/showGame.mjs game_01
 *   node tools/evaluation/showGame.mjs --list
 */
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT_DIR = join(PROJECT_ROOT, 'tools/evaluation/out');

const pad = (s, n) => String(s).padEnd(n);

function movePairs(moves) {
  const out = [];
  for (let i = 0; i < moves.length; i += 2) {
    const no = Math.floor(i / 2) + 1;
    out.push(`${no}. ${moves[i].san}${moves[i + 1] ? ' ' + moves[i + 1].san : ''}`);
  }
  return out;
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === '--list') {
    const files = (await readdir(OUT_DIR)).filter((f) => f.endsWith('.json') && f !== '_index.json').sort();
    console.log(files.map((f) => f.replace(/\.json$/, '')).join('\n'));
    return;
  }

  const file = join(OUT_DIR, `${arg.replace(/\.json$/, '')}.json`);
  if (!existsSync(file)) {
    console.error(`No capture at ${file}. Run runCorpus.mjs first, or use --list.`);
    process.exit(1);
  }
  const c = JSON.parse(await readFile(file, 'utf8'));

  if (!c.ok) {
    console.log(`${c.gameId} — CAPTURE FAILED at ${c.stage}: ${c.error}`);
    return;
  }

  const h = c.source.headers ?? {};
  const plies = c.game.plyCount;
  const pairs = movePairs(c.game.moves);

  console.log('='.repeat(78));
  console.log(`${c.gameId}   ${plies} plies (${Math.ceil(plies / 2)} moves)   Result ${h.Result ?? '?'}`);
  if (h.Termination) console.log(`Termination: ${h.Termination}`);
  console.log('='.repeat(78));
  console.log();
  console.log('OPENING   ' + pairs.slice(0, 6).join('  '));
  console.log('ENDING    ' + pairs.slice(-4).join('  '));
  console.log(`FINAL     ply ${c.game.terminalPly} = ${c.game.terminalSan}` +
    `   (engine says final position ${c.game.finalPositionIsTerminal ? 'IS' : 'is NOT'} terminal)`);
  console.log();

  console.log('--- WHAT THE DIRECTOR CHOSE ---');
  const cc = c.story.centralConflict;
  if (cc) {
    console.log(`  decisive move   : ply ${cc.primaryPly} = ${cc.primarySan}  ` +
      `[${cc.primaryKind}, significance ${cc.primarySignificance}]`);
  } else {
    console.log(`  decisive move   : none  (${c.story.noConflictReason ?? 'no central conflict'})`);
  }
  const cam = c.director.cameraDirectives;
  console.log(`  camera framed   : ${cam.length === 0 ? 'nothing (static full board)' : cam.map((d) => `ply ${d.atPly} = ${d.san}`).join(', ')}`);
  console.log(`  hook            : ${c.hook ? JSON.stringify(c.hook.text ?? c.hook) : 'none'}`);
  console.log(`  moments shown   : ${c.moments.length}`);
  for (const m of c.moments) {
    console.log(`      ply ${pad(m.toPly, 4)} ${pad(m.toSan ?? '', 8)} [${m.kind}]`);
    console.log(`          "${m.captionText}"`);
    for (const n of m.narratives.slice(1)) console.log(`          also true: ${n.label} — ${n.reason}`);
  }
  console.log();

  console.log('--- SIGNALS (measured, not a verdict) ---');
  const d = c.divergence;
  const same = d.topRawSwing && d.storyPrimaryPly === d.topRawSwing.ply;
  console.log(`  biggest raw eval swing : ${d.topRawSwing ? `ply ${d.topRawSwing.ply} = ${d.topRawSwing.san} (${d.topRawSwing.swingCp}cp)` : 'none'}` +
    `${same ? '   <-- SAME ply the story picked' : d.topRawSwing ? '   (story picked a different ply)' : ''}`);
  console.log(`  terminal move framed?  : ${d.terminalMoveHasCameraFocus === null ? 'n/a' : d.terminalMoveHasCameraFocus ? 'yes' : 'NO'}`);
  const arch = c.story.archetypeSignals;
  console.log(`  archetypes detected    : ${arch.length === 0 ? 'none' : arch.map((a) => `${a.archetype} (plies ${a.plies[0]}-${a.plies[a.plies.length - 1]}, ${a.plies.length} plies)`).join('; ')}`);
  const seqs = c.understanding.sequences;
  console.log(`  forced sequences       : ${seqs.length}${seqs.length ? ' -> ' + seqs.map((s) => `${s.startPly}-${s.endPly}(${s.forcingReason})`).join(', ') : ''}`);
  console.log(`  turning points         : ${c.understanding.turningPoints.length}` +
    (c.understanding.turningPoints.length
      ? '  top: ' + [...c.understanding.turningPoints].sort((a, b) => b.significanceScore - a.significanceScore).slice(0, 3)
          .map((t) => `ply ${t.ply}=${t.san}(${t.significanceScore})`).join(', ')
      : ''));
  console.log(`  scene duration         : ${(c.timeline.sceneDurationMs / 1000).toFixed(1)}s, ${c.timeline.cameraKeyframes.length} camera keyframes`);
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
