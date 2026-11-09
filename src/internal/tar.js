// The entries of an uncompressed ustar archive, as `git archive` and `npm pack`
// write them, a pax header's path included: enough to install a pinned
// runtime (scripts/install-runtime.mjs) and to check one against its tarball
// (src/host-hooks.js pinnedRuntime) without depending on a `tar` program.
export function* tarEntries(archive) {
  let longName = null;
  for (let at = 0; at + 512 <= archive.length;) {
    const header = archive.subarray(at, at + 512);
    if (header.every((byte) => byte === 0)) return;
    const field = (from, length) => header.subarray(from, from + length).toString('utf8').replace(/\0.*$/su, '');
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    // A size that is not a whole count would never move past the entry (post-merge review R1-4).
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Malformed tar entry size');
    const type = field(156, 1) || '0';
    const body = archive.subarray(at + 512, at + 512 + size);
    const name = longName ?? [field(345, 155), field(0, 100)].filter(Boolean).join('/');
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      longName = /(?:^|\n)\d+ path=([^\n]*)\n/u.exec(body.toString('utf8'))?.[1] ?? null;
      continue;
    }
    longName = null;
    if (type !== 'g') yield { name, type, body };
  }
}
