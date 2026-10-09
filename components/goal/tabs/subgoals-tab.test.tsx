import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"

// next-intl globally mocked against en.json in jest.setup.ts.

let llmClient: { complete: jest.Mock } | null = null
jest.mock("@/lib/ai/renderer-llm-client", () => ({
  buildRendererLlmClient: () => llmClient,
}))

jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}))

// The host by default; the companion cases switch to "mobile" and decide the
// remote-control grant. Companion calls never reach a real transport.
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: jest.fn(() => true) }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))

import { useCanControl } from "@/hooks/data/use-can-control"
import { usePlatform } from "@/hooks/use-platform"
import { transport } from "@/lib/tauri/transport-instance"
import { GoalSubgoalsTab } from "./subgoals-tab"

const usePlatformMock = usePlatform as jest.Mock
const useCanControlMock = useCanControl as jest.Mock
const callMock = transport.call as jest.Mock

const toastErrorMock = toast.error as jest.Mock

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
  llmClient = { complete: jest.fn() }
  toastErrorMock.mockClear()
  usePlatformMock.mockReturnValue("web")
  useCanControlMock.mockReturnValue(true)
  callMock.mockReset()
})
afterAll(dbFixture.dispose)

async function makeGoal(): Promise<Goal> {
  const g = await getGoalRuntime().createGoal({
    sessionId: "ses_a",
    rawObjective: "ship the feature",
  })
  return (await getDb().chatGoals.get(g.id))!
}

