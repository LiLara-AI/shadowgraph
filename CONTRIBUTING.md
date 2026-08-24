# Contributing to ShadowGraph

Thank you for helping improve ShadowGraph.

## Development

Requirements:

- Node.js 20 or newer
- Python 3.10+ only for the optional Hermes adapter check

Install and run checks:

```bash
npm install
npm run check
npm test
```

The project uses Node's built-in test runner and has no runtime dependencies.

## Pull requests

- Keep the core vendor-neutral.
- Add or update tests for behavior changes.
- Do not commit `.shadowgraph/data.json`, credentials, generated files, or `__pycache__`.
- Keep integration templates explicit about assumptions and product-specific behavior.
- Preserve local-only defaults (`127.0.0.1`) unless a change includes authentication and threat-model documentation.
