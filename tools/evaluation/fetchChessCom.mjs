#!/usr/bin/env node
/**
 * Chess Cinema — Intelligence Evaluation System: Chess.com corpus fetcher.
 *
 * Pulls a player's recent games from the Chess.com public API and writes them
 * as .pgn files into the evaluation corpus, deliberately balanced across
 * wins / losses / draws so the director is graded on a representative spread
 * rather than only on the games that happened to go well.
 *
 * No API key or login is required — https://api.chess.com/pub/ is public and
 * read-only. It does require a descriptive User-Agent; requests without one
 * are rejected, so --contact is used to build one.
 *
 * Two ways to run it:
 *
 *   ONLINE (needs outbound access to api.chess.com)
 *     node tools/evaluation/fetchChessCom.mjs --user <username> --count 30
 *
 *   OFFLINE (no outbound access — fetch the JSON elsewhere, ingest it here)
 *     1. In any browser/machine that can reach it, save each monthly archive:
 *          https://api.chess.com/pub/player/<user>/games/2026/08
 *     2. Drop the .json files in a folder, then:
 *          node tools/evaluation/fetchChessCom.mjs --user <username> --from-dir ./archives
 *
 * The offline path exists because sandboxed environments frequently block
 * outbound hosts; the selection, classification and naming logic is identical
 * either way, so the corpus is the same however the JSON arrived.
 */
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_OUT = join(PROJECT_ROOT, 'tools/evaluation/corpus/real');

/** Chess.com result codes that mean the game was drawn, for whichever side carries them. */
const DRAW_RESULTS = new Set(['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient']);

/** Losing-side result code -> a short, factual termination word for the filename and PGN header. */
const TERMINATION_WORD = {
  checkmated: 'checkmate',
  resigned: 'resignation',
  timeout: 'timeout',
  abandoned: 'abandoned',
  stalemate: 'stalemate',
  agreed: 'agreed',
  repetition: 'repetition',
  insufficient: 'insufficient-material',
  '50move': 'fifty-move',
  timevsinsufficient: 'timeout-vs-insufficient',
  lose: 'lose',
  kingofthehill: 'king-of-the-hill',
  threecheck: 'three-check'
};

/**
 * Only two of the label schema's game_type values are decidable from the API
 * alone. Everything else ("tactical", "positional", "king-hunt") is a human
 * judgement, so this tool leaves game_type unset rather than guessing it.
 */
const FACTUAL_GAME_TYPE = { stalemate: 'stalemate', resignation: 'resignation' };

function parseArgs(argv) {
  const args = {
    user: null,
    count: 30,
    out: DEFAULT_OUT,
    fromDir: null,
    minMoves: 8,
    timeClass: null,
    contact: 'chess-cinema-eval',
    dryRun: false
  };
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--user') { args.user = value; i++; }
    else if (flag === '--count') { args.count = Number(value); i++; }
    else if (flag === '--out') { args.out = resolve(value); i++; }
    else if (flag === '--from-dir') { args.fromDir = resolve(value); i++; }
    else if (flag === '--min-moves') { args.minMoves = Number(value); i++; }
    else if (flag === '--time-class') { args.timeClass = value; i++; }
    else if (flag === '--contact') { args.contact = value; i++; }
    else if (flag === '--dry-run') { args.dryRun = true; }
    else if (flag === '--help' || flag === '-h') { console.log(HELP); process.exit(0); }
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.user) throw new Error('--user is required (your Chess.com username)');
  return args;
}

const HELP = `Chess Cinema — Chess.com corpus fetcher

  --user <name>        Chess.com username (required)
  --count <n>          How many games to keep (default 30)
  --out <dir>          Output folder (default tools/evaluation/corpus/real)
  --from-dir <dir>     OFFLINE: read saved monthly-archive .json files instead of fetching
  --min-moves <n>      Skip games shorter than this many full moves (default 8)
  --time-class <c>     Only keep one of: bullet | blitz | rapid | daily
  --contact <string>   Put something identifying in the User-Agent (Chess.com asks for this)
  --dry-run            Show the selection without writing any files`;

async function fetchJson(url, contact) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': `ChessCinemaEval/1.0 (${contact})`,
      Accept: 'application/json'
    }
  });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

