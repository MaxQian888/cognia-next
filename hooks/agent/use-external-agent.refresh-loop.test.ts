/**
 * @jest-environment jsdom
 *
 * Regression: `refresh()` ⇄ store-subscriber infinite loop.
 *
 * `useExternalAgent` subscribes to the store and calls `refresh()` whenever
 * `agents`/`connectionStatus`/`agentValidity`/`lastRunSnapshots` change, while
 * `refresh()` projects the manager's runtime state back into those same fields.
 * That projection must be IDEMPOTENT — re-projecting an unchanged runtime has to
 * leave the store untouched, otherwise every write re-triggers the subscriber
 * which re-runs refresh, forever.
 *
 * The loop is async (refresh is a promise chain), so it starves the microtask
 * queue: timers never fire, the realm-lifetime heartbeat stops, and the Rust
 * webview watchdog declares the page dead and reloads it. Each turn also drives
 * a zustand-persist `JSON.stringify` + `localStorage.setItem` of the whole
 * store, which is what pinned a real session at 95% CPU / 42GB.
 *
 * The main `use-external-agent.test.ts` stubs `subscribe` to a no-op, so it
 * structurally cannot observe this. Here `subscribe` really notifies.
 */
import { act, renderHook } from "@testing-library/react"

// Any namespace, not just `agent`. The import graph this test pulls in takes
// loggers at module scope under other names (`lib/db/mcp-servers` calls
// `loggers.mcp.child(...)`), and one the mock does not name throws before the
// module it belongs to has finished loading.
jest.mock("@cognia/logging", () => {
  const makeLogger = (): Record<string, unknown> => {
    const logger: Record<string, unknown> = {
      error: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      child: () => logger,
    }
    return logger
  }
  return {
    loggers: new Proxy({}, { get: () => makeLogger() }),
    createLogger: () => makeLogger(),
  }
})

jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchExternalAgentConnect: jest.fn(),
    dispatchExternalAgentDisconnect: jest.fn(),
    dispatchExternalAgentExecutionStart: jest.fn(),
    dispatchExternalAgentExecutionComplete: jest.fn(),
    dispatchExternalAgentError: jest.fn(),
  }),
}))

jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  normalizeExternalAgentConfigInput: (c: unknown) => c,
  isExternalAgentExecutable: () => true,
  getExternalAgentExecutionBlockReason: () => null,
  getExternalAgentExecutionBlock: () => null,
}))

jest.mock("@/lib/ai/agent/external/session-extension-errors", () => ({
  isExternalAgentSessionExtensionUnsupportedForMethod: () => false,
}))

// Real-ish normalizer: returns a NEW object each call (the production one does),
// preserving checkedAt. This is what makes an identity-based store write loop.
jest.mock("@/lib/ai/agent/external/canonical-contract", () => ({
  normalizeExternalAgentValiditySnapshot: (snap: Record<string, unknown>) => ({
    ...snap,
    checkedAt: snap.checkedAt,
    normalized: true,
  }),
}))

/** Hard stop so a regressed build fails an assertion instead of OOM-ing. */
const LOOP_GUARD = 100

const AGENT_ID = "agent-1"
const CONFIG = { id: AGENT_ID, name: "Codex", protocol: "acp" }
// One stable validity object, exactly as the manager holds it between updates.
const RUNTIME_VALIDITY = {
  executable: true,
  source: "connect",
  checkedAt: new Date("2026-07-15T12:04:54.000Z"),
}

interface State {
  agents: Record<string, unknown>
  connectionStatus: Record<string, string>
  agentValidity: Record<string, unknown>
  lastRunSnapshots: Record<string, unknown>
  benchmarkCapabilities: Record<string, unknown[]>
  activeAgentId: string | null
  defaultPermissionMode: string
}

let state: State
let listeners: Array<(s: State, p: State) => void>
let setStateCalls = 0

