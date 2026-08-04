import assert from "node:assert/strict"
import test from "node:test"

import { ACP_V1_CONTRACT, validateAcpV1Coverage } from "./lib/acp-v1-contract.mjs"

test("pins the stable ACP v1 schema and SDK artifacts", () => {
  assert.equal(ACP_V1_CONTRACT.protocolVersion, 1)
  assert.equal(ACP_V1_CONTRACT.schema.version, "1.20.0")
  assert.equal(
    ACP_V1_CONTRACT.schema.sha256,
    "92c1dfcda10dd47e99127500a3763da2b471f9ac61e12b9bf0430c32cf953796"
  )
  assert.equal(ACP_V1_CONTRACT.sdk.version, "1.3.0")
  assert.equal(
    ACP_V1_CONTRACT.sdk.integrity,
    "sha512-i3h/efaeuMUFAO1HSfo97QZQnnvMd7wWBYtBsdL6UMZg3a78sk3Ffya5Xu7C7tYsXomXoDXJBAzQF2PcFKAhIQ=="
  )
})

test("keeps stable, feature-gated, and compatibility methods separate", () => {
  assert.ok(ACP_V1_CONTRACT.stable.clientToAgent.includes("session/list"))
  assert.ok(ACP_V1_CONTRACT.featureGated.agentToClient.includes("elicitation/create"))
  assert.ok(ACP_V1_CONTRACT.compatibility.agentMethods.includes("session/set_model"))
  assert.ok(!ACP_V1_CONTRACT.stable.agentToClient.includes("elicitation/create"))
  assert.ok(!ACP_V1_CONTRACT.stable.clientToAgent.includes("session/set_model"))
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
