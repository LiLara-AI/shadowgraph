// Removes one scratch root when the process that owns it dies without cleaning
// up - a SIGKILL, a crash, or the group kill a timeout harness sends. It is
// spawned detached by tools/scratch-directory.js and holds the read end of a
// pipe from its owner: the kernel closes the owner's end however the owner
// dies, so end-of-pipe is the signal that the owner is gone.
//
// It may delete exactly one directory: a real, non-symlink, immediate child of
// the canonical temp root, named for its owner's pid, carrying a marker that
// matches the pid and the nonce it was handed. Everything else is refused with
// a reason and nothing is removed.
import { lstatSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';

const ROOT_PATTERN = /^shadowgraph-scratch-(\d+)-[A-Za-z0-9]{6}$/u;
const OWNER_MARKER = '.owner.json';
const [root, ownerPidRaw, nonce, tempRoot] = process.argv.slice(2);

function refuse(reason) {
  process.stderr.write(`scratch-directory: supervisor refused ${root ?? '(no target)'}: ${reason}\n`);
  process.exit(2);
}

function resolved(path, description) {
  try {
    return realpathSync(path);
  } catch (error) {
    refuse(`${description} does not resolve (${error.code ?? error.message})`);
    return null;
  }
}

// Re-run in full before the removal as well as before arming: the owner lives
// between the two, and a target that stopped satisfying these rules is not ours
// to delete.
function validate() {
  if (!root || !ownerPidRaw || !nonce || !tempRoot) refuse('missing arguments');
  const ownerPid = Number(ownerPidRaw);
  if (!Number.isInteger(ownerPid) || ownerPid <= 0) refuse('owner pid is not a positive integer');
  const name = basename(root);
  const match = ROOT_PATTERN.exec(name);
  if (match === null) refuse('basename is not a scratch root name');
  if (Number(match[1]) !== ownerPid) refuse('basename pid does not match the owner pid');

  const canonicalTemp = resolved(tempRoot, 'temp root');
  let stats;
  try {
    stats = lstatSync(root);
  } catch (error) {
    refuse(error.code === 'ENOENT' ? 'target does not exist' : `target cannot be inspected (${error.code})`);
  }
  if (stats.isSymbolicLink()) refuse('target is a symbolic link');
  if (!stats.isDirectory()) refuse('target is not a directory');

  const canonicalRoot = resolved(root, 'target');
  if (canonicalRoot !== join(resolved(dirname(root), 'target parent'), name)) {
    refuse('target does not resolve to itself inside its parent');
  }
  if (canonicalRoot !== join(canonicalTemp, name)) refuse('target is not an immediate child of the temp root');
  if (canonicalRoot === canonicalTemp || canonicalTemp.startsWith(canonicalRoot + sep)) {
    refuse('target is the temp root or an ancestor of it');
  }

  let marker;
  try {
    marker = JSON.parse(readFileSync(join(canonicalRoot, OWNER_MARKER), 'utf8'));
  } catch (error) {
    refuse(`owner marker is missing or unreadable (${error.code ?? 'malformed'})`);
  }
  if (marker.pid !== ownerPid || marker.nonce !== nonce) refuse('owner marker does not match the handshake');
  return { target: canonicalRoot, ownerPid };
}

const armed = validate();
let finished = false;

function ownerGone() {
  if (finished) return;
  finished = true;
  let leftovers;
  try {
    leftovers = readdirSync(armed.target).filter((entry) => entry !== OWNER_MARKER);
  } catch (error) {
    // The owner removed the root itself, which is the ordinary path: its exit
    // handlers finish before the pipe can close.
    if (error.code === 'ENOENT') process.exit(0);
    process.stderr.write(`scratch-directory: supervisor could not read ${armed.target}: ${error.code ?? error.message}\n`);
    process.exit(1);
  }
  validate();
  try {
    rmSync(armed.target, { recursive: true, force: true, maxRetries: 0 });
  } catch (error) {
    process.stderr.write(`scratch-directory: supervisor could not remove ${armed.target}: ${error.code ?? error.message}\n`);
    process.exit(1);
  }
  if (leftovers.length > 0) {
    const noun = leftovers.length === 1 ? 'directory' : 'directories';
    process.stderr.write(`scratch-directory: owner pid ${armed.ownerPid} of ${armed.target} ended without removing ${leftovers.length} scratch ${noun}; removed by supervisor\n`);
  }
  process.exit(0);
}

process.stdin.resume();
process.stdin.on('end', ownerGone);
process.stdin.on('close', ownerGone);
process.stdin.on('error', ownerGone);
// Only now is the owner told that this process is watching.
process.stdout.write(`READY ${nonce}\n`);
