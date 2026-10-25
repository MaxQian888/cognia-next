const installPersonAgents = jest.fn(async () => async () => undefined)
jest.mock("@/lib/headless/person-agent", () => ({ installPersonAgents }))
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => ({ id: "manager" }),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { id: "transport" } }))

import { initializePersonChat } from "@/lib/headless/person-chat"
import { listHeadlessRuntimes } from "../registry"
import "./person-agent"

const ctx = { host: "person-brain", log: jest.fn() } as never

function runtime() {
  const found = listHeadlessRuntimes().find((entry) => entry.name === "person-agent")
  if (!found) throw new Error("person-agent is not registered")
  return found
}

afterEach(() => {
  initializePersonChat("brain", {})
  installPersonAgents.mockClear()
})

describe("person-agent runtime", () => {
  it("p6e runs in person brains only", () => {
    expect(runtime().hosts).toEqual(["person-brain"])
  })

  it("p6e stays inert unless the Host advertised sandboxed execution", async () => {
    initializePersonChat("person-brain", { COGNIA_PERSON_CHAT: "tool-less" })
    const stop = await runtime().start(ctx)
    expect(installPersonAgents).not.toHaveBeenCalled()
    if (typeof stop === "function") await stop()
  })

  it("p6e installs the member agent host on a conforming Host", async () => {
    initializePersonChat("person-brain", { COGNIA_PERSON_EXECUTION: "sandboxed" })
    const stop = await runtime().start(ctx)
    expect(installPersonAgents).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: { id: "transport" },
        manager: { id: "manager" },
      })
    )
    expect(typeof stop).toBe("function")
  })
})
