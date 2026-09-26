import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { useSettingsStore } from "@/stores/settings/settings-store"

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }))

const createSessionMock = jest.fn().mockResolvedValue({ id: "ses_new" })
jest.mock("@/hooks/chat/use-sessions", () => ({
  useSessions: () => ({ create: createSessionMock }),
}))

const createGoalMock = jest.fn().mockResolvedValue({ id: "g1" })
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ createGoal: createGoalMock }),
}))

const createFromTemplateMock = jest.fn().mockResolvedValue({ id: "g2" })
jest.mock("@/lib/goal/templates", () => ({
  createGoalFromTemplate: (...a: unknown[]) => createFromTemplateMock(...a),
}))

const mockToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...a: unknown[]) => mockToastError(...a) },
}))

let templatesValue: { id: string; title: string }[] = []
jest.mock("@/lib/db/goal-templates", () => ({
  listGoalTemplates: () => Promise.resolve(templatesValue),
}))

import { GoalQuickCreateDialog } from "./goal-quick-create-dialog"

beforeEach(() => {
  pushMock.mockClear()
  createSessionMock.mockClear()
  createGoalMock.mockClear()
  createFromTemplateMock.mockClear()
  templatesValue = []
  useSettingsStore.setState({ settings: { defaultProvider: "anthropic" } as never })
})

describe("GoalQuickCreateDialog", () => {
  it("opens the dialog from the trigger", async () => {
    render(<GoalQuickCreateDialog />)
    fireEvent.click(screen.getByTestId("goal-quick-create-trigger"))
    expect(await screen.findByTestId("goal-quick-create-dialog")).toBeInTheDocument()
  })

  it("disables submit until an objective is entered", async () => {
    render(<GoalQuickCreateDialog />)
    fireEvent.click(screen.getByTestId("goal-quick-create-trigger"))
    const submit = await screen.findByTestId("goal-quick-create-submit")
    expect(submit).toBeDisabled()
    fireEvent.change(screen.getByTestId("goal-quick-create-objective"), {
      target: { value: "ship the feature" },
    })
    expect(submit).toBeEnabled()
  })

  it("creates a session + goal and navigates to chat on submit", async () => {
    render(<GoalQuickCreateDialog />)
    fireEvent.click(screen.getByTestId("goal-quick-create-trigger"))
    fireEvent.change(await screen.findByTestId("goal-quick-create-objective"), {
      target: { value: "ship the feature" },
    })
    fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
    await waitFor(() => expect(createSessionMock).toHaveBeenCalled())
    expect(createGoalMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "ses_new", rawObjective: "ship the feature" })
    )
    expect(pushMock).toHaveBeenCalledWith("/")
  })

  it("says why the goal did not start, and keeps the form for a retry", async () => {
    createGoalMock.mockRejectedValueOnce(new Error("objective blocked by the PII gate"))
    render(<GoalQuickCreateDialog />)
    fireEvent.click(screen.getByTestId("goal-quick-create-trigger"))
    fireEvent.change(await screen.findByTestId("goal-quick-create-objective"), {
      target: { value: "ship the feature" },
    })
    fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(expect.any(String), {
        description: "objective blocked by the PII gate",
      })
    )
    expect(pushMock).not.toHaveBeenCalled()
    expect(screen.getByTestId("goal-quick-create-submit")).toBeEnabled()
    expect(screen.getByTestId("goal-quick-create-objective")).toHaveValue("ship the feature")
  })

  it("shows the template picker when templates exist", async () => {
    templatesValue = [{ id: "tpl1", title: "Review PR" }]
    render(<GoalQuickCreateDialog />)
    fireEvent.click(screen.getByTestId("goal-quick-create-trigger"))
    expect(await screen.findByTestId("goal-quick-create-template")).toBeInTheDocument()
  })
})
