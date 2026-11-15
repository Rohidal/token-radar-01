// Launch Radar entrypoint (Node 22, standard library only, no build step).
//
//   node main.ts --input /input                  # the graded run: reads /input/snapshot.json
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// What it does, in order:
//   1. parses the sealed snapshot and refuses anything that is not the shape the model scores;
//   2. scores every pre-token protocol (the whole watchlist plus the 160 largest below the floor)
//      with lib/model.ts, and refuses to write a board the gate would turn away;
//   3. writes /output/board.json (the ranked board, each row with its farm plan) and
//      /output/data.js (the same rows plus the model's comps, for the page);
//   4. copies dashboard/ and screenshots/ into /output, checking the screenshot caps itself;
//   5. writes /output/dossier.json with the vendored make.fun library, last, so the scorer can
//      rebuild it from the same bytes and compare.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps: the text cap shapes the dossier's bytes, the rest only refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** `--name <value>` out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`launch radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`launch radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}
if (board.length < 100 || board.length > 4000) {
  process.stderr.write(`launch radar: ${board.length} rows is outside the gate's 100..4000\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping dot names; returns what it copied. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dash = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
if (!dash.includes('index.html')) {
  process.stderr.write('launch radar: dashboard/index.html is missing\n');
  process.exit(1);
}

const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`launch radar: screenshots/ holds ${shots.length} image(s): hand in three, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`launch radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier last: the scorer rebuilds it from this /output and compares byte for byte.
writeFileSync(
  join(out, 'dossier.json'),
  buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const first = board[0]!;
process.stdout.write(
  `launch radar: ${snapshot.protocols.length} protocols read, ${snapshot.watchlist.length} on the watchlist, ` +
    `${board.length} rows scored (${radar.early_size} early) against ${radar.comps.global_sample} comparables\n` +
    `launch radar: rank 1 ${first.name} at $${first.implied_value_usd.toLocaleString('en-US')}; ` +
    `wrote board.json, data.js, dashboard/ (${dash.length} files), screenshots/ (${shots.length}) and dossier.json\n`,
);
