---
"cognia-next": minor
---

Companion RPC paging and long-running answers follow one shape (ADR-0175 B3). The ten list commands that page take `pageSize` and `pageToken` and answer `{items, nextPageToken}`, the old `limit`, `offset`, `cursor` and `before` names are refused with `400 malformed_request`, and a 202 or an operation lookup answers the one `Operation` document with `done`, `error` and `result` instead of a bare operation id or a raw receipt.
