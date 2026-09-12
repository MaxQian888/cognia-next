/** @jest-environment jsdom */
import { useEffect } from "react"
import { act, render, screen } from "@testing-library/react"

const onResultMock = jest.fn()
const requestActionMock = jest.fn()

jest.mock("@/lib/island/client", () => ({
  onIslandActionResult: (...a: unknown[]) => onResultMock(...a),
  requestIslandAction: (...a: unknown[]) => requestActionMock(...a),
}))

import { useIslandActions } from "./use-island-actions"
import { ISLAND_ACTION_TIMEOUT_MS, type IslandActionResult } from "@/lib/island/types"

let reply: (result: IslandActionResult) => void = () => {}
// Property mutation, not a reassignment of an outer binding: the hook's return
// has to escape the component so the test can drive it.
const probe: { api: ReturnType<typeof useIslandActions> | null } = { api: null }
const api = () => probe.api!

function Probe() {
  const value = useIslandActions()
  const status = value.statusOf("row", "interrupt")
  // Published from an effect, not from render: the rule that forbids the
  // render-phase write is the same one this hook's consumers live under.
  useEffect(() => {
    probe.api = value
  })
  return <span data-testid="out">{`${status.pending}:${status.error ?? "-"}`}</span>
}

beforeEach(() => {
  jest.useFakeTimers()
  requestActionMock.mockReset().mockResolvedValue(true)
  onResultMock.mockReset().mockImplementation(async (handler: (r: IslandActionResult) => void) => {
    reply = handler
    return () => {}
  })
})
afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

async function mount() {
  render(<Probe />)
  await act(async () => {})
}

it("marks the control pending and mints a request id", async () => {
  await mount()
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  expect(screen.getByTestId("out").textContent).toBe("true:-")
  expect(requestActionMock.mock.calls[0][0]).toMatchObject({
    kind: "interrupt",
    revision: 3,
    rowId: "row",
  })
  expect(typeof requestActionMock.mock.calls[0][0].requestId).toBe("string")
})

it("refuses a repeat submission while the first is still outstanding", async () => {
  await mount()
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  expect(requestActionMock).toHaveBeenCalledTimes(1)
})

it("clears the pending state on a completed receipt", async () => {
  await mount()
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  const { requestId } = requestActionMock.mock.calls[0][0]
  await act(async () => reply({ requestId, revision: 3, outcome: "completed" }))
  expect(screen.getByTestId("out").textContent).toBe("false:-")
})

it("surfaces the reason from a rejected receipt", async () => {
  await mount()
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  const { requestId } = requestActionMock.mock.calls[0][0]
  await act(async () =>
    reply({ requestId, revision: 4, outcome: "rejected", reason: "staleRevision" })
  )
  expect(screen.getByTestId("out").textContent).toBe("false:staleRevision")
})

it("offers a retry when no receipt arrives inside the timeout", async () => {
  await mount()
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  await act(async () => {
    jest.advanceTimersByTime(ISLAND_ACTION_TIMEOUT_MS + 1)
  })
  expect(screen.getByTestId("out").textContent).toBe("false:timeout")

  // And the control is usable again.
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  expect(requestActionMock).toHaveBeenCalledTimes(2)
})

it("settles immediately when the emit itself could not be delivered", async () => {
  requestActionMock.mockResolvedValue(false)
  await mount()
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  expect(screen.getByTestId("out").textContent).toBe("false:callFailed")
})

function delayedListener() {
  let resolve!: (off: () => void) => void
  let reject!: (error: Error) => void
  const ready = new Promise<() => void>((done, fail) => {
    resolve = done
    reject = fail
  })
  const off = jest.fn()
  onResultMock.mockImplementation((handler: (result: IslandActionResult) => void) => {
    reply = handler
    return ready
  })
  return { resolve: () => resolve(off), reject, off }
}

it("waits for the result listener before sending and accepts an immediate receipt", async () => {
  const listener = delayedListener()
  requestActionMock.mockImplementation(async ({ requestId }: { requestId: string }) => {
    reply({ requestId, revision: 3, outcome: "completed" })
    return true
  })
  await mount()
  let completion!: Promise<boolean>
  await act(async () => {
    completion = api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
    expect(await api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })).toBe(false)
  })
  expect(requestActionMock).not.toHaveBeenCalled()
  await act(async () => listener.resolve())
  expect(await completion).toBe(true)
  expect(requestActionMock).toHaveBeenCalledTimes(1)
  expect(onResultMock).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId("out").textContent).toBe("false:-")
})

it("reports listener setup failure without emitting an action", async () => {
  const listener = delayedListener()
  await mount()
  let completion!: Promise<boolean>
  await act(async () => {
    completion = api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  await act(async () => listener.reject(new Error("listener unavailable")))
  expect(await completion).toBe(false)
  expect(requestActionMock).not.toHaveBeenCalled()
  expect(screen.getByTestId("out").textContent).toBe("false:callFailed")
})

it("includes listener setup in the timeout and never sends the expired request", async () => {
  const listener = delayedListener()
  await mount()
  let completion!: Promise<boolean>
  await act(async () => {
    completion = api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  await act(async () => jest.advanceTimersByTime(ISLAND_ACTION_TIMEOUT_MS))
  expect(await completion).toBe(false)
  expect(screen.getByTestId("out").textContent).toBe("false:timeout")
  await act(async () => listener.resolve())
  expect(requestActionMock).not.toHaveBeenCalled()
})

it("cancels an action and releases a listener that finishes registering after unmount", async () => {
  const listener = delayedListener()
  const view = render(<Probe />)
  let completion!: Promise<boolean>
  await act(async () => {
    completion = api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  const staleApi = api()
  view.unmount()
  expect(await completion).toBe(false)
  await act(async () => listener.resolve())
  expect(listener.off).toHaveBeenCalledTimes(1)
  expect(requestActionMock).not.toHaveBeenCalled()
  expect(await staleApi.dispatch({ kind: "interrupt", revision: 3, rowId: "row" })).toBe(false)
})

it("reports a rejected emission promise and ignores a late receipt", async () => {
  requestActionMock.mockRejectedValue(new Error("emit failed"))
  await mount()
  let completion!: Promise<boolean>
  await act(async () => {
    completion = api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  expect(await completion).toBe(false)
  expect(screen.getByTestId("out").textContent).toBe("false:callFailed")
  const { requestId } = requestActionMock.mock.calls[0][0]
  await act(async () => reply({ requestId, revision: 3, outcome: "completed" }))
  expect(screen.getByTestId("out").textContent).toBe("false:callFailed")
})

it("uses a fallback reason for failed receipts and ignores callbacks after unmount", async () => {
  const off = jest.fn()
  onResultMock.mockImplementation(async (handler: typeof reply) => {
    reply = handler
    return off
  })
  const view = render(<Probe />)
  await act(async () => {})
  await act(async () => {
    void api().dispatch({ kind: "interrupt", revision: 3, rowId: "row" })
  })
  const { requestId } = requestActionMock.mock.calls[0][0]
  await act(async () => reply({ requestId, revision: 3, outcome: "failed" }))
  expect(screen.getByTestId("out").textContent).toBe("false:callFailed")
  view.unmount()
  reply({ requestId, revision: 3, outcome: "completed" })
  expect(off).toHaveBeenCalledTimes(1)
})
