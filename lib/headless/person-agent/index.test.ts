jest.mock("@/lib/db/messages", () => ({
  listMessages: jest.fn(async () => [
    { id: "m0", role: "user", parts: [{ type: "text", text: "earlier" }] },
    { id: "m1", role: "user", parts: [{ type: "text", text: "now" }] },
  ]),
  commitMessageDelta: jest.fn(async () => undefined),
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(async () => ({ id: "s1", transcriptRevision: 3 })),
}))
jest.mock("@/lib/work-submission/chat-adapter", () => ({
  settleChatTurn: jest.fn(async () => true),
}))
jest.mock("@/lib/work-submission/host-adapter", () => ({
  hostStateRunId: (actionId: string) => `hoststate:${actionId}`,
}))
jest.mock("@/lib/companion/desktop-write-source", () => ({
  projectBrainRuntimeEnvelope: jest.fn(async () => undefined),
}))

import { getInstalledExternalAgentHost } from "@/lib/ai/agent/external/host/installed-host"
import { getPersonAgentRunner, installPersonAgents, personAgentLaunch } from "./index"
import type { PersonPlaneTransport } from "./process-plane"

function transport(): PersonPlaneTransport & { subscribed: string[] } {
  const subscribed: string[] = []
  return {
    subscribed,
    call: (async () => null) as PersonPlaneTransport["call"],
    subscribe: ((event: string) => {
      subscribed.push(event)
      return () => undefined
    }) as PersonPlaneTransport["subscribe"],
    whenSubscribed: async () => undefined,
  }
}

const manager = {
  addAgent: jest.fn(async () => undefined),
  removeAgent: jest.fn(async () => undefined),
  executeStreaming: jest.fn(),
  cancel: jest.fn(async () => undefined),
  respondToPermission: jest.fn(async () => undefined),
  respondToElicitation: jest.fn(async () => undefined),
}

describe("person agent wiring", () => {
  it("p6e resolves a bundled runtime to its catalog launch and gateway family", () => {
    const launch = personAgentLaunch("claude-agent-acp")
    expect(launch?.family).toBe("claude")
    expect(launch?.config.process).toMatchObject({ command: "claude-agent-acp", args: [] })
    expect(launch?.config.protocol).toBe("acp")
    // No gateway family, no member run.
    expect(personAgentLaunch("gemini-cli")).toBeUndefined()
    expect(personAgentLaunch("not-a-runtime")).toBeUndefined()
  })

  it("p6e installs the partition's only agent host and removes it on teardown", async () => {
    const t = transport()
    const stop = await installPersonAgents({ transport: t, manager, log: () => undefined })
    expect(getInstalledExternalAgentHost()?.kind).toBe("person-brain")
    expect(getPersonAgentRunner()).not.toBeNull()
    // The Host's stop channels are live before any spawn.
    expect(t.subscribed).toEqual(
      expect.arrayContaining(["external-agent://state-change", "external-agent://exit"])
    )
    await stop()
    expect(getInstalledExternalAgentHost()).toBeNull()
    expect(getPersonAgentRunner()).toBeNull()
  })

  it("p6e refuses to install over another shell's host", async () => {
    const first = await installPersonAgents({
      transport: transport(),
      manager,
      log: () => undefined,
    })
    await expect(
      installPersonAgents({ transport: transport(), manager, log: () => undefined })
    ).rejects.toThrow(/already installed/)
    await first()
  })
})