/** Newest-first list of monthly archive payloads, stopping once `needed` games are in hand. */
async function collectOnline(user, contact, needed) {
  const { archives } = await fetchJson(`https://api.chess.com/pub/player/${encodeURIComponent(user)}/games/archives`, contact);
  if (!Array.isArray(archives) || archives.length === 0) {
    throw new Error(`No archives returned for "${user}" — check the username spelling.`);
  }
  console.log(`Found ${archives.length} monthly archive(s).`);

  const games = [];
  // Newest month first: we want recent games, and we stop as soon as we have
  // comfortably more than we need so we are not hammering the API.
  for (const url of [...archives].reverse()) {
    const month = url.split('/').slice(-2).join('-');
    process.stdout.write(`  fetching ${month} … `);
    const payload = await fetchJson(url, contact);
    const monthGames = payload.games ?? [];
    console.log(`${monthGames.length} game(s)`);
    games.push(...monthGames);
    // Over-collect (x3) so the win/loss/draw balancing has something to choose from.
    if (games.length >= needed * 3) break;
    await new Promise((r) => setTimeout(r, 300)); // be polite to a free public API
  }
  return games;
}

async function collectOffline(dir) {
  if (!existsSync(dir)) throw new Error(`--from-dir ${dir} does not exist`);
  const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`No .json files in ${dir}`);
  const games = [];
  for (const file of files) {
    const payload = JSON.parse(await readFile(join(dir, file), 'utf8'));
    const monthGames = Array.isArray(payload) ? payload : payload.games ?? [];
    console.log(`  ${file}: ${monthGames.length} game(s)`);
    games.push(...monthGames);
  }
  return games;
}

/** Everything here is read straight off the API payload — no inference about play quality. */
function classify(game, user) {
  const lower = user.toLowerCase();
  const isWhite = (game.white?.username ?? '').toLowerCase() === lower;
  const isBlack = (game.black?.username ?? '').toLowerCase() === lower;
  if (!isWhite && !isBlack) return null;

  const me = isWhite ? game.white : game.black;
  const them = isWhite ? game.black : game.white;

  let outcome;
  if (me.result === 'win') outcome = 'win';
  else if (DRAW_RESULTS.has(me.result)) outcome = 'draw';
  else outcome = 'loss';

  // How it ended is carried by whichever side did NOT win.
  const decidingCode = me.result === 'win' ? them.result : me.result;
  const termination = TERMINATION_WORD[decidingCode] ?? decidingCode ?? 'unknown';

  const endDate = new Date((game.end_time ?? 0) * 1000);
  const yyyymmdd = Number.isFinite(endDate.getTime())
    ? endDate.toISOString().slice(0, 10).replace(/-/g, '')
    : '00000000';

  return {
    outcome,
    termination,
    colour: isWhite ? 'white' : 'black',
    myRating: me.rating ?? null,
    theirRating: them.rating ?? null,
    opponent: them.username ?? 'unknown',
    endTime: game.end_time ?? 0,
    yyyymmdd,
    timeClass: game.time_class ?? 'unknown',
    rules: game.rules ?? 'chess',
    url: game.url ?? null,
    pgn: game.pgn ?? null
  };
}

/** Full-move count, read from the PGN movetext rather than guessed from length. */
function countMoves(pgn) {
  const movetext = pgn.replace(/^\s*\[[^\]]*\]\s*$/gm, '').trim();
  const numbers = [...movetext.matchAll(/(\d+)\.(?!\.)/g)].map((m) => Number(m[1]));
  return numbers.length > 0 ? Math.max(...numbers) : 0;
}

/**
 * Round-robins across win/loss/draw newest-first so the corpus is a spread.
 * Draws are rare in fast time controls, so whichever bucket runs dry simply
 * stops contributing and the rest keep filling — the result is as balanced as
 * the player's actual history allows, never padded.
 */
function selectSpread(candidates, count) {
  const buckets = { win: [], loss: [], draw: [] };
  for (const c of candidates) buckets[c.outcome].push(c);
  for (const key of Object.keys(buckets)) buckets[key].sort((a, b) => b.endTime - a.endTime);

  const picked = [];
  const order = ['win', 'loss', 'draw'];
  let round = 0;
  while (picked.length < count && order.some((k) => buckets[k].length > 0)) {
    for (const key of order) {
      if (picked.length >= count) break;
      const next = buckets[key].shift();
      if (next) picked.push(next);
    }
    if (++round > count + 5) break; // belt and braces against a pathological loop
  }
  return picked;
}

