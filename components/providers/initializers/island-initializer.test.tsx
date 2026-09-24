/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"

import type { FleetSession, FleetSnapshot } from "@/lib/fleet/types"
import type {
  IslandActionIntent,
  IslandDetailRequest,
  IslandDetailVisibility,
  IslandState,
} from "@/lib/island/types"
import type { IslandActionDeps } from "@/lib/island/actions"
import type { AttentionItem } from "@/lib/attention/types"
import type { PendingGate } from "@/stores/agent/pending-gates-store"

const pushMock = jest.fn<Promise<boolean>, [IslandState]>(async (_state: IslandState) => true)
const actionResultMock = jest.fn(async () => true)
const detailResponseMock = jest.fn(async () => true)
let onStateRequest: () => void = () => {}
let onActionIntent: (intent: IslandActionIntent) => void = () => {}
let onDetailRequest: (request: IslandDetailRequest) => void = () => {}
const stateOff = jest.fn()
const actionOff = jest.fn()
const detailOff = jest.fn()
const listeners = { delayed: false, complete: [] as Array<() => void> }

function registerListener(off: () => void): Promise<() => void> {
  return listeners.delayed
    ? new Promise((resolve) => listeners.complete.push(() => resolve(off)))
    : Promise.resolve(off)
}

jest.mock("@/lib/island/client", () => ({
  sendIslandState: (state: IslandState) => pushMock(state),
  sendIslandActionResult: (...a: unknown[]) => actionResultMock(...(a as [])),
  sendIslandDetailResponse: (...a: unknown[]) => detailResponseMock(...(a as [])),
  onIslandStateRequest: async (handler: () => void) => {
    onStateRequest = handler
    return registerListener(stateOff)
  },
  onIslandActionIntent: async (handler: (intent: IslandActionIntent) => void) => {
    onActionIntent = handler
    return registerListener(actionOff)
  },
  onIslandDetailRequest: async (handler: (request: IslandDetailRequest) => void) => {
    onDetailRequest = handler
    return registerListener(detailOff)
  },
}))

const executeMock = jest.fn(async () => ({
  requestId: "req",
  revision: 1,
  outcome: "completed" as const,
}))
jest.mock("@/lib/island/actions", () => ({
  executeIslandAction: (...a: unknown[]) => executeMock(...(a as [])),
}))

const environment = {
  tauri: true,
  hydrated: true,
  detailVisibility: "click-to-reveal" as IslandDetailVisibility,
}
jest.mock("@/lib/tauri", () => ({ isTauri: () => environment.tauri }))
const showWindowMock = jest.fn()
const focusWindowMock = jest.fn()
const getWindowMock = jest.fn()
jest.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => getWindowMock() }))
const expireInterruptMock = jest.fn()
jest.mock("@/lib/execution/run-control", () => ({
  expireRunInterruptFromSource: (...args: unknown[]) => expireInterruptMock(...args),
}))
const navigateMock = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: navigateMock }) }))

const fleet: { current: FleetSnapshot } = { current: { sessions: [], generatedAt: 0 } }
jest.mock("@/lib/fleet/unified-fleet-store", () => ({
  unifiedFleetStore: {
    subscribe: () => () => {},
    getSnapshot: () => fleet.current,
    getServerSnapshot: () => fleet.current,
  },
}))
// `useSyncExternalStore` requires a cached snapshot rather than a fresh array per call.
const attention: { current: AttentionItem[] } = { current: [] }
jest.mock("@/lib/attention/attention-store", () => ({
  subscribeAttention: () => () => {},
  getAttentionSnapshot: () => attention.current,
  getAttentionServerSnapshot: () => attention.current,
}))
const setActiveSessionMock = jest.fn()
const setSelectedGuildMock = jest.fn()
const clearApprovalMock = jest.fn()
const selectExternalAgentMock = jest.fn()
jest.mock("@/lib/agent/external-agent-selection", () => ({
  selectExternalAgent: (...args: unknown[]) => selectExternalAgentMock(...args),
}))
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: {
    getState: () => ({ setActiveSession: setActiveSessionMock, clearApproval: clearApprovalMock }),
  },
}))
jest.mock("@/stores/ui/ui-store", () => ({
  useUIStore: { getState: () => ({ setSelectedGuild: setSelectedGuildMock }) },
}))
const gates: { current: PendingGate[] } = { current: [] }
const closeGateMock = jest.fn()
jest.mock("@/stores/agent/pending-gates-store", () => ({
  usePendingGatesStore: { getState: () => ({ gates: gates.current, close: closeGateMock }) },
}))

