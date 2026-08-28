import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function verifyPreregistration(documentPath, hashPath) {
  const [bytes, hashText] = await Promise.all([
    readFile(documentPath),
    readFile(hashPath, 'utf8')
  ]);
  const expected = hashText.trim().split(/\s+/u)[0]?.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(expected ?? '')) {
    throw new Error('Preregistration SHA-256 sidecar is malformed');
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== expected) {
    throw new Error(`Frozen preregistration hash mismatch: expected ${expected}, received ${sha256}`);
  }
  return { sha256, document: JSON.parse(bytes.toString('utf8')) };
}
