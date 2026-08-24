# Security policy

## Supported versions

Only the latest release on the default branch is currently supported.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Contact the repository maintainers privately through the security contact configured on the GitHub repository.

ShadowGraph is local-first, but its HTTP API has no authentication in the current release. Keep it bound to `127.0.0.1` and do not expose it to a network until an authenticated deployment wrapper is added.

Do not store secrets, API keys, credentials, or sensitive conversation transcripts in the JSON store unless your local storage and backup policy explicitly permits it.
