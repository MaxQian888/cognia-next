/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"

const onResponseMock = jest.fn()
const requestDetailMock = jest.fn()

jest.mock("@/lib/island/client", () => ({
  onIslandDetailResponse: (...a: unknown[]) => onResponseMock(...a),
  requestIslandDetail: (...a: unknown[]) => requestDetailMock(...a),
}))

import { useIslandDetail } from "./use-island-detail"
import type { IslandDetailResponse } from "@/lib/island/types"
import { ISLAND_ACTION_TIMEOUT_MS } from "@/lib/island/types"

let reply: (response: IslandDetailResponse) => void = () => {}

function Probe({
  rowId,
  revision = 4,
  stamp = 0,
}: {
  rowId: string | null
  revision?: number
  stamp?: number
}) {
  const slot = useIslandDetail(rowId, revision, stamp)
  return (
    <span data-testid="out">{`${slot.rowId ?? "-"}:${slot.detail?.cwd ?? "-"}:${slot.error ?? "-"}`}</span>
  )
}

const DETAIL = {
  cwd: "/w",
  toolUseCount: 0,
  turnCount: 0,
  agentPid: null,
  startedAt: 0,
  status: "working" as const,
  model: null,
  permissionMode: null,
}

beforeEach(() => {
  requestDetailMock.mockReset().mockResolvedValue(true)
  onResponseMock
    .mockReset()
    .mockImplementation(async (handler: (r: IslandDetailResponse) => void) => {
      reply = handler
      return () => {}
    })
})

afterEach(() => {
  jest.useRealTimers()
})

it("waits for the response listener before sending", async () => {
  let finishRegistration!: (off: () => void) => void
  onResponseMock.mockImplementation((handler: typeof reply) => {
    reply = handler
    return new Promise((resolve) => {
      finishRegistration = resolve
    })
  })
  requestDetailMock.mockImplementation(async ({ requestId, rowId }) => {
    reply({ requestId, rowId, revision: 4, detail: DETAIL })
    return true
  })
  render(<Probe rowId="r1" />)
  await act(async () => {})
  expect(requestDetailMock).not.toHaveBeenCalled()
  await act(async () => finishRegistration(() => {}))
  expect(screen.getByTestId("out").textContent).toBe("r1:/w:-")
})

it.each([false, "rejected"])("surfaces unavailable when sending fails: %s", async (failure) => {
  if (failure === false) requestDetailMock.mockResolvedValue(false)
  else requestDetailMock.mockRejectedValue(new Error("disconnected"))
  render(<Probe rowId="r1" />)
  await act(async () => {})
  expect(screen.getByTestId("out").textContent).toBe("r1:-:unavailable")
})

it("times out a missing response and ignores a late answer", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  render(<Probe rowId="r1" />)
  await act(async () => {})
  const { requestId } = requestDetailMock.mock.calls[0][0]
  await act(async () => jest.advanceTimersByTime(ISLAND_ACTION_TIMEOUT_MS))
  expect(screen.getByTestId("out").textContent).toBe("r1:-:unavailable")
  await act(async () => reply({ requestId, rowId: "r1", revision: 4, detail: DETAIL }))
  expect(screen.getByTestId("out").textContent).toBe("r1:-:unavailable")
})

it("reports failed listener registration without sending", async () => {
  onResponseMock.mockRejectedValue(new Error("listener unavailable"))
  render(<Probe rowId="r1" />)
  await act(async () => {})
  expect(requestDetailMock).not.toHaveBeenCalled()
  expect(screen.getByTestId("out").textContent).toBe("r1:-:unavailable")
})

