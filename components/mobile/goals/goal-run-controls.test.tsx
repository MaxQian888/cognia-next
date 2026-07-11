/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { GoalRunControls } from "./goal-run-controls"
import type { ControlCapability } from "@/hooks/data/use-can-control"
import type { Goal } from "@/types/goal"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let canControl: ControlCapability = true
jest.mock("@/hooks/data/use-can-control", () => ({
  useCanControl: () => canControl,
}))

const transportCallMock = jest.fn(async (_cmd: string, _payload: unknown) => ({ goal: {} }))
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (cmd: string, payload: unknown) => transportCallMock(cmd, payload) },
}))

const toastSuccessMock = jest.fn()
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccessMock(...a),
    error: (...a: unknown[]) => toastErrorMock(...a),
  },
}))

function makeGoal(status: Goal["status"]): Goal {
  return { id: "g1", status, safeObjective: "x" } as unknown as Goal
}

beforeEach(() => {
  canControl = true
  transportCallMock.mockClear().mockResolvedValue({ goal: {} })
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
})

describe("<GoalRunControls />", () => {
  it("renders nothing without the remote-control capability", () => {
    canControl = "unknown"
    const { container } = render(<GoalRunControls goal={makeGoal("active")} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders nothing for terminal goals", () => {
    const { container } = render(<GoalRunControls goal={makeGoal("completed")} />)
    expect(container.firstChild).toBeNull()
  })

  it("pauses an active goal via goal_pause", async () => {
    render(<GoalRunControls goal={makeGoal("active")} />)
    expect(screen.queryByTestId("mobile-goal-resume")).toBeNull()
    fireEvent.click(screen.getByTestId("mobile-goal-pause"))
    await waitFor(() =>
      expect(transportCallMock).toHaveBeenCalledWith("goal_pause", { goalId: "g1" })
    )
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled())
  })

  it("resumes a paused goal via goal_resume", async () => {
    render(<GoalRunControls goal={makeGoal("paused")} />)
    expect(screen.queryByTestId("mobile-goal-pause")).toBeNull()
    fireEvent.click(screen.getByTestId("mobile-goal-resume"))
    await waitFor(() =>
      expect(transportCallMock).toHaveBeenCalledWith("goal_resume", { goalId: "g1" })
    )
  })

  it("stops via goal_stop and reports desktop-unreachable failures", async () => {
    transportCallMock.mockRejectedValueOnce(new Error("offline"))
    render(<GoalRunControls goal={makeGoal("active")} />)
    fireEvent.click(screen.getByTestId("mobile-goal-stop"))
    await waitFor(() =>
      expect(transportCallMock).toHaveBeenCalledWith("goal_stop", { goalId: "g1" })
    )
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled())
    expect(toastSuccessMock).not.toHaveBeenCalled()
  })

  it("does not bubble the click to the enclosing tap-to-open card", async () => {
    const onOpen = jest.fn()
    render(
      <div onClick={onOpen}>
        <GoalRunControls goal={makeGoal("active")} />
      </div>
    )
    fireEvent.click(screen.getByTestId("mobile-goal-pause"))
    await waitFor(() => expect(transportCallMock).toHaveBeenCalled())
    expect(onOpen).not.toHaveBeenCalled()
  })
})
