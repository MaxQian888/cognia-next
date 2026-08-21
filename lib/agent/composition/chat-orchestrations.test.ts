import { AGENT_ORCHESTRATION_POLICIES } from "@cognia/agent-config-types/agent-composition"
import {
  CHAT_SUPPORTED_ORCHESTRATIONS,
  allOrchestrations,
  chatOrchestrationUnavailableReason,
} from "./chat-orchestrations"

describe("chat orchestration availability", () => {
  it("supports exactly the executors a chat turn can reach today", () => {
    // Tightened deliberately: this list is the guard against re-adding a
    // control nothing consumes. Growing it requires a consumer.
    expect([...CHAT_SUPPORTED_ORCHESTRATIONS]).toEqual(["direct", "team"])
  })

  it("gives no reason for a policy that works here", () => {
    for (const policy of CHAT_SUPPORTED_ORCHESTRATIONS) {
      expect(chatOrchestrationUnavailableReason(policy)).toBeNull()
    }
  })

  it("distinguishes 'reachable another way' from 'not built'", () => {
    // Collapsing these into one label would tell a user that @mention and
    // /workflow do not exist.
    expect(chatOrchestrationUnavailableReason("subagent")).toBe("viaMention")
    expect(chatOrchestrationUnavailableReason("workflow")).toBe("viaSlashCommand")
    expect(chatOrchestrationUnavailableReason("verified-fresh-agent")).toBe("notImplemented")
  })

  it("answers for every policy in the union, supported or not", () => {
    for (const policy of AGENT_ORCHESTRATION_POLICIES) {
      const reason = chatOrchestrationUnavailableReason(policy)
      const supported = CHAT_SUPPORTED_ORCHESTRATIONS.includes(policy)
      expect(reason === null).toBe(supported)
    }
  })

  it("exposes the full union so the picker can still list what it cannot run", () => {
    expect(allOrchestrations()).toEqual(AGENT_ORCHESTRATION_POLICIES)
  })
})
