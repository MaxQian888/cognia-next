---
name: cognia-host-connectors
description: Use when inspecting routine Cognia connector health, adapters, attachments, WebSockets, integration ingress, or drafts; do not use when the task culminates in outbound delivery, where cognia-host-connector-delivery applies.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Connectors

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover connector commands with:

```bash
cognia host resources --category connectors
cognia host commands --category connectors --resource <resource> --query <platform-or-transport>
```

## Workflow

1. Check connector health and registered adapters before sending or changing policy.
2. Keep adapter IDs, conversation identifiers, ingress registrations, and WebSocket handles distinct.
3. Use attachment read/fetch and media-upload lifecycles exactly as their schemas specify.
4. Inspect connector drafts before approve or reject; never invent the user's decision.
5. Treat HTTP/WS calls and notification publication as external side effects.

Never expose connector credentials or keyring results. Require explicit intent before outbound sends.
