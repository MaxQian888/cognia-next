---
name: cognia-host-extensions
description: Use when a request is a single Cognia plugin, skill, MCP, or provider lookup, diagnostic, permission, runtime, or lifecycle operation; do not use when staging and validating a multi-step release, where cognia-host-extension-rollout applies.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Extensions

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Search this domain before choosing a runtime:

```bash
cognia host resources --category extensions
cognia host commands --category extensions --resource <resource> --query <plugin-skill-mcp-or-provider>
```

## Workflow

1. List capabilities/status before install, load, activate, unload, or uninstall.
2. Distinguish WASM, JavaScript, Python, and VS Code plugin lifecycle commands.
3. Inspect requested permissions and allowlists before granting or changing them.
4. For staged updates and skill bundle uploads, complete or discard/abort the same transaction.
5. Start provider diagnostics, retain their identifier, and query status/history rather than guessing.

Plugin calls may execute third-party code. Never grant permissions or install code without explicit
user intent and the required risk confirmation.
