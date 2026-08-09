---
name: cognia-host-knowledge
description: Use when a request concerns Cognia memory retrieval, digital-twin sources or profiles, ingestion jobs, OCR extraction, or model management; do not use when the primary task is connector export or host-storage recovery.
license: AGPL-3.0-or-later
compatibility: Requires the cognia CLI; RPC calls require a same-host cognia-server Headless endpoint.
---

# Cognia Host Knowledge

Before any RPC, run `cognia host skills read cognia-host` and follow its offline check, schema,
state-read, dry-run and confirmation, accepted/completed handling, and authoritative verification
sequence. Never add `--yes` without confirmation of the exact operation and arguments. After a
timeout, retry only the same body and idempotency key; stop on validation, authentication,
confirmation, or resync errors. Treat results as opaque when `outputTyped` is false.

Discover knowledge commands with:

```bash
cognia host resources --category knowledge
cognia host commands --category knowledge --resource <resource> --query <memory-twin-or-ocr-term>
```

## Workflow

1. Search/list before update, forget, delete, pause, retry, or cancel.
2. Keep twin IDs, source IDs, ingestion job IDs, and OCR backend/model IDs distinct.
3. Inspect source and profile schemas before ingestion or profile updates.
4. Check available OCR backends/model status before extraction or download.
5. Treat memory and twin results as potentially sensitive local data.

Do not send retrieved personal data elsewhere unless the user explicitly requests that separate
action and its outbound path satisfies the applicable privacy gate.
