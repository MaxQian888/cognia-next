/**
 * @jest-environment jsdom
 *
 * Coverage for the persisted store wiring (`store.ts`):
 * - `migratePersistedAgents` — flagging non-acp agents
 * - `normalizeLastRunSnapshots` — Date / string timestamp coercion
 * - `migrate` — the function passed to `persist({ migrate })`
 */

jest.mock("@/lib/logging", () => {
  const child = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: () => child,
  }
  return {
    loggers: {
      agent: { ...child, child: () => child },
    },
  }
})

import type { ExternalAgentStore, StoredExternalAgentConfig } from "./types"
import type { ExternalAgentValiditySnapshot } from "@/types/agent/external-agent"
import { useExternalAgentStore } from "./store"

const reset = () => {
  useExternalAgentStore.getState().reset()
}

beforeEach(() => {
  reset()
  jest.clearAllMocks()
})

/**
 * The persist `migrate` function is internal to the store — extract it via
 * the test API exposed by zustand's persist middleware. We pull it through
 * the persist options so we exercise the same code paths the runtime uses.
 */
type PersistOpts = {
  migrate: (state: unknown, version: number) => unknown
  partialize: (state: ExternalAgentStore) => unknown
}
type StoreWithPersist = { persist: { getOptions: () => PersistOpts } }

const persistOptions = (useExternalAgentStore as unknown as StoreWithPersist).persist.getOptions()

const baseAgent = (overrides: Partial<StoredExternalAgentConfig> = {}): StoredExternalAgentConfig =>
  ({
    id: "x",
    name: "x",
    description: "",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "x" } as never,
    defaultPermissionMode: "default",
    tags: [],
    timeout: 30000,
    metadata: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as StoredExternalAgentConfig

describe("persist.migrate", () => {
  it("returns sane defaults when the persisted state is null", () => {
    const out = persistOptions.migrate(null, 0) as ExternalAgentStore
    expect(out.agents).toEqual({})
    expect(out.agentValidity).toEqual({})
    expect(out.benchmarkCapabilityMap).toEqual({})
    expect(out.lastRunSnapshots).toEqual({})
    expect(out.chatFailurePolicy).toBe("fallback")
  })

  it("flags non-acp agents as unsupported via migratePersistedAgents", () => {
    const persisted = {
      agents: {
        legacy: baseAgent({
          id: "legacy",
          // @ts-expect-error -- deliberately legacy protocol value
          protocol: "openai-acp",
          metadata: { foo: "bar" } as never,
        }),
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    const meta = out.agents.legacy.metadata as Record<string, unknown>
    expect(meta.unsupported).toBe(true)
    expect(meta.unsupportedProtocol).toBe("openai-acp")
    expect(typeof meta.unsupportedReason).toBe("string")
    expect(meta.foo).toBe("bar")
  })

  it("leaves acp agents alone in migratePersistedAgents", () => {
    const persisted = {
      agents: {
        ok: baseAgent({ id: "ok", protocol: "acp" }),
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect((out.agents.ok.metadata as Record<string, unknown>).unsupported).toBeUndefined()
  })

  it("skips falsy agent entries in migratePersistedAgents", () => {
    const persisted = {
      agents: {
        a: baseAgent({ id: "a" }),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        b: null as any,
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.agents.a).toBeDefined()
    expect(out.agents.b).toBeNull()
  })

  it("normalizes string timestamps in lastRunSnapshots", () => {
    const persisted = {
      lastRunSnapshots: {
        a: { timestamp: "2024-01-01T00:00:00.000Z", success: true },
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.lastRunSnapshots.a.timestamp).toBeInstanceOf(Date)
  })

  it("preserves Date timestamps in lastRunSnapshots", () => {
    const ts = new Date()
    const persisted = {
      lastRunSnapshots: {
        a: { timestamp: ts, success: true },
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.lastRunSnapshots.a.timestamp).toBe(ts)
  })

  it("drops falsy lastRunSnapshots entries", () => {
    const persisted = {
      lastRunSnapshots: {
        a: { timestamp: new Date(), success: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        b: null as any,
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.lastRunSnapshots.a).toBeDefined()
    expect(out.lastRunSnapshots.b).toBeUndefined()
  })

  it("seeds benchmarkCapabilityMap baseline for known agents missing one", () => {
    const persisted = {
      agents: {
        a: baseAgent({ id: "a" }),
      },
      // no benchmarkCapabilityMap on purpose
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.benchmarkCapabilityMap.a.length).toBeGreaterThan(0)
  })

  it("preserves an existing benchmarkCapabilityMap entry when present", () => {
    const seed = [{ id: "kept", title: "kept" }] as never
    const persisted = {
      agents: {
        a: baseAgent({ id: "a" }),
      },
      benchmarkCapabilityMap: { a: seed },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.benchmarkCapabilityMap.a).toBe(seed)
  })

  it("normalizes agentValidity snapshots, falling back to acp protocol when agent is missing", () => {
    const snapshot: ExternalAgentValiditySnapshot = {
      executable: true,
      checkedAt: new Date(),
      source: "config",
      sessionExtensions: {
        "session/list": { state: "unknown" },
        "session/fork": { state: "unknown" },
        "session/resume": { state: "unknown" },
      },
    } as never
    const persisted = {
      agents: {
        a: baseAgent({ id: "a", protocol: "acp" }),
      },
      agentValidity: {
        a: snapshot,
        ghost: snapshot,
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.agentValidity.a).toBeDefined()
    expect(out.agentValidity.ghost).toBeDefined()
  })

  it("skips falsy agentValidity entries", () => {
    const persisted = {
      agents: {
        a: baseAgent({ id: "a" }),
      },
      agentValidity: {
        a: {
          executable: true,
          checkedAt: new Date(),
          source: "config",
          sessionExtensions: {
            "session/list": { state: "unknown" },
            "session/fork": { state: "unknown" },
            "session/resume": { state: "unknown" },
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        b: null as any,
      },
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.agentValidity.a).toBeDefined()
    expect(out.agentValidity.b).toBeUndefined()
  })

  it("preserves a previously-set chatFailurePolicy", () => {
    const persisted = {
      chatFailurePolicy: "strict",
    }
    const out = persistOptions.migrate(persisted, 1) as ExternalAgentStore
    expect(out.chatFailurePolicy).toBe("strict")
  })
})

describe("persist.partialize", () => {
  it("only keeps the durable subset of state", () => {
    const state = useExternalAgentStore.getState()
    const out = persistOptions.partialize(state) as Record<string, unknown>
    expect(Object.keys(out).sort()).toEqual(
      [
        "activeAgentId",
        "agentValidity",
        "agents",
        "autoConnectOnStartup",
        "benchmarkCapabilityMap",
        "chatFailurePolicy",
        "defaultPermissionMode",
        "delegationRules",
        "enabled",
        "lastRunSnapshots",
        "showConnectionNotifications",
      ].sort()
    )
    // None of the runtime-only buckets should leak through:
    expect(out).not.toHaveProperty("runningAgents")
    expect(out).not.toHaveProperty("terminals")
    expect(out).not.toHaveProperty("isLoading")
    expect(out).not.toHaveProperty("lastError")
  })
})