const hydrate = jest.fn(async () => {})
jest.mock("@/lib/island/store", () => ({
  useIslandStore: (selector: (s: unknown) => unknown) =>
    selector({
      hydrate,
      hydrated: environment.hydrated,
      preferences: { detailVisibility: environment.detailVisibility },
    }),
}))

import { IslandInitializer } from "./island-initializer"

function session(overrides: Partial<FleetSession> = {}): FleetSession {
  return {
    agent: "opencode",
    sessionId: "oc",
    status: "working",
    cwd: "/w",
    projectName: "proj",
    lastPrompt: "hello",
    activity: null,
    permissionMode: null,
    model: null,
    terminal: null,
    transcriptPath: null,
    agentPid: null,
    pendingPermission: null,
    capabilities: {
      approvePermission: false,
      sendMessage: false,
      focusTerminal: false,
      openTranscript: false,
      interrupt: false,
    },
    startedAt: 1,
    lastEventAt: 2,
    toolUseCount: 0,
    turnCount: 0,
    ...overrides,
  }
}

beforeEach(() => {
  pushMock.mockClear()
  actionResultMock.mockClear()
  detailResponseMock.mockClear()
  executeMock.mockClear()
  navigateMock.mockClear()
  setActiveSessionMock.mockClear()
  setSelectedGuildMock.mockClear()
  selectExternalAgentMock.mockClear()
  closeGateMock.mockClear()
  clearApprovalMock.mockClear()
  showWindowMock.mockReset().mockResolvedValue(undefined)
  focusWindowMock.mockReset().mockResolvedValue(undefined)
  getWindowMock.mockReset().mockReturnValue({ show: showWindowMock, setFocus: focusWindowMock })
  expireInterruptMock.mockReset().mockResolvedValue(undefined)
  stateOff.mockClear()
  actionOff.mockClear()
  detailOff.mockClear()
  listeners.delayed = false
  listeners.complete = []
  environment.tauri = true
  environment.hydrated = true
  environment.detailVisibility = "click-to-reveal"
  gates.current = []
  attention.current = []
  fleet.current = { sessions: [session()], generatedAt: 1 }
})

async function mount() {
  const view = render(<IslandInitializer />)
  await act(async () => {})
  return view
}

async function mountWithDeps() {
  const view = await mount()
  const state = pushMock.mock.calls.at(-1)![0]
  const row = state.rows[0]
  await act(async () =>
    onActionIntent({
      kind: "open-owner",
      requestId: "req",
      revision: state.revision,
      rowId: row.id,
    })
  )
  return { view, state, row, deps: (executeMock.mock.calls[0] as unknown[])[2] as IslandActionDeps }
}

it("pushes a projection with a rising revision", async () => {
  await mount()
  const first = pushMock.mock.calls.at(-1)?.[0] as unknown as IslandState
  expect(first.rows).toHaveLength(1)
  expect(first.revision).toBeGreaterThan(0)
})

it("re-seeds an island that just mounted and asked", async () => {
  await mount()
  pushMock.mockClear()
  await act(async () => onStateRequest())
  expect(pushMock).toHaveBeenCalledTimes(1)
})

