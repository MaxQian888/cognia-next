/**
 * @jest-environment jsdom
 */

import { PluginConsentBroker, resetPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import { agentTrustPluginId, isAgentTrusted, requestAgentTrust } from "./agent-trust"

beforeEach(() => {
  resetPluginConsentBroker()
})

describe("agent-trust", () => {
  it("encodes (chatSessionId, tabId) into a stable synthetic pluginId", () => {
    expect(agentTrustPluginId("chat-1", "tab-a")).toBe("agent:chat-1:tab-a")
  })

  it("requestAgentTrust dispatches a consent event via the broker", async () => {
    const events: Array<{ pluginId: string; permission: string }> = []
    const broker = new PluginConsentBroker({
      emit: (event) => events.push({ pluginId: event.pluginId, permission: event.permission }),
    })
    void requestAgentTrust({
      chatSessionId: "c-1",
      tabId: "t-1",
      tabTitle: "build",
      commandPreview: "cargo test",
      broker,
    })
    expect(events).toHaveLength(1)
    expect(events[0].pluginId).toBe("agent:c-1:t-1")
    expect(events[0].permission).toBe("terminal:write")
  })

  it("resolves true when the user grants + persists", async () => {
    let requestId = ""
    const broker = new PluginConsentBroker({
      emit: (event) => {
        requestId = event.requestId
      },
    })
    const pending = requestAgentTrust({
      chatSessionId: "c",
      tabId: "t",
      tabTitle: "x",
      commandPreview: "ls",
      broker,
    })
    broker.respond(requestId, { allow: true, persist: true })
    await expect(pending).resolves.toBe(true)
    expect(isAgentTrusted("c", "t", broker)).toBe(true)
  })

  it("resolves false when the user rejects", async () => {
    let requestId = ""
    const broker = new PluginConsentBroker({
      emit: (event) => {
        requestId = event.requestId
      },
    })
    const pending = requestAgentTrust({
      chatSessionId: "c",
      tabId: "t",
      tabTitle: "x",
      commandPreview: "rm -rf /",
      broker,
    })
    broker.respond(requestId, { allow: false, persist: false })
    await expect(pending).resolves.toBe(false)
    expect(isAgentTrusted("c", "t", broker)).toBe(false)
  })

  it("a persisted grant short-circuits the next request without prompting again", async () => {
    let requestId = ""
    let emitCount = 0
    const broker = new PluginConsentBroker({
      emit: (event) => {
        requestId = event.requestId
        emitCount += 1
      },
    })
    const first = requestAgentTrust({
      chatSessionId: "c",
      tabId: "t",
      tabTitle: "x",
      commandPreview: "ls",
      broker,
    })
    broker.respond(requestId, { allow: true, persist: true })
    await first
    expect(emitCount).toBe(1)
    const second = requestAgentTrust({
      chatSessionId: "c",
      tabId: "t",
      tabTitle: "x",
      commandPreview: "ls",
      broker,
    })
    await expect(second).resolves.toBe(true)
    expect(emitCount).toBe(1)
  })

  it("trust is scoped per tab — same chat, different tab requires a new prompt", async () => {
    let lastRequestId = ""
    let emitCount = 0
    const broker = new PluginConsentBroker({
      emit: (event) => {
        lastRequestId = event.requestId
        emitCount += 1
      },
    })
    const first = requestAgentTrust({
      chatSessionId: "c",
      tabId: "t1",
      tabTitle: "build",
      commandPreview: "cargo build",
      broker,
    })
    broker.respond(lastRequestId, { allow: true, persist: true })
    await first
    // Same chat, different tab → new emit expected.
    const second = requestAgentTrust({
      chatSessionId: "c",
      tabId: "t2",
      tabTitle: "test",
      commandPreview: "cargo test",
      broker,
    })
    expect(emitCount).toBe(2)
    broker.respond(lastRequestId, { allow: true, persist: false })
    await expect(second).resolves.toBe(true)
  })

  it("truncates long command previews in the reason string", async () => {
    let captured: { reason?: string } = {}
    const broker = new PluginConsentBroker({
      emit: (event) => {
        captured = { reason: event.reason }
      },
    })
    void requestAgentTrust({
      chatSessionId: "c",
      tabId: "t",
      tabTitle: "x",
      commandPreview: "echo " + "x".repeat(200),
      broker,
    })
    expect(captured.reason?.length).toBeLessThan(200)
    expect(captured.reason).toContain("…")
  })
})
