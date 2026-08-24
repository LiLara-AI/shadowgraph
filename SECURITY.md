# Security policy

## Supported versions

Only the latest release on the default branch is currently supported.

## Reporting a vulnerability

Please do not open a public issue for a suspected security vulnerability. Contact the repository maintainers privately through the security contact configured on the GitHub repository.

ShadowGraph is local-first. The HTTP API remains bound to `127.0.0.1` by default and rejects non-local browser origins. For shared local deployments, set `SHADOWGRAPH_API_TOKEN` to a random value of at least 16 characters; clients must send `Authorization: Bearer <token>`. Treat any local process with access to the port or token as trusted. Do not expose the API publicly without TLS, authentication, rate limiting, and a deployment threat model.

Do not store secrets, API keys, credentials, or sensitive conversation transcripts in the JSON store unless your local storage and backup policy explicitly permits it.
