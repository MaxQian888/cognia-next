/** @jest-environment jsdom */
import {
  diffExternalAgentState,
  subscribeExternalAgentChanges,
  type ExternalAgentChangeEvent,
  type ExternalAgentChangeSnapshot,
} from "./external-agents-changes"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

const NO_RULES: ExternalAgentChangeSnapshot["delegationRules"] = []

function snapshot(
  overrides: Partial<ExternalAgentChangeSnapshot> = {}
): ExternalAgentChangeSnapshot {
  return {
    agents: {},
    connectionStatus: {},
    delegationRules: NO_RULES,
    enabled: true,
    defaultPermissionMode: "default",
    autoConnectOnStartup: false,
    showConnectionNotifications: true,
    chatFailurePolicy: "fallback",
    ...overrides,
  }
}

const record = (id: string) =>
  ({ id, name: id }) as unknown as ExternalAgentChangeSnapshot["agents"][string]

describe("diffExternalAgentState", () => {
  it("reports nothing for identical state", () => {
    const state = snapshot({ agents: { a: record("a") } })
    expect(diffExternalAgentState(state, state)).toEqual([])
  })

  it("reports adds, updates by identity and removals", () => {
    const kept = record("kept")
    const previous = snapshot({
      agents: { kept, changed: record("changed"), gone: record("gone") },
    })
    const next = snapshot({ agents: { kept, changed: record("changed"), fresh: record("fresh") } })
    expect(diffExternalAgentState(previous, next)).toEqual([
      { type: "config-updated", agentId: "changed" },
      { type: "config-added", agentId: "fresh" },
      { type: "config-removed", agentId: "gone" },
    ])
  })

  it("reports connection changes only for agents present on both sides", () => {
    const a = record("a")
    const previous = snapshot({ agents: { a }, connectionStatus: { a: "disconnected" } })
    const next = snapshot({
      agents: { a, b: record("b") },
      connectionStatus: { a: "connected", b: "disconnected" },
    })
    expect(diffExternalAgentState(previous, next)).toEqual([
      { type: "config-added", agentId: "b" },
      { type: "connection-changed", agentId: "a" },
    ])
  })

  it.each([
    ["enabled", false],
    ["defaultPermissionMode", "plan"],
    ["autoConnectOnStartup", true],
    ["showConnectionNotifications", false],
    ["chatFailurePolicy", "strict"],
  ] as const)("reports a settings change for %s", (key, value) => {
    expect(diffExternalAgentState(snapshot(), snapshot({ [key]: value }))).toEqual([
      { type: "settings-changed" },
    ])
  })

  it("reports a delegation change when the rule list is replaced", () => {
    expect(diffExternalAgentState(snapshot(), snapshot({ delegationRules: [] }))).toEqual([
      { type: "delegation-changed" },
    ])
  })
})

describe("subscribeExternalAgentChanges", () => {
  beforeEach(() => useExternalAgentStore.getState().reset())

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it("delivers store changes outside the store's set, and stops on dispose", async () => {
    const events: ExternalAgentChangeEvent[] = []
    const dispose = subscribeExternalAgentChanges((event) => {
      // Reading the store back from a listener must see the committed state.
      if (event.type === "config-added") {
        expect(useExternalAgentStore.getState().getAgent(event.agentId!)).toBeDefined()
      }
      events.push(event)
    })
    await flush()
    const id = useExternalAgentStore.getState().addAgent({
      name: "A",
      protocol: "acp",
      transport: "stdio",
      process: { command: "a" },
    })
    await flush()
    expect(events).toEqual([{ type: "config-added", agentId: id }])
    dispose()
    useExternalAgentStore.getState().setEnabled(false)
    await flush()
    expect(events).toHaveLength(1)
  })

  it("never subscribes when disposed before the store module loads", async () => {
    const listener = jest.fn()
    const dispose = subscribeExternalAgentChanges(listener)
    dispose()
    await flush()
    useExternalAgentStore.getState().setChatFailurePolicy("strict")
    await flush()
    expect(listener).not.toHaveBeenCalled()
  })

  it("hands a throwing listener's error to onError and keeps going", async () => {
    const onError = jest.fn()
    let calls = 0
    const dispose = subscribeExternalAgentChanges(() => {
      calls += 1
      throw new Error("boom")
    }, onError)
    await flush()
    useExternalAgentStore.getState().setChatFailurePolicy("strict")
    useExternalAgentStore.getState().setAutoConnectOnStartup(true)
    await flush()
    expect(calls).toBe(2)
    expect(onError).toHaveBeenCalledTimes(2)
    dispose()
  })
})