it("hands an intent to the executor with its CURRENT projection", async () => {
  await mount()
  const state = pushMock.mock.calls.at(-1)?.[0] as unknown as IslandState
  await act(async () =>
    onActionIntent({
      kind: "interrupt",
      requestId: "req",
      revision: state.revision,
      rowId: state.rows[0].id,
    })
  )
  expect(executeMock).toHaveBeenCalled()
  expect((executeMock.mock.calls[0] as unknown[])[1]).toMatchObject({ revision: state.revision })
  expect(actionResultMock).toHaveBeenCalledWith(expect.objectContaining({ outcome: "completed" }))
})

it("selects the owning chat and DM surface before navigating home", async () => {
  await mount()
  await act(async () =>
    onActionIntent({ kind: "open-owner", requestId: "req", revision: 1, rowId: "chat:chat-b" })
  )
  const deps = (executeMock.mock.calls[0] as unknown[])[2] as IslandActionDeps
  deps.navigate("/", { kind: "chat", sessionId: "chat-b" })

  expect(setActiveSessionMock).toHaveBeenCalledWith("chat-b")
  expect(setSelectedGuildMock).toHaveBeenCalledWith({ kind: "dm" })
  expect(navigateMock).toHaveBeenCalledWith("/")
  expect(setActiveSessionMock.mock.invocationCallOrder[0]).toBeLessThan(
    navigateMock.mock.invocationCallOrder[0]
  )
  expect(setSelectedGuildMock.mock.invocationCallOrder[0]).toBeLessThan(
    navigateMock.mock.invocationCallOrder[0]
  )
})

it("preserves the selected chat when opening a run", async () => {
  await mount()
  await act(async () =>
    onActionIntent({ kind: "open-owner", requestId: "req", revision: 1, rowId: "run:run-b" })
  )
  const deps = (executeMock.mock.calls[0] as unknown[])[2] as IslandActionDeps
  deps.navigate("/agent-runs?run=run-b", { kind: "run", runId: "run-b" })

  expect(navigateMock).toHaveBeenCalledWith("/agent-runs?run=run-b")
  expect(setActiveSessionMock).not.toHaveBeenCalled()
  expect(setSelectedGuildMock).not.toHaveBeenCalled()
})

it("opens an ACP session's bound chat and selects its agent", async () => {
  await mount()
  await act(async () =>
    onActionIntent({
      kind: "open-owner",
      requestId: "req",
      revision: 1,
      rowId: "external:devin:ext-1",
    })
  )
  const deps = (executeMock.mock.calls[0] as unknown[])[2] as IslandActionDeps
  deps.navigate("/", {
    kind: "external",
    agent: "devin",
    sessionId: "ext-1",
    agentId: "agent-1",
    chatSessionId: "chat-9",
  })

  expect(setActiveSessionMock).toHaveBeenCalledWith("chat-9")
  expect(setSelectedGuildMock).toHaveBeenCalledWith({ kind: "dm" })
  expect(selectExternalAgentMock).toHaveBeenCalledWith("agent-1")
  expect(navigateMock).toHaveBeenCalledWith("/")
})

it("selects the agent without touching chat for an unbound ACP session", async () => {
  await mount()
  await act(async () =>
    onActionIntent({
      kind: "open-owner",
      requestId: "req",
      revision: 1,
      rowId: "external:acp:ext-2",
    })
  )
  const deps = (executeMock.mock.calls[0] as unknown[])[2] as IslandActionDeps
  deps.navigate("/me/external-agents", {
    kind: "external",
    agent: "acp",
    sessionId: "ext-2",
    agentId: "agent-2",
  })

  expect(navigateMock).toHaveBeenCalledWith("/me/external-agents")
  expect(selectExternalAgentMock).toHaveBeenCalledWith("agent-2")
  expect(setActiveSessionMock).not.toHaveBeenCalled()
  expect(setSelectedGuildMock).not.toHaveBeenCalled()
})

