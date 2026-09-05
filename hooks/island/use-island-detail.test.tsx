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
