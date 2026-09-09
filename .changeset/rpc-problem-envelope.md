---
"cognia-next": patch
---

Every failure on the companion HTTP planes (`/api/*`, `/internal/*`, the WebSocket upgrade rejections, the operator and workflow portal routes, the Lark listener, and the draining 503) is now one RFC 9457 problem document served as `application/problem+json`: `{type, title, status, detail, instance?, code, requestId, retryable, details, operationId?}` with `requestId` mirrored in the `x-request-id` header and a quantified wait mirrored in `retry-after`. This replaces the nested `{error: {…}}` of the device plane, the flat `{code, message}` of the internal plane, the two workflow `ErrorBody` shapes, the bare `{error: "code"}` and the plain-text draining answer. Idempotency receipts persist and replay the same document, and an arm's own `retryable` answer now survives to the device plane instead of being re-derived from the status. The app, the CLI and the companion-client package parse the document and still read the shapes older Hosts wrote.
