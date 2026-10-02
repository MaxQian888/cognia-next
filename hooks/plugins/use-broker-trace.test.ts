/**
 * @jest-environment jsdom
 */

import type { CodeServerBrokerTraceEntry } from "@/lib/codeserver/client"

let mockHandler: ((entry: CodeServerBrokerTraceEntry) => void) | undefined
const mockUnlisten = jest.fn()
const mockBrokerTrace = jest.fn<Promise<CodeServerBrokerTraceEntry[]>, []>()
jest.mock("@/lib/codeserver/client", () => ({
  CODESERVER_EVENTS: { brokerTrace: "codeserver://broker-trace" },
  codeServerClient: { brokerTrace: () => mockBrokerTrace() },
}))
jest.mock("@/lib/tauri/events", () => ({
  onTauriEvent: jest.fn(async (_event: string, handler: typeof mockHandler) => {
    mockHandler = handler
    return mockUnlisten
  }),
}))
const mockRendererTraces = jest.fn(() => [] as unknown[])
jest.mock("@/lib/plugin/ide/broker-runtime", () => ({
  getManagedIdeRpcTraces: () => mockRendererTraces(),
}))

import { act, renderHook, waitFor } from "@testing-library/react"
import { onTauriEvent } from "@/lib/tauri/events"

import { BROKER_TRACE_ROWS, useBrokerTrace } from "./use-broker-trace"

const entry = (seq: number, id: string | null = null): CodeServerBrokerTraceEntry => ({
  seq,
  atMs: seq,
  root: "/w",
  generation: 1,
  direction: "inbound",
  kind: "request",
  method: "cognia/provider/invoke",
  id,
  pluginId: "acme",
  bytes: 10,
  durationMs: null,
  errorCode: null,
  payload: null,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockHandler = undefined
  mockRendererTraces.mockReturnValue([])
})

it("shows and listens to nothing while Dev Mode is off", () => {
  const { result } = renderHook(() => useBrokerTrace(false))
  expect(result.current.rows).toEqual([])
  expect(onTauriEvent).not.toHaveBeenCalled()
  expect(mockBrokerTrace).not.toHaveBeenCalled()
})

it("loads what the host recorded, then appends streamed frames once each", async () => {
  mockBrokerTrace.mockResolvedValue([entry(1), entry(2)])
  const { result } = renderHook(() => useBrokerTrace(true))
  await waitFor(() => expect(result.current.rows).toHaveLength(2))
  act(() => {
    mockHandler?.(entry(2))
    mockHandler?.(entry(3))
  })
  expect(result.current.rows.map((row) => row.seq)).toEqual([1, 2, 3])
})

it("marks a request the renderer decided under a simulated permission", async () => {
  mockBrokerTrace.mockResolvedValue([entry(1, "proxy:1"), entry(2, "proxy:2")])
  mockRendererTraces.mockReturnValue([
    { root: "/w", generation: 1, requestId: "proxy:2", simulated: true },
    { root: "/w", generation: 1, requestId: "proxy:1", simulated: false },
  ])
  const { result } = renderHook(() => useBrokerTrace(true))
  await waitFor(() => expect(result.current.rows).toHaveLength(2))
  expect(result.current.rows.map((row) => row.simulated)).toEqual([false, true])
})

it("keeps a bounded window and lets go of the stream when Dev Mode ends", async () => {
  mockBrokerTrace.mockResolvedValue(
    Array.from({ length: BROKER_TRACE_ROWS + 3 }, (_, index) => entry(index + 1))
  )
  const { result, rerender } = renderHook(({ on }) => useBrokerTrace(on), {
    initialProps: { on: true },
  })
  await waitFor(() => expect(result.current.rows).toHaveLength(BROKER_TRACE_ROWS))
  expect(result.current.rows[0].seq).toBe(4)
  rerender({ on: false })
  expect(result.current.rows).toEqual([])
  expect(mockUnlisten).toHaveBeenCalled()
})

it("reports a failed read", async () => {
  mockBrokerTrace.mockRejectedValue(new Error("host gone"))
  const { result } = renderHook(() => useBrokerTrace(true))
  await waitFor(() => expect(result.current.error).toBe("host gone"))
})
