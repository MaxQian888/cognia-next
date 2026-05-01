import {
  AGENT_RUNTIME_LABEL_KEY,
  AGENT_RUNTIME_PERSIST_KEY,
  agentRuntimeSnapshot,
} from "./agent-runtime"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("agentRuntimeSnapshot", () => {
  it("uses the namespaced persist key", () => {
    expect(agentRuntimeSnapshot.key).toBe(AGENT_RUNTIME_PERSIST_KEY)
    expect(AGENT_RUNTIME_PERSIST_KEY).toBe("cognia-next.agent-runtime")
    expect(agentRuntimeSnapshot.labelKey).toBe(AGENT_RUNTIME_LABEL_KEY)
    expect(agentRuntimeSnapshot.exposeAsDomain).toBe(true)
  })

  it("captures the small runtime pointer", () => {
    const payload = {
      state: { runtime: "claude", modeId: "default", externalAgentId: "claude-code" },
      version: 0,
    }
    const { storage } = createMemoryStorage({
      [AGENT_RUNTIME_PERSIST_KEY]: JSON.stringify(payload),
    })
    const env: SnapshotEnv = { storage }
    expect(agentRuntimeSnapshot.read(env)?.raw.state).toEqual(payload.state)
  })
})
