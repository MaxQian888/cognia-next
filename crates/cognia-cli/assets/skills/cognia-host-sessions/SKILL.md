---
name: cognia-host-sessions
description: Use when a request stays within session discovery, timelines, message delivery, or character binding to operate routine Cognia chat data; do not use when the request spans domains or is primarily an agent, task, or connector workflow.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Sessions

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover commands with:

```bash
cognia host resources --category sessions
cognia host commands --category sessions --resource <resource> --format json
```

## Workflow

1. List or inspect sessions before selecting an identifier.
2. Read the selected command schema; do not infer message or timeline fields.
3. Prefer read commands such as session listing, timeline, and message lookup before mutations.
4. For message or character writes, preserve the generated idempotency key when retrying.
5. Treat response fields as opaque unless the catalog later marks them typed.

Never create a new message, delete content, or bind a character without matching the user's stated
session and intent.
