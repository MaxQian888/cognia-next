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
const resolveTemplateMock = jest.fn().mockResolvedValue({
  rawObjective: "review the PR",
  config: { maxTurns: 30 },
})
jest.mock("@/lib/goal/templates", () => ({
  createGoalFromTemplate: (...a: unknown[]) => createFromTemplateMock(...a),
  resolveGoalTemplate: (...a: unknown[]) => resolveTemplateMock(...a),
}))

// The platform and the remote-control grant pick where the goal is created
// (`useGoalCreate`); the phone cases flip them.
const mockShell = { platform: "web", grant: true as boolean | "unknown" }
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockShell.platform }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: () => mockShell.grant }))
const mockCall = jest.fn()
jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...a: unknown[]) => mockCall(...a) },
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
  resolveTemplateMock.mockClear()
  mockCall.mockReset().mockResolvedValue({ goal: { id: "g-remote" } })
  mockToastError.mockClear()
  mockShell.platform = "web"
  mockShell.grant = true
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
    // Straight into the new conversation.
    expect(pushMock).toHaveBeenCalledWith("/?session=ses_new")
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

  it("renders the trigger under a custom test id, or not at all", () => {
    const { rerender } = render(<GoalQuickCreateDialog triggerTestId="goal-empty-create" />)
    expect(screen.getByTestId("goal-empty-create")).toHaveTextContent("New goal")
    expect(screen.queryByTestId("goal-quick-create-trigger")).toBeNull()
    rerender(<GoalQuickCreateDialog showTrigger={false} />)
    expect(screen.queryByRole("button", { name: "New goal" })).toBeNull()
    expect(screen.queryByTestId("goal-quick-create-dialog")).toBeNull()
  })

  it("is controllable, pre-filled with initialObjective, and reports closing on success", async () => {
    const onOpenChange = jest.fn()
    render(
      <GoalQuickCreateDialog
        open
        onOpenChange={onOpenChange}
        initialObjective="re-run this"
        showTrigger={false}
      />
    )
    expect(screen.getByRole("dialog", { name: "New goal" })).toBeInTheDocument()
    const objective = screen.getByTestId("goal-quick-create-objective")
    expect(objective).toHaveValue("re-run this")
    fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/?session=ses_new"))
    expect(createGoalMock).toHaveBeenCalledWith(
      expect.objectContaining({ rawObjective: "re-run this" })
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("Cancel asks a controlled owner to close", () => {
    const onOpenChange = jest.fn()
    render(<GoalQuickCreateDialog open onOpenChange={onOpenChange} showTrigger={false} />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("restarts from a new initialObjective when reopened for another goal", () => {
    const { rerender } = render(
      <GoalQuickCreateDialog open initialObjective="first" showTrigger={false} />
    )
    fireEvent.change(screen.getByTestId("goal-quick-create-objective"), {
      target: { value: "edited" },
    })
    rerender(<GoalQuickCreateDialog open initialObjective="second" showTrigger={false} />)
    expect(screen.getByTestId("goal-quick-create-objective")).toHaveValue("second")
  })

  it("opens on initialTemplateId and creates from that template", async () => {
    templatesValue = [{ id: "tpl1", title: "Review PR" }]
    render(<GoalQuickCreateDialog open initialTemplateId="tpl1" showTrigger={false} />)
    const picker = await screen.findByTestId("goal-quick-create-template")
    expect(picker).toHaveTextContent("Review PR")
    // A template replaces the free-text objective.
    expect(screen.queryByTestId("goal-quick-create-objective")).toBeNull()
    const submit = screen.getByTestId("goal-quick-create-submit")
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() =>
      expect(createFromTemplateMock).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: "tpl1", sessionId: "ses_new" })
      )
    )
    expect(createGoalMock).not.toHaveBeenCalled()
    expect(pushMock).toHaveBeenCalledWith("/?session=ses_new")
  })

  describe("on a paired phone", () => {
    beforeEach(() => {
      mockShell.platform = "mobile"
    })

    it("creates the goal on the desktop over goal_create, never in the local runtime", async () => {
      render(<GoalQuickCreateDialog />)
      fireEvent.click(screen.getByTestId("goal-quick-create-trigger"))
      fireEvent.change(await screen.findByTestId("goal-quick-create-objective"), {
        target: { value: "ship the feature" },
      })
      fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
      await waitFor(() =>
        expect(mockCall).toHaveBeenCalledWith("goal_create", {
          sessionId: "ses_new",
          rawObjective: "ship the feature",
        })
      )
      expect(createGoalMock).not.toHaveBeenCalled()
      expect(pushMock).toHaveBeenCalledWith("/?session=ses_new")
    })

    it("Run again (pre-filled) goes to the desktop too", async () => {
      render(<GoalQuickCreateDialog open initialObjective="re-run this" showTrigger={false} />)
      fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
      await waitFor(() =>
        expect(mockCall).toHaveBeenCalledWith("goal_create", {
          sessionId: "ses_new",
          rawObjective: "re-run this",
        })
      )
    })

    it("a template's objective and config travel with goal_create", async () => {
      templatesValue = [{ id: "tpl1", title: "Review PR" }]
      render(<GoalQuickCreateDialog open initialTemplateId="tpl1" showTrigger={false} />)
      await screen.findByTestId("goal-quick-create-template")
      fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
      await waitFor(() =>
        expect(mockCall).toHaveBeenCalledWith("goal_create", {
          sessionId: "ses_new",
          rawObjective: "review the PR",
          config: { maxTurns: 30 },
        })
      )
      expect(resolveTemplateMock).toHaveBeenCalledWith("tpl1")
      expect(createFromTemplateMock).not.toHaveBeenCalled()
    })

    it("says why the desktop refused, and keeps the form", async () => {
      mockCall.mockRejectedValueOnce(new Error("forbidden"))
      render(<GoalQuickCreateDialog open initialObjective="x" showTrigger={false} />)
      fireEvent.click(screen.getByTestId("goal-quick-create-submit"))
      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Couldn't start the goal", {
          description: "forbidden",
        })
      )
      expect(pushMock).not.toHaveBeenCalled()
      expect(screen.getByTestId("goal-quick-create-submit")).toBeEnabled()
    })

    it.each([false, "unknown"] as const)(
      "without the grant (%s): no trigger, and an opened dialog explains instead of creating",
      (grant) => {
        mockShell.grant = grant
        const { rerender } = render(<GoalQuickCreateDialog />)
        expect(screen.queryByTestId("goal-quick-create-trigger")).toBeNull()
        rerender(<GoalQuickCreateDialog open initialObjective="x" showTrigger={false} />)
        expect(screen.getByTestId("goal-quick-create-not-allowed")).toHaveTextContent(
          "needs remote control"
        )
        expect(screen.getByTestId("goal-quick-create-submit")).toBeDisabled()
        expect(createSessionMock).not.toHaveBeenCalled()
      }
    )
  })
})
