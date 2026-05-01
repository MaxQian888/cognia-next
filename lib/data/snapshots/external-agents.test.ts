import {
  EXTERNAL_AGENTS_LABEL_KEY,
  EXTERNAL_AGENTS_PERSIST_KEY,
  EXTERNAL_AGENTS_STORE_VERSION,
  externalAgentsSnapshot,
} from "./external-agents"
import { createMemoryStorage } from "./helpers"
import type { SnapshotEnv } from "./types"

describe("externalAgentsSnapshot", () => {
  it("exposes the expected persist key and labels", () => {
    expect(externalAgentsSnapshot.key).toBe(EXTERNAL_AGENTS_PERSIST_KEY)
    expect(externalAgentsSnapshot.labelKey).toBe(EXTERNAL_AGENTS_LABEL_KEY)
    expect(externalAgentsSnapshot.exposeAsDomain).toBe(true)
    expect(EXTERNAL_AGENTS_STORE_VERSION).toBe(5)
  })

  it("captures a real-shaped payload", () => {
    const sample = {
      state: {
        agents: {
          "claude-code": {
            id: "claude-code",
            name: "Claude Code",
            protocol: "acp",
          },
        },
        delegationRules: [],
        activeAgentId: "claude-code",
        agentValidity: {},
        benchmarkCapabilityMap: {},
        lastRunSnapshots: {},
        enabled: true,
        defaultPermissionMode: "ask",
        autoConnectOnStartup: false,
        showConnectionNotifications: true,
        chatFailurePolicy: "fallback",
      },
      version: EXTERNAL_AGENTS_STORE_VERSION,
    }
    const { storage } = createMemoryStorage({
      [EXTERNAL_AGENTS_PERSIST_KEY]: JSON.stringify(sample),
    })
    const env: SnapshotEnv = { storage }
    const snap = externalAgentsSnapshot.read(env)
    expect(snap?.storeVersion).toBe(EXTERNAL_AGENTS_STORE_VERSION)
    expect(snap?.raw.state).toEqual(sample.state)
  })

  it("returns null when key is absent", () => {
    const { storage } = createMemoryStorage()
    const env: SnapshotEnv = { storage }
    expect(externalAgentsSnapshot.read(env)).toBeNull()
  })

  it("warns when the stored blob is suspiciously large", () => {
    const big = "x".repeat(2_000_000)
    const sample = JSON.stringify({ state: { junk: big }, version: 5 })
    const { storage } = createMemoryStorage({
      [EXTERNAL_AGENTS_PERSIST_KEY]: sample,
    })
    const warn = jest.fn()
    const env: SnapshotEnv = { storage, warn }
    externalAgentsSnapshot.read(env)
    expect(warn).toHaveBeenCalled()
  })

  it("writes back via overwrite and round-trips", () => {
    const { storage, data } = createMemoryStorage()
    const env: SnapshotEnv = { storage }
    const sample = {
      state: { agents: { foo: { id: "foo" } }, enabled: false },
      version: 5,
    } as { state: unknown; version: number }
    externalAgentsSnapshot.write(
      {
        key: EXTERNAL_AGENTS_PERSIST_KEY,
        storeVersion: 5,
        snapshotFormatVersion: 1,
        raw: sample,
        capturedAt: "2024-01-01T00:00:00.000Z",
      },
      "overwrite",
      env
    )
    expect(data.get(EXTERNAL_AGENTS_PERSIST_KEY)).toBe(JSON.stringify(sample))
  })
})