function buildPgn(entry, gameId) {
  // Chess.com's own headers are preserved verbatim; these are appended so the
  // evaluation tooling can read provenance without re-deriving it. Every value
  // is a fact from the API, never a judgement about the game.
  const extra = [
    `[CCGameId "${gameId}"]`,
    `[CCOutcomeForUser "${entry.outcome}"]`,
    `[CCUserColour "${entry.colour}"]`,
    `[CCTermination "${entry.termination}"]`,
    `[CCTimeClass "${entry.timeClass}"]`,
    entry.url ? `[CCSourceUrl "${entry.url}"]` : null,
    FACTUAL_GAME_TYPE[entry.termination] ? `[CCGameType "${FACTUAL_GAME_TYPE[entry.termination]}"]` : null
  ].filter(Boolean);

  const pgn = entry.pgn.trimEnd();
  const lastHeader = pgn.lastIndexOf(']');
  if (lastHeader === -1) return `${extra.join('\n')}\n\n${pgn}\n`;
  return `${pgn.slice(0, lastHeader + 1)}\n${extra.join('\n')}${pgn.slice(lastHeader + 1)}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Chess.com corpus fetch for "${args.user}" (target ${args.count} games)\n`);

  const raw = args.fromDir ? await collectOffline(args.fromDir) : await collectOnline(args.user, args.contact, args.count);
  console.log(`\nCollected ${raw.length} raw game(s).`);

  const classified = raw.map((g) => classify(g, args.user)).filter(Boolean);
  const notMine = raw.length - classified.length;
  if (notMine > 0) console.log(`  skipped ${notMine} game(s): username not found on either side`);

  const eligible = classified.filter((c) => {
    if (!c.pgn) return false;
    if (c.rules !== 'chess') return false; // no chess960/bughouse — the renderer is standard chess
    if (args.timeClass && c.timeClass !== args.timeClass) return false;
    return countMoves(c.pgn) >= args.minMoves;
  });
  console.log(`  ${eligible.length} eligible after filters (standard chess, >= ${args.minMoves} moves${args.timeClass ? `, ${args.timeClass}` : ''})`);

  const available = eligible.reduce((acc, c) => { acc[c.outcome] = (acc[c.outcome] ?? 0) + 1; return acc; }, {});
  console.log(`  available spread: ${available.win ?? 0} win / ${available.loss ?? 0} loss / ${available.draw ?? 0} draw`);

  const picked = selectSpread(eligible, args.count);
  const spread = picked.reduce((acc, c) => { acc[c.outcome] = (acc[c.outcome] ?? 0) + 1; return acc; }, {});
  console.log(`\nSelected ${picked.length}: ${spread.win ?? 0} win / ${spread.loss ?? 0} loss / ${spread.draw ?? 0} draw\n`);

  if (picked.length === 0) {
    console.error('Nothing to write. Try lowering --min-moves or raising --count.');
    process.exit(1);
  }

  const manifest = [];
  const seen = new Set();
  for (const entry of picked) {
    let gameId = `real-${entry.yyyymmdd}-${entry.outcome}-${entry.termination}`;
    let suffix = 2;
    while (seen.has(gameId)) gameId = `real-${entry.yyyymmdd}-${entry.outcome}-${entry.termination}-${suffix++}`;
    seen.add(gameId);

    const moves = countMoves(entry.pgn);
    manifest.push({
      game_id: gameId,
      outcome: entry.outcome,
      termination: entry.termination,
      colour: entry.colour,
      moves,
      time_class: entry.timeClass,
      my_rating: entry.myRating,
      opponent: entry.opponent,
      opponent_rating: entry.theirRating,
      url: entry.url
    });

    if (!args.dryRun) {
      await mkdir(args.out, { recursive: true });
      await writeFile(join(args.out, `${gameId}.pgn`), buildPgn(entry, gameId));
    }
    console.log(`  ${args.dryRun ? '[dry-run] ' : ''}${gameId}.pgn  (${moves} moves, ${entry.colour}, vs ${entry.opponent})`);
  }

  if (!args.dryRun) {
    await writeFile(join(args.out, '_fetch-manifest.json'), JSON.stringify({ user: args.user, fetchedAt: new Date().toISOString(), spread, games: manifest }, null, 2) + '\n');
    console.log(`\nWrote ${picked.length} PGN(s) to ${relative(PROJECT_ROOT, args.out)}/`);
    console.log('\nNext:');
    console.log('  node tools/evaluation/runCorpus.mjs --corpus tools/evaluation/corpus/real');
    console.log('  node tools/evaluation/buildLabels.mjs');
    console.log('  # then fill in the human verdict fields in tools/evaluation/labels/labels.json');
  }
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  if (String(err.message).includes('fetch failed') || String(err.message).includes('ENOTFOUND')) {
    console.error('\nIf outbound access to api.chess.com is blocked here, use the offline path:');
    console.error('  save the monthly archive JSON elsewhere, then re-run with --from-dir <folder>');
  }
  process.exit(1);
});
