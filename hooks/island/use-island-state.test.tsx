/** @jest-environment jsdom */
import { act, render, screen } from "@testing-library/react"

const onStateMock = jest.fn()
const requestStateMock = jest.fn()

jest.mock("@/lib/island/client", () => ({
  onIslandState: (...a: unknown[]) => onStateMock(...a),
  requestIslandState: (...a: unknown[]) => requestStateMock(...a),
}))

import { useIslandState } from "./use-island-state"
import type { IslandState } from "@/lib/island/types"

let push: (state: IslandState) => void = () => {}

function state(revision: number, attentionCount = 0, epoch = 1): IslandState {
  return {
    epoch,
    revision,
    generatedAt: revision,
    activeCount: 0,
    attentionCount,
    detailVisibility: "click-to-reveal",
    rows: [],
  }
}

function Probe() {
  const value = useIslandState()
  return <span data-testid="out">{`${value.revision}:${value.attentionCount}`}</span>
}

beforeEach(() => {
  requestStateMock.mockReset().mockResolvedValue(true)
  onStateMock.mockReset().mockImplementation(async (handler: (s: IslandState) => void) => {
    push = handler
    return () => {}
  })
})

it("asks the main window to seed it on mount", async () => {
  render(<Probe />)
  await act(async () => {})
  expect(requestStateMock).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId("out").textContent).toBe("0:0")
})

it("takes a newer revision and discards an out-of-order older one", async () => {
  render(<Probe />)
  await act(async () => {})

  await act(async () => push(state(5, 2)))
  expect(screen.getByTestId("out").textContent).toBe("5:2")

  // A push that raced past a newer one must not roll the overlay back.
  await act(async () => push(state(3, 9)))
  expect(screen.getByTestId("out").textContent).toBe("5:2")

  await act(async () => push(state(6, 1)))
  expect(screen.getByTestId("out").textContent).toBe("6:1")
})

it("takes a lower revision from a new epoch (the main window reloaded)", async () => {
  render(<Probe />)
  await act(async () => {})

  await act(async () => push(state(57, 2)))
  expect(screen.getByTestId("out").textContent).toBe("57:2")

  // Main reloaded: its counter restarts at 1 under a fresh epoch. Without the
  // epoch this push would be discarded and the overlay frozen on revision 57.
  await act(async () => push(state(1, 4, 2)))
  expect(screen.getByTestId("out").textContent).toBe("1:4")

  // Ordering resumes within the new epoch.
  await act(async () => push(state(0, 9, 2)))
  expect(screen.getByTestId("out").textContent).toBe("1:4")
})
