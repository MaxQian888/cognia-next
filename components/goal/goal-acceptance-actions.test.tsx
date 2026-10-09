import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"

import { resolveGoalAcceptance } from "@/lib/goal/acceptance"

jest.mock("@/lib/goal/acceptance", () => ({
  resolveGoalAcceptance: jest.fn(),
}))
jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "tauri") }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: jest.fn(() => true) }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))

import { useCanControl } from "@/hooks/data/use-can-control"
import { usePlatform } from "@/hooks/use-platform"
import { transport } from "@/lib/tauri/transport-instance"
import type { Goal } from "@/types/goal"
import { GoalAcceptanceActions } from "./goal-acceptance-actions"

// next-intl globally mocked against en.json in jest.setup.ts.

const resolveMock = resolveGoalAcceptance as jest.Mock
const toastSuccess = toast.success as jest.Mock
const toastError = toast.error as jest.Mock
const usePlatformMock = usePlatform as jest.Mock
const useCanControlMock = useCanControl as jest.Mock
const callMock = transport.call as jest.Mock

const GOAL: Pick<Goal, "id" | "status" | "config"> = {
  id: "g1",
  status: "paused",
  config: { maxTurns: 20, maxTokens: 200_000, maxJudgeFailures: 3, timeoutMs: 1_800_000 },
}

beforeEach(() => {
  resolveMock.mockReset().mockResolvedValue(undefined)
  toastSuccess.mockClear()
  toastError.mockClear()
  usePlatformMock.mockReturnValue("tauri")
  useCanControlMock.mockReturnValue(true)
  callMock.mockReset().mockResolvedValue({ goal: null })
})

describe("GoalAcceptanceActions", () => {
  it("Accept records an accepted verdict and confirms it", async () => {
    const user = userEvent.setup()
    render(<GoalAcceptanceActions goal={GOAL} />)
    await user.click(screen.getByRole("button", { name: "Accept" }))
    expect(resolveMock).toHaveBeenCalledWith("g1", true)
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Accepted — the goal is complete.")
    )
  })

  it("Request changes records a rejected verdict and confirms it", async () => {
    const user = userEvent.setup()
    render(<GoalAcceptanceActions goal={GOAL} />)
    await user.click(screen.getByRole("button", { name: "Request changes" }))
    expect(resolveMock).toHaveBeenCalledWith("g1", false)
    await waitFor(() =>
      expect(toastSuccess).toHaveBeenCalledWith("Changes requested — the goal resumed.")
    )
  })

  it("says so when the verdict fails, and re-enables the buttons", async () => {
    const user = userEvent.setup()
    resolveMock.mockRejectedValueOnce(new Error("goal is not awaiting acceptance"))
    render(<GoalAcceptanceActions goal={GOAL} />)
    await user.click(screen.getByRole("button", { name: "Accept" }))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn't record your verdict", {
        description: "goal is not awaiting acceptance",
      })
    )
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled()
  })

  it("disables both buttons while a verdict is in flight", async () => {
    const user = userEvent.setup()
    let settle!: () => void
    resolveMock.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)))
    render(<GoalAcceptanceActions goal={GOAL} />)
    await user.click(screen.getByRole("button", { name: "Accept" }))
    expect(screen.getByRole("button", { name: "Accept" })).toBeDisabled()
    expect(screen.getByRole("button", { name: "Request changes" })).toBeDisabled()
    settle()
    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeEnabled())
    expect(resolveMock).toHaveBeenCalledTimes(1)
  })

  it("keeps clicks from selecting the row around it", async () => {
    const user = userEvent.setup()
    const onRowClick = jest.fn()
    render(
      <div onClick={onRowClick}>
        <GoalAcceptanceActions goal={GOAL} size="compact" />
      </div>
    )
    await user.click(screen.getByRole("button", { name: "Request changes" }))
    expect(onRowClick).not.toHaveBeenCalled()
  })

  it("sizes the buttons for a list row when compact", () => {
    const { rerender } = render(<GoalAcceptanceActions goal={GOAL} />)
    expect(screen.getByRole("button", { name: "Accept" })).toHaveClass("min-h-11")
    rerender(<GoalAcceptanceActions goal={GOAL} size="compact" />)
    expect(screen.getByRole("button", { name: "Accept" })).not.toHaveClass("min-h-11")
    expect(screen.getByRole("button", { name: "Accept" })).toHaveAttribute("data-size", "xs")
  })

  describe("on a paired phone", () => {
    beforeEach(() => usePlatformMock.mockReturnValue("mobile"))

    it("sends the verdict to the desktop over goal_accept, never the local database", async () => {
      const user = userEvent.setup()
      render(<GoalAcceptanceActions goal={GOAL} />)
      await user.click(screen.getByRole("button", { name: "Accept" }))
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("goal_accept", { goalId: "g1", accepted: true })
      )
      await user.click(screen.getByRole("button", { name: "Request changes" }))
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("goal_accept", { goalId: "g1", accepted: false })
      )
      expect(resolveMock).not.toHaveBeenCalled()
      expect(toastSuccess).toHaveBeenCalledWith("Applied on desktop.")
    })

    it("says the desktop was unreachable when the RPC fails", async () => {
      const user = userEvent.setup()
      callMock.mockRejectedValueOnce(new Error("offline"))
      render(<GoalAcceptanceActions goal={GOAL} />)
      await user.click(screen.getByRole("button", { name: "Accept" }))
      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
      )
    })

    it.each([false, "unknown"] as const)(
      "draws nothing without the remote-control grant (%s)",
      (grant) => {
        useCanControlMock.mockReturnValue(grant)
        render(<GoalAcceptanceActions goal={GOAL} />)
        expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument()
        expect(screen.queryByRole("button", { name: "Request changes" })).not.toBeInTheDocument()
      }
    )
  })
})