describe("non-Squad approval gates", () => {
  function gate(overrides: Partial<PendingGate> = {}): PendingGate {
    return {
      key: { scope: "agent-plan", id: "step-a" },
      gateType: "plan_step",
      title: "Review plan",
      body: "Approve the next step",
      sessionId: "chat-b",
      openedAt: 1,
      status: "interrupted",
      ...overrides,
    }
  }

  async function mountGate(pending: PendingGate) {
    gates.current = [pending]
    attention.current = [
      {
        id: `team:${pending.key.scope}:${pending.key.id}`,
        source: "team",
        kind: "hitl-gate",
        title: pending.title,
        detail: pending.body,
        openedAt: pending.openedAt,
        stale: pending.status === "interrupted",
        gate: pending,
      },
    ]
    await mount()
    const state = pushMock.mock.calls.at(-1)![0]
    const row = state.rows.find((candidate) => candidate.source === "gate")!
    await act(async () =>
      onActionIntent({
        kind: "open-owner",
        requestId: "req",
        revision: state.revision,
        rowId: row.id,
      })
    )
    const deps = (executeMock.mock.calls[0] as unknown[])[2] as IslandActionDeps
    return { row, deps, state }
  }

  it.each([undefined, "chat-b"])(
    "opens a gate with session %s in the main window",
    async (sessionId) => {
      const { row, deps } = await mountGate(gate({ sessionId, status: "open" }))
      deps.navigate("/", row.owner)
      expect(navigateMock).toHaveBeenCalledWith("/")
      if (sessionId) {
        expect(setActiveSessionMock).toHaveBeenCalledWith(sessionId)
        expect(setSelectedGuildMock).toHaveBeenCalledWith({ kind: "dm" })
      } else {
        expect(setActiveSessionMock).not.toHaveBeenCalled()
      }
    }
  )

  it("dismisses only the exact interrupted gate, excluding same-id gates in another scope", async () => {
    const pending = gate()
    const { row, deps } = await mountGate(pending)
    gates.current = [gate({ key: { scope: "cost-budget", id: "step-a" } }), pending]
    expect(await deps.dismissStale(row)).toBe(true)
    expect(closeGateMock).toHaveBeenCalledTimes(1)
    expect(closeGateMock).toHaveBeenCalledWith(pending.key)
  })

  it("refuses a stale dismissal after the same gate has reopened", async () => {
    const { row, deps } = await mountGate(gate())
    gates.current = [gate({ status: "open", openedAt: 2 })]
    expect(await deps.dismissStale(row)).toBe(false)
    expect(closeGateMock).not.toHaveBeenCalled()
  })

  it("refuses dismissal when the gate is gone or the row is live", async () => {
    const { row, deps } = await mountGate(gate())
    gates.current = []
    expect(await deps.dismissStale(row)).toBe(false)
    gates.current = [gate()]
    expect(await deps.dismissStale({ ...row, stale: false })).toBe(false)
    expect(closeGateMock).not.toHaveBeenCalled()
  })

  it("answers detail from the pending gate behind the projected row", async () => {
    const { row, state } = await mountGate(gate({ status: "open" }))
    await act(async () =>
      onDetailRequest({
        requestId: "gate-detail",
        rowId: row.id,
        revision: state.revision,
      })
    )
    expect(detailResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "gate-detail",
        rowId: row.id,
        detail: expect.objectContaining({ prompt: "Approve the next step" }),
      })
    )
  })
})

it("reports a failure rather than going silent when the executor throws", async () => {
  executeMock.mockRejectedValueOnce(new Error("boom"))
  await mount()
  const state = pushMock.mock.calls.at(-1)?.[0] as unknown as IslandState
  await act(async () =>
    onActionIntent({
      kind: "interrupt",
      requestId: "req",
      revision: state.revision,
      rowId: state.rows[0].id,
    })
  )
  expect(actionResultMock).toHaveBeenCalledWith(
    expect.objectContaining({ outcome: "failed", reason: "callFailed" })
  )
})