describe("GoalSubgoalsTab", () => {
  it("renders the empty state with a generate button", async () => {
    const goal = await makeGoal()
    render(<GoalSubgoalsTab goal={goal} />)
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-empty")).toBeInTheDocument())
    expect(screen.getByTestId("goal-subgoals-generate")).toBeInTheDocument()
  })

  it("generates and renders a checklist with progress", async () => {
    const goal = await makeGoal()
    llmClient!.complete.mockResolvedValue('{"steps": ["Plan", "Build", "Verify"]}')
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await waitFor(() => expect(screen.getAllByTestId("goal-subgoal-item")).toHaveLength(3))
    expect(screen.getByTestId("goal-subgoals-progress")).toBeInTheDocument()
    expect(screen.getByText("Plan")).toBeInTheDocument()
  })

  it("toggles a subgoal's done state", async () => {
    const goal = await makeGoal()
    llmClient!.complete.mockResolvedValue('{"steps": ["Plan"]}')
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    const checkbox = await screen.findByTestId("goal-subgoal-checkbox")
    fireEvent.click(checkbox)
    await waitFor(async () => {
      const fresh = await getDb().chatGoals.get(goal.id)
      expect(fresh?.subgoals?.[0].done).toBe(true)
    })
  })

  it("shows the non-retryable unavailable notice when no LLM client is available", async () => {
    const goal = await makeGoal()
    llmClient = null
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-unavailable")).toBeInTheDocument())
    // It is NOT the generic retryable error.
    expect(screen.queryByTestId("goal-subgoals-error")).not.toBeInTheDocument()
  })

  it("shows an error when decomposition returns nothing", async () => {
    const goal = await makeGoal()
    llmClient!.complete.mockResolvedValue("garbage not json")
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-error")).toBeInTheDocument())
  })

  it("says a failed regenerate failed, and keeps the prior checklist", async () => {
    const goal = await makeGoal()
    llmClient!.complete
      .mockResolvedValueOnce('{"steps": ["Plan"]}')
      .mockResolvedValueOnce("garbage not json")
    render(<GoalSubgoalsTab goal={goal} />)
    fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
    await screen.findByText("Plan")
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }))
    await waitFor(() => expect(screen.getByTestId("goal-subgoals-error")).toBeInTheDocument())
    expect(screen.getByText("Plan")).toBeInTheDocument()
  })

  describe("Clear", () => {
    async function goalWithChecklist(): Promise<Goal> {
      const goal = await makeGoal()
      await getDb().chatGoals.update(goal.id, {
        subgoals: [
          { id: "s1", text: "Plan", done: true, order: 0 },
          { id: "s2", text: "Build", done: false, order: 1 },
        ],
      })
      return (await getDb().chatGoals.get(goal.id))!
    }

    it("is offered only when there is a checklist", async () => {
      const goal = await makeGoal()
      render(<GoalSubgoalsTab goal={goal} />)
      await screen.findByTestId("goal-subgoals-empty")
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull()
      expect(screen.getByRole("button", { name: "Generate checklist" })).toBeInTheDocument()
    })

    it("asks first, and Cancel keeps the checklist", async () => {
      const user = userEvent.setup()
      const goal = await goalWithChecklist()
      render(<GoalSubgoalsTab goal={goal} />)
      expect(await screen.findAllByTestId("goal-subgoal-item")).toHaveLength(2)
      expect(screen.getByRole("button", { name: "Regenerate" })).toBeInTheDocument()
      expect(screen.getByText("1/2 complete")).toBeInTheDocument()

      await user.click(screen.getByRole("button", { name: "Clear" }))
      const dialog = await screen.findByRole("alertdialog")
      expect(dialog).toHaveTextContent("Clear the checklist?")
      await user.click(screen.getByRole("button", { name: "Cancel" }))
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
      expect((await getDb().chatGoals.get(goal.id))?.subgoals).toHaveLength(2)
      expect(screen.getAllByTestId("goal-subgoal-item")).toHaveLength(2)
    })

    it("removes the checklist after confirming", async () => {
      const user = userEvent.setup()
      const goal = await goalWithChecklist()
      render(<GoalSubgoalsTab goal={goal} />)
      await screen.findAllByTestId("goal-subgoal-item")
      await user.click(screen.getByRole("button", { name: "Clear" }))
      await user.click(await screen.findByTestId("goal-subgoals-clear-confirm"))
      await waitFor(() => expect(screen.getByTestId("goal-subgoals-empty")).toBeInTheDocument())
      expect((await getDb().chatGoals.get(goal.id))?.subgoals ?? []).toHaveLength(0)
    })

    it("reports a failed clear with a toast", async () => {
      const user = userEvent.setup()
      const goal = await goalWithChecklist()
      const spy = jest
        .spyOn(getGoalRuntime(), "clearSubgoals")
        .mockRejectedValueOnce(new Error("db locked"))
      render(<GoalSubgoalsTab goal={goal} />)
      await screen.findAllByTestId("goal-subgoal-item")
      await user.click(screen.getByRole("button", { name: "Clear" }))
      await user.click(await screen.findByTestId("goal-subgoals-clear-confirm"))
      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith("Couldn't clear the checklist", {
          description: "db locked",
        })
      )
      expect(screen.getAllByTestId("goal-subgoal-item")).toHaveLength(2)
      spy.mockRestore()
    })
  })

  describe("on a paired phone", () => {
    async function goalWithChecklist(): Promise<Goal> {
      const goal = await makeGoal()
      await getDb().chatGoals.update(goal.id, {
        subgoals: [
          { id: "s1", text: "Plan", done: false, order: 0 },
          { id: "s2", text: "Build", done: true, order: 1 },
        ],
      })
      return (await getDb().chatGoals.get(goal.id))!
    }

    beforeEach(() => {
      usePlatformMock.mockReturnValue("mobile")
    })

    it("generates on the desktop over goal_subgoals_generate, never with this device's model", async () => {
      const goal = await makeGoal()
      callMock.mockResolvedValueOnce({ outcome: "generated", goal })
      render(<GoalSubgoalsTab goal={goal} />)
      fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("goal_subgoals_generate", { goalId: goal.id })
      )
      expect(llmClient!.complete).not.toHaveBeenCalled()
      expect(screen.queryByTestId("goal-subgoals-error")).toBeNull()
    })

    it("says the desktop is still generating when it answered running", async () => {
      const goal = await makeGoal()
      callMock.mockResolvedValueOnce({ outcome: "running" })
      render(<GoalSubgoalsTab goal={goal} />)
      fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
      expect(await screen.findByTestId("goal-subgoals-running")).toHaveTextContent(
        "The desktop is still generating the checklist."
      )
      expect(screen.queryByTestId("goal-subgoals-empty")).toBeNull()
      expect(screen.queryByTestId("goal-subgoals-error")).toBeNull()
    })

    it("shows the desktop's unavailable answer as the non-retryable notice", async () => {
      const goal = await makeGoal()
      callMock.mockResolvedValueOnce({ outcome: "unavailable", goal })
      render(<GoalSubgoalsTab goal={goal} />)
      fireEvent.click(await screen.findByTestId("goal-subgoals-generate"))
      expect(await screen.findByTestId("goal-subgoals-unavailable")).toBeInTheDocument()
    })

    it("checks and clears over goal_subgoal_mark / goal_subgoals_clear, leaving local rows alone", async () => {
      const user = userEvent.setup()
      const goal = await goalWithChecklist()
      callMock.mockResolvedValue({ goal: null, changed: true })
      render(<GoalSubgoalsTab goal={goal} />)
      const [first, second] = await screen.findAllByTestId("goal-subgoal-checkbox")
      fireEvent.click(first!)
      fireEvent.click(second!)
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("goal_subgoal_mark", {
          goalId: goal.id,
          subgoalId: "s1",
          done: true,
        })
      )
      expect(callMock).toHaveBeenCalledWith("goal_subgoal_mark", {
        goalId: goal.id,
        subgoalId: "s2",
        done: false,
      })

      await user.click(screen.getByRole("button", { name: "Clear" }))
      await user.click(await screen.findByTestId("goal-subgoals-clear-confirm"))
      await waitFor(() =>
        expect(callMock).toHaveBeenCalledWith("goal_subgoals_clear", { goalId: goal.id })
      )
      // The desktop owns the row; this device's mirror changes only on sync.
      const local = await getDb().chatGoals.get(goal.id)
      expect(local?.subgoals?.map((s) => s.done)).toEqual([false, true])
    })

    it("reports an unreachable desktop with the remote message", async () => {
      const goal = await goalWithChecklist()
      callMock.mockRejectedValueOnce(new Error("offline"))
      render(<GoalSubgoalsTab goal={goal} />)
      const [first] = await screen.findAllByTestId("goal-subgoal-checkbox")
      fireEvent.click(first!)
      await waitFor(() =>
        expect(toastErrorMock).toHaveBeenCalledWith("Couldn't reach the desktop — try again.")
      )
    })

    it("is read-only without the remote-control grant, and says why", async () => {
      useCanControlMock.mockReturnValue("unknown")
      const goal = await goalWithChecklist()
      render(<GoalSubgoalsTab goal={goal} />)
      expect(await screen.findByTestId("goal-subgoals-read-only")).toHaveTextContent(
        "needs remote control"
      )
      expect(screen.getByTestId("goal-subgoals-generate")).toBeDisabled()
      expect(screen.getByTestId("goal-subgoals-clear")).toBeDisabled()
      for (const box of screen.getAllByTestId("goal-subgoal-checkbox")) {
        expect(box).toBeDisabled()
      }
      expect(callMock).not.toHaveBeenCalled()
    })
  })
})
