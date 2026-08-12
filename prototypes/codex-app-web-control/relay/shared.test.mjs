import assert from "node:assert/strict"
import test from "node:test"

import { corsHeadersForOrigin } from "./shared.mjs"

test("CORS headers are emitted only for an allowlisted Cognia Web origin", () => {
  const allowed = new Set(["http://127.0.0.1:3000"])

  assert.deepEqual(corsHeadersForOrigin(allowed, "https://remote.example"), {})
  assert.deepEqual(corsHeadersForOrigin(allowed, undefined), {})
  assert.deepEqual(corsHeadersForOrigin(allowed, "http://127.0.0.1:3000"), {
    "access-control-allow-origin": "http://127.0.0.1:3000",
    "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, X-Cognia-Pairing-Code, X-Attachment-Name, X-Attachment-Size, X-Attachment-Relative-Path",
    "access-control-max-age": "600",
    vary: "Origin",
  })
})