it("answers a detail request from the live session", async () => {
  await mount()
  const state = pushMock.mock.calls.at(-1)?.[0] as unknown as IslandState
  await act(async () =>
    onDetailRequest({ requestId: "d1", revision: state.revision, rowId: state.rows[0].id })
  )
  expect(detailResponseMock).toHaveBeenCalledWith(
    expect.objectContaining({
      requestId: "d1",
      rowId: state.rows[0].id,
      detail: expect.objectContaining({ cwd: "/w", prompt: "hello" }),
    })
  )
})

it("refuses a detail request for a row that is not listed", async () => {
  await mount()
  const state = pushMock.mock.calls.at(-1)?.[0] as unknown as IslandState
  await act(async () =>
    onDetailRequest({ requestId: "d1", revision: state.revision, rowId: "nope" })
  )
  expect(detailResponseMock).toHaveBeenCalledWith(
    expect.objectContaining({ detail: null, reason: "unknownRow" })
  )
})

it("refuses a detail request built against a revision it has not reached", async () => {
  await mount()
  await act(async () => onDetailRequest({ requestId: "d1", revision: 9_999, rowId: "x" }))
  expect(detailResponseMock).toHaveBeenCalledWith(
    expect.objectContaining({ detail: null, reason: "staleRevision" })
  )
})

describe("main-window lifecycle", () => {
  it("waits for hydration before answering requests and then publishes a usable projection", async () => {
    environment.hydrated = false
    const view = await mount()
    await act(async () => {
      onStateRequest()
      onActionIntent({ kind: "open-owner", requestId: "early", revision: 0, rowId: "row" })
      onDetailRequest({ requestId: "early-detail", revision: 0, rowId: "row" })
    })
    expect(pushMock).not.toHaveBeenCalled()
    expect(executeMock).not.toHaveBeenCalled()
    expect(actionResultMock).toHaveBeenCalledWith({
      requestId: "early",
      revision: 0,
      outcome: "rejected",
      reason: "staleRevision",
    })
    expect(detailResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "early-detail",
        revision: 0,
        detail: null,
        reason: "unavailable",
      })
    )
    environment.hydrated = true
    view.rerender(<IslandInitializer />)
    await act(async () => {})
    expect(pushMock).toHaveBeenCalledWith(expect.objectContaining({ rows: [expect.any(Object)] }))
  })

  it("never publishes desktop state in a browser runtime", async () => {
    environment.tauri = false
    await mount()
    expect(pushMock).not.toHaveBeenCalled()
    expect(getWindowMock).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    "disposes registered or delayed listeners after unmount (delayed=%s)",
    async (delayed) => {
      listeners.delayed = delayed
      const view = await mount()
      view.unmount()
      await act(async () => listeners.complete.forEach((complete) => complete()))
      expect(stateOff).toHaveBeenCalledTimes(1)
      expect(actionOff).toHaveBeenCalledTimes(1)
      expect(detailOff).toHaveBeenCalledTimes(1)

      pushMock.mockClear()
      await act(async () => {
        onStateRequest()
        onActionIntent({ kind: "open-owner", requestId: "late", revision: 1, rowId: "row" })
        onDetailRequest({ requestId: "late-detail", revision: 1, rowId: "row" })
      })
      expect(pushMock).not.toHaveBeenCalled()
      expect(executeMock).not.toHaveBeenCalled()
      expect(detailResponseMock).not.toHaveBeenCalled()
    }
  )

  it("shows the main window before giving it keyboard focus", async () => {
    const { deps } = await mountWithDeps()
    await deps.focusMainWindow!()
    expect(showWindowMock).toHaveBeenCalledTimes(1)
    expect(focusWindowMock).toHaveBeenCalledTimes(1)
    expect(showWindowMock.mock.invocationCallOrder[0]).toBeLessThan(
      focusWindowMock.mock.invocationCallOrder[0]
    )
  })

  it("keeps owner navigation successful when native focusing fails", async () => {
    const { deps } = await mountWithDeps()
    showWindowMock.mockRejectedValueOnce(new Error("window unavailable"))
    deps.navigate("/", { kind: "chat", sessionId: "chat-b" })
    await expect(deps.focusMainWindow!()).resolves.toBeUndefined()
    expect(navigateMock).toHaveBeenCalledWith("/")
    expect(focusWindowMock).not.toHaveBeenCalled()
    environment.tauri = false
    await deps.focusMainWindow!()
    expect(getWindowMock).toHaveBeenCalledTimes(1)
  })

  it("rejects detail requests under the summary-only privacy preference", async () => {
    environment.detailVisibility = "summary-only"
    await mount()
    const state = pushMock.mock.calls.at(-1)![0]
    await act(async () =>
      onDetailRequest({
        requestId: "private-detail",
        revision: state.revision,
        rowId: state.rows[0].id,
      })
    )
    expect(detailResponseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "private-detail",
        detail: null,
        reason: "notPermitted",
      })
    )
  })

  it("refreshes the epoch-local revision and executes against the newest session data", async () => {
    const { view, state } = await mountWithDeps()
    fleet.current = {
      sessions: [session({ status: "waiting-input", lastEventAt: 3 })],
      generatedAt: 3,
    }
    view.rerender(<IslandInitializer />)
    await act(async () => {})
    const updated = pushMock.mock.calls.at(-1)![0]
    expect(updated.epoch).toBe(state.epoch)
    expect(updated.revision).toBeGreaterThan(state.revision)
    await act(async () =>
      onActionIntent({
        kind: "open-owner",
        requestId: "new",
        revision: updated.revision,
        rowId: updated.rows[0].id,
      })
    )
    expect((executeMock.mock.calls.at(-1) as unknown[])[1]).toBe(updated)
  })
})

