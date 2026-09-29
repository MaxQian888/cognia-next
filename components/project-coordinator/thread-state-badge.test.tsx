/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { THREAD_BOARD_ORDER } from "@/lib/project-coordinator/thread-state"
import { ThreadStateBadge } from "./thread-state-badge"

describe("ThreadStateBadge", () => {
  it("labels every board state", () => {
    for (const state of THREAD_BOARD_ORDER) {
      const { unmount } = render(<ThreadStateBadge state={state} />)
      expect(screen.getByTestId(`thread-state-${state}`).textContent).not.toMatch(/^state\./)
      unmount()
    }
    render(<ThreadStateBadge state="waiting" />)
    expect(screen.getByText("Waiting on you")).toBeInTheDocument()
  })
})