// Action/selector identities must be STABLE across getState() calls, exactly as
// the real zustand slice is (it builds them once at store creation). Minting new
// closures per call would destabilise `refresh`'s useCallback deps and create a
// loop in the harness rather than exercising the production one.
const actions = {
  addAgent: jest.fn(),
  removeAgent: jest.fn(),
  setConnectionStatus: jest.fn(),
  setAgentValidity: jest.fn(),
  getAgent: (id: string) => state.agents[id],
  getAllAgents: () => Object.values(state.agents),
  getConnectionStatus: (id: string) => state.connectionStatus[id] ?? "disconnected",
  getAgentValidity: (id: string) => state.agentValidity[id],
  getLastRunSnapshot: (id: string) => state.lastRunSnapshots[id],
  setLastRunSnapshot: jest.fn(),
  getBenchmarkCapabilities: (id: string) => state.benchmarkCapabilities[id] ?? [],
  setActiveAgent: jest.fn(),
}

function getState() {
  return { ...state, ...actions }
}

jest.mock("@/stores/agent/external-agent-store", () => {
  const fn = <T>(selector: (s: ReturnType<typeof getState>) => T): T => selector(getState())
  const store = fn as unknown as Record<string, unknown>
  store.getState = () => getState()
  // A real zustand-like setState: merges, then notifies subscribers with
  // (next, previous) — the edge the production subscriber reacts to.
  store.setState = (updater: unknown) => {
    setStateCalls++
    // Without this the regression reproduces so faithfully that it OOMs the
    // Jest worker (as it did the real renderer) instead of failing an
    // assertion. Stop feeding the cycle past the guard so the count below
    // reports the defect cleanly.
    if (setStateCalls > LOOP_GUARD) return
    const previous = state
    const partial =
      typeof updater === "function" ? (updater as (s: State) => object)(state) : updater
    state = { ...state, ...(partial as object) } as State
    for (const listener of [...listeners]) listener(state, previous)
  }
  store.subscribe = (listener: (s: State, p: State) => void) => {
    listeners.push(listener)
    return () => {
      listeners = listeners.filter((l) => l !== listener)
    }
  }
  return { useExternalAgentStore: fn }
})

const fakeManager = {
  getAllAgents: jest.fn(() => [
    {
      config: CONFIG,
      connectionStatus: "connected",
      status: "idle",
      sessions: new Map(),
      validity: RUNTIME_VALIDITY,
      connectionAttempts: 0,
      stats: {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        totalTokensUsed: 0,
        averageResponseTime: 0,
      },
    },
  ]),
  getAgent: jest.fn(),
  addAgent: jest.fn(),
  removeAgent: jest.fn(async () => undefined),
  connect: jest.fn(async () => undefined),
  disconnect: jest.fn(async () => undefined),
  addLifecycleListener: jest.fn(() => () => undefined),
  addEventListener: jest.fn(() => () => undefined),
  getSession: jest.fn(),
  listSessions: jest.fn(async () => []),
}

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => fakeManager,
}))

beforeEach(() => {
  listeners = []
  setStateCalls = 0
  state = {
    agents: { [AGENT_ID]: CONFIG },
    // Store already agrees with the manager: connected, and holding a validity.
    connectionStatus: { [AGENT_ID]: "connected" },
    agentValidity: {},
    lastRunSnapshots: {},
    benchmarkCapabilities: {},
    activeAgentId: null,
    defaultPermissionMode: "default",
  }
})

async function flush() {
  // Let the refresh promise chain settle. A converging projection goes quiet
  // after a couple of turns; a looping one keeps scheduling more microtasks.
  await act(async () => {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  })
}

describe("useExternalAgent refresh/store projection converges", () => {
  it("stops writing to the store once the runtime state is already projected", async () => {
    const { useExternalAgent } = await import("./use-external-agent")
    renderHook(() => useExternalAgent())

    await flush()
    const afterInitial = setStateCalls

    // Nothing about the manager changed. Any further writes are the projection
    // re-triggering itself — the freeze.
    await flush()
    const afterIdle = setStateCalls - afterInitial

    expect(afterIdle).toBe(0)
    // The initial projection itself must also converge, not run away.
    expect(afterInitial).toBeLessThanOrEqual(3)
  })
})