it.each(["timeout", "unmount"])(
  "does not send after late listener setup following %s",
  async (end) => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
    let finishRegistration!: (off: () => void) => void
    const unsubscribe = jest.fn()
    onResponseMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRegistration = resolve
        })
    )
    const { unmount } = render(<Probe rowId="r1" />)
    if (end === "timeout") {
      await act(async () => jest.advanceTimersByTime(ISLAND_ACTION_TIMEOUT_MS))
      expect(screen.getByTestId("out").textContent).toBe("r1:-:unavailable")
    } else unmount()
    await act(async () => finishRegistration(unsubscribe))
    expect(requestDetailMock).not.toHaveBeenCalled()
    if (end === "timeout") unmount()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  }
)

it("ignores a retired row listener and releases its outstanding timer", async () => {
  jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
  const { rerender, unmount } = render(<Probe rowId="r1" />)
  await act(async () => {})
  const retiredReply = reply
  const first = requestDetailMock.mock.calls[0][0]
  rerender(<Probe rowId="r2" />)
  await act(async () => {})
  expect(jest.getTimerCount()).toBe(1)
  await act(async () => retiredReply({ ...first, detail: DETAIL }))
  expect(screen.getByTestId("out").textContent).toBe("-:-:-")
  unmount()
  expect(jest.getTimerCount()).toBe(0)
})

it("rejects a response whose row does not match the requested row", async () => {
  render(<Probe rowId="r1" />)
  await act(async () => {})
  const first = requestDetailMock.mock.calls[0][0]
  await act(async () => reply({ ...first, rowId: "r2", detail: DETAIL }))
  expect(screen.getByTestId("out").textContent).toBe("-:-:-")
})

it("uses unavailable when an empty response has no refusal reason", async () => {
  render(<Probe rowId="r1" />)
  await act(async () => {})
  const first = requestDetailMock.mock.calls[0][0]
  await act(async () => reply({ ...first, detail: null }))
  expect(screen.getByTestId("out").textContent).toBe("r1:-:unavailable")
})

it.each([null, "r2"])(
  "discards cached detail when the pin leaves for %s and returns",
  async (away) => {
    const { rerender } = render(<Probe rowId="r1" />)
    await act(async () => {})
    const { requestId } = requestDetailMock.mock.calls[0][0]
    await act(async () => reply({ requestId, rowId: "r1", revision: 4, detail: DETAIL }))
    rerender(<Probe rowId={away} />)
    rerender(<Probe rowId="r1" />)
    await act(async () => {})
    expect(screen.getByTestId("out").textContent).toBe("-:-:-")
    const fresh = requestDetailMock.mock.calls.at(-1)![0]
    await act(async () => reply({ ...fresh, detail: { ...DETAIL, cwd: "/fresh" } }))
    expect(screen.getByTestId("out").textContent).toBe("r1:/fresh:-")
  }
)

it("requests nothing while no row is pinned", async () => {
  render(<Probe rowId={null} />)
  await act(async () => {})
  expect(requestDetailMock).not.toHaveBeenCalled()
  expect(screen.getByTestId("out").textContent).toBe("-:-:-")
})

it("requests the pinned row and renders the response", async () => {
  render(<Probe rowId="r1" />)
  await act(async () => {})
  const { requestId } = requestDetailMock.mock.calls[0][0]
  expect(requestDetailMock.mock.calls[0][0]).toMatchObject({ rowId: "r1", revision: 4 })
  await act(async () => reply({ requestId, revision: 4, rowId: "r1", detail: DETAIL }))
  expect(screen.getByTestId("out").textContent).toBe("r1:/w:-")
})

it("drops the revealed detail as soon as the pin moves away", async () => {
  const { rerender } = render(<Probe rowId="r1" />)
  await act(async () => {})
  const { requestId } = requestDetailMock.mock.calls[0][0]
  await act(async () => reply({ requestId, revision: 4, rowId: "r1", detail: DETAIL }))
  expect(screen.getByTestId("out").textContent).toBe("r1:/w:-")

  rerender(<Probe rowId={null} />)
  await act(async () => {})
  expect(screen.getByTestId("out").textContent).toBe("-:-:-")
})

