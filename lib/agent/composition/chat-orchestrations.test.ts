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
    expect([...CHAT_SUPPORTED_ORCHESTRATIONS]).toEqual(["direct", "team", "verified-fresh-agent"])
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
  })

  it("keeps the independent reviewer visible but disabled on a companion shell", () => {
    // Three-axis dormancy: the follow-up refuses on these profiles too
    // (`verified-fresh-agent.test.ts`), and the picker shows this reason.
    expect(
      chatOrchestrationUnavailableReason("verified-fresh-agent", {
        hostProfile: "mobile-companion",
      })
    ).toBe("companionShell")
    expect(
      chatOrchestrationUnavailableReason("verified-fresh-agent", { hostProfile: "cloud-companion" })
    ).toBe("companionShell")
    for (const profile of ["desktop", "headless", "web-standalone"] as const) {
      expect(
        chatOrchestrationUnavailableReason("verified-fresh-agent", { hostProfile: profile })
      ).toBe(null)
    }
    // The shell never changes the answer for a policy that is unsupported anyway.
    expect(
      chatOrchestrationUnavailableReason("workflow", { hostProfile: "mobile-companion" })
    ).toBe("viaSlashCommand")
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
