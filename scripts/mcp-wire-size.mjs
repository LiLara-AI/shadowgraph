// Measures what `tools/list` actually puts on the wire, so a claim about tool
// metadata size can be reproduced instead of estimated.
//
// One boundary is used for every number: the UTF-8 byte length of
// `JSON.stringify(result.tools)`. The JSON-RPC envelope around it is a constant,
// reported once, so a figure quoted with or without the envelope can be
// reconciled without guessing which was meant. Each row is broken down by
// member, so a change can be attributed to descriptions, input schemas, output
// schemas, or annotations rather than to "the tool list".
//
// Pure: reads only the catalog module, never the environment or a store.
//
// Usage:
//   node scripts/mcp-wire-size.mjs                  print the table
//   node scripts/mcp-wire-size.mjs --json           print the same data as JSON
//   node scripts/mcp-wire-size.mjs --diff FILE      compare against saved JSON
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { METADATA_TIER, buildToolCatalog, projectTool, selectTools } from '../src/mcp-tools.js';

const TIERS = [['bare', METADATA_TIER.BARE], ['annotated', METADATA_TIER.ANNOTATED], ['structured', METADATA_TIER.STRUCTURED]];
const MEMBERS = ['name', 'description', 'inputSchema', 'annotations', 'outputSchema'];
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
// `{"jsonrpc":"2.0","id":1,"result":{"tools":[…]}}` minus the array itself.
export const ENVELOPE_BYTES = bytes({ jsonrpc: '2.0', id: 1, result: { tools: [] } }) - bytes([]);

// Byte cost of one tier's projection, attributed to the member each byte belongs
// to. A member costs its key, the colon, and its serialized value; whatever is
// left over is the JSON punctuation holding the array and objects together.
export function measureTier(tools) {
  const total = bytes(tools);
  const parts = {};
  for (const member of MEMBERS) {
    parts[member] = tools.reduce((sum, tool) => sum + (Object.hasOwn(tool, member) ? bytes(member) + 1 + bytes(tool[member]) : 0), 0);
  }
  const attributed = Object.values(parts).reduce((sum, value) => sum + value, 0);
  return { total, withEnvelope: total + ENVELOPE_BYTES, ...parts, punctuation: total - attributed };
}

export function measureTools(tools) {
  const descriptions = tools.map((tool) => tool.description ?? '');
  const measured = {
    count: tools.length,
    descriptionChars: descriptions.reduce((sum, text) => sum + text.length, 0),
    longestDescription: Math.max(...descriptions.map((text) => text.length)),
    tiers: {}
  };
  for (const [label, tier] of TIERS) measured.tiers[label] = measureTier(tools.map((tool) => projectTool(tool, tier)));
  return measured;
}

// Both advertised modes for one server configuration.
export function measureModes(options = {}) {
  const catalog = buildToolCatalog(options);
  return {
    full: measureTools(selectTools(catalog)),
    compact: measureTools(selectTools(catalog, { compact: true }))
  };
}

export function measureAll() {
  return {
    envelopeBytes: ENVELOPE_BYTES,
    withoutVerifier: measureModes({ verifier: false, embeddingConfigured: false }),
    withVerifier: measureModes({ verifier: true, embeddingConfigured: false })
  };
}

function rowsOf(report) {
  const rows = [];
  for (const [build, modes] of [['no verifier', report.withoutVerifier], ['verifier', report.withVerifier]]) {
    for (const [mode, measured] of Object.entries(modes)) {
      for (const [tier, sizes] of Object.entries(measured.tiers)) {
        rows.push({ build, mode, tier, count: measured.count, descriptionChars: measured.descriptionChars, ...sizes });
      }
    }
  }
  return rows;
}

const COLUMNS = ['count', 'total', 'withEnvelope', 'name', 'description', 'inputSchema', 'annotations', 'outputSchema', 'punctuation', 'descriptionChars'];

export function formatReport(report, baseline) {
  const rows = rowsOf(report);
  const baseRows = baseline ? rowsOf(baseline) : [];
  const find = (row) => baseRows.find((candidate) => candidate.build === row.build && candidate.mode === row.mode && candidate.tier === row.tier);
  const cell = (row, column) => {
    const value = row[column];
    const previous = find(row)?.[column];
    if (previous === undefined || previous === value) return String(value);
    const delta = value - previous;
    return `${value} (${delta > 0 ? '+' : ''}${delta})`;
  };
  const header = ['build', 'mode', 'tier', ...COLUMNS];
  const table = [header, ...rows.map((row) => [row.build, row.mode, row.tier, ...COLUMNS.map((column) => cell(row, column))])];
  const widths = header.map((_, index) => Math.max(...table.map((line) => line[index].length)));
  const rendered = table.map((line) => line.map((value, index) => (index < 3 ? value.padEnd(widths[index]) : value.padStart(widths[index]))).join('  '));
  return [
    `tools/list wire size, in UTF-8 bytes of JSON.stringify(result.tools).`,
    `The JSON-RPC envelope adds ${report.envelopeBytes} bytes to every row.`,
    '',
    ...rendered,
    ''
  ].join('\n');
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const report = measureAll();
  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const diffAt = args.indexOf('--diff');
    const baseline = diffAt >= 0 && args[diffAt + 1] ? JSON.parse(await readFile(args[diffAt + 1], 'utf8')) : null;
    process.stdout.write(formatReport(report, baseline));
  }
}