it("ignores a response for a request the hook has moved on from", async () => {
  render(<Probe rowId="r1" />)
  await act(async () => {})
  await act(async () =>
    reply({ requestId: "someone-else", revision: 4, rowId: "r1", detail: DETAIL })
  )
  expect(screen.getByTestId("out").textContent).toBe("-:-:-")
})

it("surfaces a refusal reason instead of an empty panel", async () => {
  render(<Probe rowId="r1" />)
  await act(async () => {})
  const { requestId } = requestDetailMock.mock.calls[0][0]
  await act(async () =>
    reply({ requestId, revision: 4, rowId: "r1", detail: null, reason: "notPermitted" })
  )
  expect(screen.getByTestId("out").textContent).toBe("r1:-:notPermitted")
})

describe("request cadence", () => {
  it("refreshes a settled row when its own stamp changes", async () => {
    const { rerender } = render(<Probe rowId="r1" stamp={1} />)
    await act(async () => {})
    const first = requestDetailMock.mock.calls[0][0]
    await act(async () => reply({ ...first, detail: DETAIL }))
    rerender(<Probe rowId="r1" revision={8} stamp={2} />)
    await act(async () => {})
    expect(requestDetailMock).toHaveBeenCalledTimes(2)
    expect(requestDetailMock.mock.calls[1][0]).toMatchObject({ rowId: "r1", revision: 8 })
  })

  it("recovers a queued update after the previous request times out", async () => {
    jest.useFakeTimers({ doNotFake: ["queueMicrotask"] })
    const { rerender } = render(<Probe rowId="r1" stamp={1} />)
    await act(async () => {})
    rerender(<Probe rowId="r1" stamp={2} />)
    await act(async () => jest.advanceTimersByTime(ISLAND_ACTION_TIMEOUT_MS))
    expect(requestDetailMock).toHaveBeenCalledTimes(2)
    const fresh = requestDetailMock.mock.calls[1][0]
    await act(async () => reply({ ...fresh, detail: DETAIL }))
    expect(screen.getByTestId("out").textContent).toBe("r1:/w:-")
    expect(jest.getTimerCount()).toBe(0)
  })

  it("does not re-request when only the revision moves", async () => {
    // The main window bumps the revision on every fleet event; re-requesting
    // per event invalidated the reply in flight and left a pinned row loading.
    const { rerender } = render(<Probe rowId="r1" revision={4} />)
    await act(async () => {})
    rerender(<Probe rowId="r1" revision={5} />)
    rerender(<Probe rowId="r1" revision={6} />)
    await act(async () => {})
    expect(requestDetailMock).toHaveBeenCalledTimes(1)

    const { requestId } = requestDetailMock.mock.calls[0][0]
    await act(async () => reply({ requestId, revision: 6, rowId: "r1", detail: DETAIL }))
    expect(screen.getByTestId("out").textContent).toBe("r1:/w:-")
  })

  it("coalesces a row change while a request is in flight into one follow-up", async () => {
    const { rerender } = render(<Probe rowId="r1" revision={4} stamp={1} />)
    await act(async () => {})
    rerender(<Probe rowId="r1" revision={7} stamp={2} />)
    rerender(<Probe rowId="r1" revision={8} stamp={3} />)
    await act(async () => {})
    expect(requestDetailMock).toHaveBeenCalledTimes(1)

    const first = requestDetailMock.mock.calls[0][0]
    await act(async () =>
      reply({ requestId: first.requestId, revision: 4, rowId: "r1", detail: DETAIL })
    )
    // Exactly one follow-up, carrying the revision current at that moment.
    expect(requestDetailMock).toHaveBeenCalledTimes(2)
    expect(requestDetailMock.mock.calls[1][0]).toMatchObject({ rowId: "r1", revision: 8 })
    expect(screen.getByTestId("out").textContent).toBe("r1:/w:-")
  })
})
