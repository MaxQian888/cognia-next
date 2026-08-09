---
name: cognia-host-connector-delivery
description: Use when a request combines Cognia connector health or target resolution with verified notification, integration, or Lark delivery; do not use when handling routine configuration, ingress registration, or status inspection without delivery.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Connector Delivery

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false. Resolve both the
connector and destination before sending anything.

## Workflow

1. List connector resources and inspect connector, adapter, account, and health read commands.
2. Resolve the exact destination through an authoritative read command; retain its stable
   identifier rather than relying on a display name.
3. Inspect the outbound command schema, supported content type, attachment rules, and idempotency.
4. Read or validate the payload source before delivery. Run `--dry-run` with the exact body.
5. Obtain explicit user confirmation for high- or critical-risk delivery. Never add `--yes` without
   that confirmation, and reuse the idempotency key on retry.
6. Execute one delivery and verify its receipt, audit, or delivery-status record with a read RPC.

Do not guess targets, duplicate a timed-out send with a new key, expose connector credentials, or
assume opaque result fields.
