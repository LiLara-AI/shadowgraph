// P1-3: ONE source of truth for the version string.
//
// `/health` used to carry a hardcoded '0.30.0' while package.json said something
// else and src/mcp.js carried a third copy. Three literals meant two of them were
// always free to drift, and a version a client reads over HTTP is a contract, not
// decoration. Everything now reads package.json.
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const NAME = 'shadowgraph';
