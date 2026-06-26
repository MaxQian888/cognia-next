// Tests for the a2ui MCP protocol-version negotiation helper. Located under
// `dispatch/` so it runs under the `sidecar:test:dispatch` glob (the standalone
// `sidecar/a2ui-mcp.mjs` is a boot script and can't be imported without
// starting the server, so the negotiation logic lives in an importable module).

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  negotiateProtocolVersion,
  A2UI_MCP_PROTOCOL_VERSIONS,
  A2UI_MCP_PREFERRED_PROTOCOL_VERSION,
} from "../a2ui-tools/protocol-version.mjs"

test("echoes a supported client protocol version", () => {
  for (const v of A2UI_MCP_PROTOCOL_VERSIONS) {
    assert.equal(negotiateProtocolVersion(v), v)
  }
})

test("falls back to the preferred version for an unknown client version", () => {
  assert.equal(negotiateProtocolVersion("2099-01-01"), A2UI_MCP_PREFERRED_PROTOCOL_VERSION)
})

test("falls back to the preferred version when the client sends none / non-string", () => {
  assert.equal(negotiateProtocolVersion(undefined), A2UI_MCP_PREFERRED_PROTOCOL_VERSION)
  assert.equal(negotiateProtocolVersion(null), A2UI_MCP_PREFERRED_PROTOCOL_VERSION)
  assert.equal(negotiateProtocolVersion(42), A2UI_MCP_PREFERRED_PROTOCOL_VERSION)
})

test("the legacy baseline 2024-11-05 is still honoured (back-compat)", () => {
  assert.equal(negotiateProtocolVersion("2024-11-05"), "2024-11-05")
})

test("the preferred version is itself a supported version", () => {
  assert.ok(A2UI_MCP_PROTOCOL_VERSIONS.includes(A2UI_MCP_PREFERRED_PROTOCOL_VERSION))
})
