/** @jest-environment jsdom */
import { act, render } from "@testing-library/react"

import type { FleetSession, FleetSnapshot } from "@/lib/fleet/types"
import type { IslandActionIntent, IslandDetailRequest, IslandState } from "@/lib/island/types"

const pushMock = jest.fn<Promise<boolean>, [IslandState]>(async (_state: IslandState) => true)
const actionResultMock = jest.fn(async () => true)
const detailResponseMock = jest.fn(async () => true)
let onStateRequest: () => void = () => {}
let onActionIntent: (intent: IslandActionIntent) => void = () => {}
let onDetailRequest: (request: IslandDetailRequest) => void = () => {}

jest.mock("@/lib/island/client", () => ({
  sendIslandState: (state: IslandState) => pushMock(state),
  sendIslandActionResult: (...a: unknown[]) => actionResultMock(...(a as [])),
  sendIslandDetailResponse: (...a: unknown[]) => detailResponseMock(...(a as [])),
  onIslandStateRequest: async (handler: () => void) => {
    onStateRequest = handler
    return () => {}
  },
  onIslandActionIntent: async (handler: (intent: IslandActionIntent) => void) => {
    onActionIntent = handler
    return () => {}
  },
  onIslandDetailRequest: async (handler: (request: IslandDetailRequest) => void) => {
    onDetailRequest = handler
    return () => {}
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

jest.mock("@/lib/tauri", () => ({ isTauri: () => true }))
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }))

const fleet: { current: FleetSnapshot } = { current: { sessions: [], generatedAt: 0 } }
jest.mock("@/lib/fleet/unified-fleet-store", () => ({
  unifiedFleetStore: {
    subscribe: () => () => {},
    getSnapshot: () => fleet.current,
    getServerSnapshot: () => fleet.current,
  },
}))
// `useSyncExternalStore` requires a cached snapshot, so the empty list is a
// single frozen instance rather than a fresh array per call.
const NO_ATTENTION = Object.freeze([])
jest.mock("@/lib/attention/attention-store", () => ({
  subscribeAttention: () => () => {},
  getAttentionSnapshot: () => NO_ATTENTION,
  getAttentionServerSnapshot: () => NO_ATTENTION,
}))
jest.mock("@/stores/chat/chat-store", () => ({ useChatStore: { getState: () => ({}) } }))
jest.mock("@/stores/agent/pending-gates-store", () => ({
  usePendingGatesStore: { getState: () => ({ gates: [] }) },
}))

const hydrate = jest.fn(async () => {})
jest.mock("@/lib/island/store", () => ({
  useIslandStore: (selector: (s: unknown) => unknown) =>
    selector({
      hydrate,
      hydrated: true,
      preferences: { detailVisibility: "click-to-reveal" },
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
  fleet.current = { sessions: [session()], generatedAt: 1 }
})

async function mount() {
  render(<IslandInitializer />)
  await act(async () => {})
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
