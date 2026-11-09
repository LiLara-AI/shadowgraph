import { createInterface } from 'node:readline';

// Deliberately reads the real process streams: neither arguments nor injected
// callbacks can turn an agent invocation into owner confirmation.
export async function ownerAnswer(prompt) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return null;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => {
      terminal.once('close', () => resolve(null));
      terminal.question(prompt, resolve);
    });
  } finally { terminal.close(); }
}

export async function confirmOwnerAction(title, resolvedBounds) {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return false;
  process.stdout.write(`${title}\n${JSON.stringify(resolvedBounds, null, 2)}\n`);
  return (await ownerAnswer('Type confirm to authorize these exact bounds: ')) === 'confirm';
}
