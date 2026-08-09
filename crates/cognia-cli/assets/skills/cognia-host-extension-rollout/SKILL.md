---
name: cognia-host-extension-rollout
description: Use when a Cognia plugin, skill, MCP, or provider rollout spans validation, installation, activation, diagnostics, rollback, or removal; do not use when handling a single lookup, permission change, runtime call, or routine diagnostic.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Extension Rollout

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false. Use generated
extension resources rather than guessing RPC names.

## Workflow

1. List extension resources and read current installations, capabilities, versions, and runtime
   health.
2. Discover the exact stage/install/validate/activate/rollback commands and inspect each schema.
3. Stage or install the smallest requested artifact. Preserve extension identifiers and versions.
4. Validate manifest, permissions, runtime diagnostics, and compatibility before activation.
5. Run `--dry-run` for activation, replacement, removal, or rollback operations.
6. Obtain explicit user confirmation for high- or critical-risk changes. Never add `--yes` without
   that confirmation, and preserve idempotency across retries.
7. Re-read installation and runtime status after activation. On failure, inspect diagnostics before
   selecting rollback or discard; verify the final state.

Do not silently broaden permissions, replace a different extension version, or infer fields from
opaque output.
