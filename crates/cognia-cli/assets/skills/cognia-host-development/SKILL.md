---
name: cognia-host-development
description: Use when a request concerns Cognia workspace files, terminals, browser automation, code-server proxies, language servers, or read-only Git discovery; do not use when Git mutation, conflict handling, or recovery is required, where cognia-host-safe-git applies.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Development

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Narrow discovery to development tools:

```bash
cognia host resources --category development
cognia host commands --category development --resource <resource> --query <git-file-terminal-browser-lsp>
```

## Workflow

1. Read repository/file/browser/terminal state before mutation.
2. Prefer confined workspace file commands when both confined and unrestricted variants exist.
3. Inspect Git status, diff, conflicts, and sequencer state before commit, reset, discard, rebase, or
   worktree removal.
4. Treat terminal execution and browser actions as side effects; inspect their exact schemas.
5. Preserve page, browser session, terminal, proxy, and project identifiers across related calls.

Never use destructive Git/file commands or arbitrary terminal execution without confirming the
exact target and command.