describe("stale clearing adapters", () => {
  it("clears a chat approval in its exact session and refuses one without a request id", async () => {
    const { row, deps } = await mountWithDeps()
    expect(
      await deps.dismissStale({
        ...row,
        owner: { kind: "chat", sessionId: "chat-b", requestId: "approval-b" },
        stale: true,
      })
    ).toBe(true)
    expect(clearApprovalMock).toHaveBeenCalledWith("approval-b", "chat-b")
    expect(await deps.dismissStale({ ...row, owner: { kind: "chat", sessionId: "chat-b" } })).toBe(
      false
    )
    expect(await deps.dismissStale(row)).toBe(false)
  })

  it.each([{ teamId: "team-b", runId: "run-b" }, { teamId: "team-b" }, { runId: "run-b" }])(
    "clears the matching legacy team gate for %j",
    async (ownerIds) => {
      const { row, deps } = await mountWithDeps()
      const target: PendingGate = {
        key: { scope: "legacy-team", id: "gate-b" },
        gateType: "budget",
        title: "Review budget",
        status: "interrupted",
        openedAt: 1,
        teamId: "team-b",
        runId: "run-b",
      }
      gates.current = [{ ...target, teamId: "different", runId: "different" }, target]
      const teamRow = { ...row, owner: { kind: "team" as const, ...ownerIds }, stale: true }
      expect(await deps.dismissStale(teamRow)).toBe(true)
      expect(closeGateMock).toHaveBeenCalledWith(target.key)
      gates.current = []
      expect(await deps.dismissStale(teamRow)).toBe(false)
      expect(closeGateMock).toHaveBeenCalledTimes(1)
    }
  )

  it("expires the exact durable interrupt and propagates a source failure", async () => {
    const { row, deps } = await mountWithDeps()
    const runRow = {
      ...row,
      owner: { kind: "run" as const, runId: "run-b", interruptId: "interrupt-b" },
    }
    expect(await deps.dismissStale(runRow)).toBe(true)
    expect(expireInterruptMock).toHaveBeenCalledWith("run-b", "interrupt-b")
    expireInterruptMock.mockRejectedValueOnce(new Error("source unavailable"))
    await expect(deps.dismissStale(runRow)).rejects.toThrow("source unavailable")
    expect(await deps.dismissStale({ ...row, owner: { kind: "run", runId: "run-b" } })).toBe(false)
  })
})
