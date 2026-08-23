import assert from "node:assert/strict"
import test from "node:test"

import { ACP_V1_CONTRACT, validateAcpV1Coverage } from "./lib/acp-v1-contract.mjs"

test("pins the stable and preview ACP v1.21 schema plus SDK 1.4 artifacts", () => {
  assert.equal(ACP_V1_CONTRACT.protocolVersion, 1)
  assert.equal(ACP_V1_CONTRACT.schema.stable.version, "1.21.0")
  assert.equal(
    ACP_V1_CONTRACT.schema.stable.sha256,
    "caf62ff962ada396878372ced11efb2c6764e59d90919a38583c319948931a42"
  )
  assert.equal(
    ACP_V1_CONTRACT.schema.preview.sha256,
    "7f77702b34e0a0558e77220e9007bf8ee161a976bb8ac5021aba1b7e7b2c5708"
  )
  assert.equal(ACP_V1_CONTRACT.sdk.version, "1.4.0")
  assert.equal(
    ACP_V1_CONTRACT.sdk.integrity,
    "sha512-/eufudw+aFY1LKLolT6yFE6UMmYRl7fMJ/DEONSIyR6wI3slHWITBsANRGqXEY8FRzqUxwh7QEaGiZHcJPVThg=="
  )
})

test("keeps stable, preview-gated, and receive-only compatibility paths separate", () => {
  assert.ok(ACP_V1_CONTRACT.stable.clientToAgent.includes("session/list"))
  assert.ok(ACP_V1_CONTRACT.stable.agentToClient.includes("elicitation/create"))
  assert.ok(ACP_V1_CONTRACT.preview.clientToAgent.includes("providers/list"))
  assert.ok(ACP_V1_CONTRACT.preview.agentToClient.includes("mcp/connect"))
  assert.ok(ACP_V1_CONTRACT.preview.updates.includes("compaction_update"))
  assert.ok(ACP_V1_CONTRACT.compatibility.agentMethods.includes("session/set_model"))
  assert.ok(!ACP_V1_CONTRACT.stable.clientToAgent.includes("providers/list"))
  assert.ok(!ACP_V1_CONTRACT.stable.clientToAgent.includes("session/set_model"))
  assert.equal(ACP_V1_CONTRACT.reserved.v2.advertised, false)
})

test("reports every missing stable method and update without accepting aliases", () => {
  const result = validateAcpV1Coverage({
    clientToAgent: ["initialize", "session/set_model"],
    agentToClient: ["session/update"],
    protocol: [],
    updates: ["agent_message_chunk", "thought_message_chunk", "config_options_update"],
  })

  assert.ok(result.missing.clientToAgent.includes("session/list"))
  assert.ok(result.missing.agentToClient.includes("terminal/create"))
  assert.deepEqual(result.missing.protocol, ["$/cancel_request"])
  assert.ok(result.missing.updates.includes("agent_thought_chunk"))
  assert.ok(result.unstableOrLegacy.clientToAgent.includes("session/set_model"))
  assert.ok(result.unstableOrLegacy.updates.includes("thought_message_chunk"))
  assert.equal(result.complete, false)
})

test("accepts exact stable coverage and permits future unknown methods", () => {
  const result = validateAcpV1Coverage({
    clientToAgent: [...ACP_V1_CONTRACT.stable.clientToAgent, "session/future"],
    agentToClient: [...ACP_V1_CONTRACT.stable.agentToClient, "client/future"],
    protocol: [...ACP_V1_CONTRACT.stable.protocol],
    updates: [...ACP_V1_CONTRACT.stable.updates, "future_update"],
  })

  assert.equal(result.complete, true)
  assert.deepEqual(result.missing, {
    clientToAgent: [],
    agentToClient: [],
    protocol: [],
    updates: [],
  })
  assert.deepEqual(result.unknown.clientToAgent, ["session/future"])
  assert.deepEqual(result.unknown.agentToClient, ["client/future"])
  assert.deepEqual(result.unknown.updates, ["future_update"])
})
