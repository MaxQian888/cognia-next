import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { toast } from "sonner"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"

jest.mock("@/components/goal/goal-verification-workflow-picker", () => ({
  GoalVerificationWorkflowPicker: ({
    onChange,
    disabled,
  }: {
    onChange: (value?: unknown) => void
    disabled?: boolean
  }) => (
    <div data-testid="verifier-picker" data-disabled={disabled ? "true" : "false"}>
      <button
        type="button"
        data-testid="select-verifier"
        onClick={() =>
          onChange({
            workflowId: "wf-1",
            versionId: "wfv-1",
            deploymentId: "wfd-1",
            deploymentRevision: 1,
            dependencyLock: { workflows: {}, indexes: {} },
          })
        }
      >
        select verifier
      </button>
      <button type="button" data-testid="clear-verifier" onClick={() => onChange(undefined)}>
        clear verifier
      </button>
    </div>
  ),
}))
jest.mock("sonner", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}))
// The platform and the remote-control grant decide the transport; the phone
// cases below flip them.
const mockShell = { platform: "web", grant: true as boolean | "unknown" }
jest.mock("@/hooks/use-platform", () => ({ usePlatform: () => mockShell.platform }))
jest.mock("@/hooks/data/use-can-control", () => ({ useCanControl: () => mockShell.grant }))
jest.mock("@/lib/tauri/transport-instance", () => ({ transport: { call: jest.fn() } }))
jest.mock("@/lib/goal/verification", () => ({
  ...jest.requireActual("@/lib/goal/verification"),
  retryPausedGoalVerification: jest.fn(),
}))
import { retryPausedGoalVerification } from "@/lib/goal/verification"
import { transport } from "@/lib/tauri/transport-instance"
import { GoalSettingsTab } from "./settings-tab"

const toastSuccessMock = toast.success as jest.Mock
const toastErrorMock = toast.error as jest.Mock
const toastInfoMock = toast.info as jest.Mock
const callMock = transport.call as jest.Mock
const retryMock = retryPausedGoalVerification as jest.Mock

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
  toastSuccessMock.mockClear()
  toastErrorMock.mockClear()
  toastInfoMock.mockClear()
  callMock.mockReset().mockResolvedValue(undefined)
  retryMock.mockReset()
  mockShell.platform = "web"
  mockShell.grant = true
})
afterAll(dbFixture.dispose)

async function createTestGoal(overrides: Partial<Goal> = {}): Promise<Goal> {
  const g = await getGoalRuntime().createGoal({
    sessionId: "ses_a",
    rawObjective: "x",
  })
  if (overrides.status) {
    const { updateGoal } = await import("@/lib/db/goals")
    await updateGoal(g.id, overrides as Parameters<typeof updateGoal>[1])
    const fresh = await getGoalRuntime().listGoalsBySession("ses_a")
    return fresh[0]!
  }
  return g
}

describe("GoalSettingsTab", () => {
  it("renders all four numeric fields + inline stop", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    expect(screen.getByTestId("goal-config-max-turns")).toBeInTheDocument()
    expect(screen.getByTestId("goal-config-max-tokens")).toBeInTheDocument()
    expect(screen.getByTestId("goal-config-max-judge-failures")).toBeInTheDocument()
    expect(screen.getByTestId("goal-config-timeout")).toBeInTheDocument()
    expect(screen.getByTestId("goal-config-inline-stop")).toBeInTheDocument()
  })

  // ── ADR-0070 Phase 2 — the risk-gating opt-out ─────────────────────────
  it("shows risk gating ON by default and keeps save clean", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    expect(screen.getByTestId("goal-config-risk-gating")).toBeChecked()
    expect(screen.getByTestId("goal-config-save")).toBeDisabled()
  })

  it("turning risk gating off persists an explicit false", async () => {
    // The whole reason this toggle exists: three surfaces document
    // `riskGating: false` as the escape hatch, and it must be reachable.
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    fireEvent.click(screen.getByTestId("goal-config-risk-gating"))
    fireEvent.click(screen.getByTestId("goal-config-save"))
    await waitFor(async () => {
      const fresh = await getGoalRuntime().listGoalsBySession("ses_a")
      expect(fresh[0]?.config.riskGating).toBe(false)
    })
  })

  it("save button is disabled when nothing is dirty", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    const save = screen.getByTestId("goal-config-save")
    expect(save).toBeDisabled()
  })

  it("editing a field enables save, click persists the change", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    const turnsInput = screen.getByTestId("goal-config-max-turns") as HTMLInputElement
    fireEvent.change(turnsInput, { target: { value: "50" } })
    const save = screen.getByTestId("goal-config-save")
    expect(save).not.toBeDisabled()
    fireEvent.click(save)
    await waitFor(async () => {
      const fresh = await getGoalRuntime().listGoalsBySession("ses_a")
      expect(fresh[0]?.config.maxTurns).toBe(50)
    })
  })

  it("is read-only for a terminal goal: fields disabled, note shown, no Save / Discard", async () => {
    const g = await createTestGoal()
    await getGoalRuntime().stopGoal(g.id)
    const fresh = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    render(<GoalSettingsTab goal={fresh} />)
    expect(screen.getByTestId("goal-config-max-turns")).toBeDisabled()
    expect(screen.getByTestId("goal-config-risk-gating")).toBeDisabled()
    expect(screen.getByTestId("goal-settings-readonly")).toHaveTextContent(
      "This goal has ended — its settings are kept as a record and can't be changed."
    )
    expect(screen.queryByTestId("goal-config-save")).toBeNull()
    expect(screen.queryByTestId("goal-config-discard")).toBeNull()
  })

  it("shows no read-only note for an open goal", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    expect(screen.queryByTestId("goal-settings-readonly")).toBeNull()
  })

  it("Discard restores the stored config and clears the unsaved marker", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    const discard = screen.getByRole("button", { name: "Discard" })
    expect(discard).toBeDisabled()
    const turns = screen.getByTestId("goal-config-max-turns") as HTMLInputElement
    fireEvent.change(turns, { target: { value: "42" } })
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    expect(discard).toBeEnabled()
    fireEvent.click(discard)
    expect(turns.value).toBe(String(g.config.maxTurns))
    expect(screen.queryByText("Unsaved changes")).toBeNull()
    expect(screen.getByTestId("goal-config-save")).toBeDisabled()
  })

  it("confirms a successful save with a toast", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    fireEvent.change(screen.getByTestId("goal-config-max-turns"), { target: { value: "30" } })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Settings saved"))
  })

  it("saves through useGoalControls: a runtime failure is reported once, never as saved", async () => {
    const g = await createTestGoal()
    const spy = jest
      .spyOn(getGoalRuntime(), "updateConfig")
      .mockRejectedValueOnce(new Error("write refused"))
    render(<GoalSettingsTab goal={g} />)
    fireEvent.change(screen.getByTestId("goal-config-max-turns"), { target: { value: "30" } })
    fireEvent.click(screen.getByTestId("goal-config-save"))
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith("Couldn't update the goal", {
        description: "write refused",
      })
    )
    expect(spy).toHaveBeenCalledWith(g.id, expect.objectContaining({ maxTurns: 30 }))
    expect(toastSuccessMock).not.toHaveBeenCalled()
    // The draft is kept so the save can be retried.
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()
    spy.mockRestore()
  })

  it("ignores save invocations when nothing is dirty (handleSave guard branch)", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    const save = screen.getByTestId("goal-config-save")
    // Even though the click is rejected at the button level (disabled), the
    // guard inside handleSave returns early — this exercise hits that branch.
    fireEvent.click(save)
    const fresh = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    expect(fresh.config).toEqual(g.config)
  })

  it("rebinds draft state when the goal prop changes", async () => {
    const g1 = await createTestGoal()
    const { rerender } = render(<GoalSettingsTab goal={g1} />)
    const turns = screen.getByTestId("goal-config-max-turns") as HTMLInputElement
    fireEvent.change(turns, { target: { value: "99" } })
    expect(turns.value).toBe("99")
    // Swap to a different goal — draft should reset to that goal's config.
    const g2 = await getGoalRuntime().createGoal({
      sessionId: "ses_b",
      rawObjective: "another",
    })
    rerender(<GoalSettingsTab goal={g2} />)
    const turnsAfter = screen.getByTestId("goal-config-max-turns") as HTMLInputElement
    expect(turnsAfter.value).toBe(String(g2.config.maxTurns))
  })

  it("inline stop condition empty string becomes undefined on save", async () => {
    const g = await createTestGoal()
    // First set an inline stop, then clear it back to "".
    await getGoalRuntime().updateConfig(g.id, { inlineStopCondition: "or after 3" })
    const fresh = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    render(<GoalSettingsTab goal={fresh} />)
    const input = screen.getByTestId("goal-config-inline-stop") as HTMLInputElement
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.click(screen.getByTestId("goal-config-save"))
    await waitFor(async () => {
      const after = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
      expect(after.config.inlineStopCondition).toBeUndefined()
    })
  })

  it("falls back to previous draft value when a numeric input is cleared", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    const turns = screen.getByTestId("goal-config-max-turns") as HTMLInputElement
    fireEvent.change(turns, { target: { value: "" } })
    // The component coerces NaN back to the previous draft value, so the
    // visible value matches the prior state.
    expect(Number(turns.value)).toBe(g.config.maxTurns)
  })

  it("persists an immutable published Workflow verifier binding", async () => {
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    fireEvent.click(screen.getByTestId("select-verifier"))
    fireEvent.click(screen.getByTestId("goal-config-save"))
    await waitFor(async () => {
      const fresh = await getGoalRuntime().listGoalsBySession("ses_a")
      expect(fresh[0]?.config.verificationWorkflow).toMatchObject({
        workflowId: "wf-1",
        versionId: "wfv-1",
        deploymentId: "wfd-1",
        deploymentRevision: 1,
      })
    })
  })

  async function goalWithVerifier(): Promise<Goal> {
    const g = await createTestGoal()
    await getGoalRuntime().updateConfig(g.id, {
      verificationWorkflow: {
        workflowId: "wf-1",
        versionId: "wfv-1",
        deploymentId: "wfd-1",
        deploymentRevision: 1,
      },
    })
    return (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
  }

  it("asks in a dialog (not window.confirm) before removing a verifier, then resumes active", async () => {
    const user = userEvent.setup()
    const fresh = await goalWithVerifier()
    const confirm = jest.spyOn(window, "confirm")
    render(<GoalSettingsTab goal={fresh} />)
    await user.click(screen.getByTestId("clear-verifier"))
    await user.click(screen.getByTestId("goal-config-save"))
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Remove the completion verifier?")
    // Nothing is written until the user confirms.
    expect(
      (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!.config.verificationWorkflow
    ).toBeDefined()
    await user.click(screen.getByRole("button", { name: "Remove verifier" }))
    await waitFor(async () => {
      const updated = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
      expect(updated.config.verificationWorkflow).toBeUndefined()
      expect(updated.status).toBe("active")
    })
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it("cancelling the verifier dialog keeps the verifier", async () => {
    const user = userEvent.setup()
    const fresh = await goalWithVerifier()
    render(<GoalSettingsTab goal={fresh} />)
    await user.click(screen.getByTestId("clear-verifier"))
    await user.click(screen.getByTestId("goal-config-save"))
    await screen.findByRole("alertdialog")
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    const after = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    expect(after.config.verificationWorkflow).toMatchObject({ workflowId: "wf-1" })
  })
})

it("toggles requireAcceptance and persists it through the runtime", async () => {
  const g = await createTestGoal()
  render(<GoalSettingsTab goal={g} />)
  fireEvent.click(screen.getByTestId("goal-config-require-acceptance"))
  fireEvent.click(screen.getByTestId("goal-config-save"))
  await waitFor(async () => {
    const fresh = await getGoalRuntime().listGoalsBySession("ses_a")
    expect(fresh[0]?.config.requireAcceptance).toBe(true)
  })
})

async function goalWithFailedVerification(): Promise<Goal> {
  const g = await createTestGoal()
  await getGoalRuntime().updateConfig(g.id, {
    verificationWorkflow: {
      workflowId: "wf-1",
      versionId: "wfv-1",
      deploymentId: "wfd-1",
      deploymentRevision: 1,
    },
  })
  const { updateGoal } = await import("@/lib/db/goals")
  await updateGoal(g.id, {
    status: "paused",
    verification: {
      attempt: 1,
      status: "failed",
      idempotencyKey: "k1",
      generationId: g.generationId,
      failureCount: 1,
      candidateSummary: "done",
      summary: "tests fail",
      updatedAt: 1,
    },
  })
  return (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
}

describe("GoalSettingsTab — verifier retry on this host", () => {
  it("retries through the verifier module and toasts a pass", async () => {
    const user = userEvent.setup()
    retryMock.mockResolvedValueOnce({ kind: "passed", result: { passed: true, summary: "ok" } })
    const g = await goalWithFailedVerification()
    render(<GoalSettingsTab goal={g} />)
    await user.click(screen.getByRole("button", { name: "Retry verification" }))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Verification passed"))
    expect(retryMock).toHaveBeenCalledWith(g.id)
    expect(callMock).not.toHaveBeenCalled()
  })

  it("says what the verifier said when the retry fails again", async () => {
    const user = userEvent.setup()
    retryMock.mockResolvedValueOnce({
      kind: "failed",
      result: { passed: false, summary: "still failing" },
      failureCount: 2,
      paused: true,
    })
    render(<GoalSettingsTab goal={await goalWithFailedVerification()} />)
    await user.click(screen.getByRole("button", { name: "Retry verification" }))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("still failing"))
  })
})

describe("GoalSettingsTab — on a paired phone", () => {
  beforeEach(() => {
    mockShell.platform = "mobile"
  })

  it("offers the verifier picker with the remote-control grant", async () => {
    render(<GoalSettingsTab goal={await createTestGoal()} />)
    expect(screen.getByTestId("verifier-picker")).toHaveAttribute("data-disabled", "false")
  })

  it.each([false, "unknown"] as const)(
    "keeps the form and the retry read-only without the grant (%s)",
    async (grant) => {
      mockShell.grant = grant
      render(<GoalSettingsTab goal={await goalWithFailedVerification()} />)
      expect(screen.getByTestId("verifier-picker")).toHaveAttribute("data-disabled", "true")
      expect(screen.getByRole("button", { name: "Retry verification" })).toBeDisabled()
      expect(screen.getByTestId("goal-config-max-turns")).toBeDisabled()
    }
  )

  it("saves a chosen verifier to the desktop over goal_update", async () => {
    const user = userEvent.setup()
    const g = await createTestGoal()
    render(<GoalSettingsTab goal={g} />)
    await user.click(screen.getByTestId("select-verifier"))
    await user.click(screen.getByTestId("goal-config-save"))
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("goal_update", {
        goalId: g.id,
        config: expect.objectContaining({
          verificationWorkflow: expect.objectContaining({ versionId: "wfv-1" }),
        }),
      })
    )
    // The phone's own copy is untouched; the desktop's lands by sync.
    const local = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    expect(local.config.verificationWorkflow).toBeUndefined()
  })

  it("removes the verifier on the desktop with an explicit null", async () => {
    const user = userEvent.setup()
    const g = await goalWithFailedVerification()
    render(<GoalSettingsTab goal={g} />)
    await user.click(screen.getByTestId("clear-verifier"))
    await user.click(screen.getByTestId("goal-config-save"))
    await user.click(await screen.findByRole("button", { name: "Remove verifier" }))
    await waitFor(() =>
      expect(callMock).toHaveBeenCalledWith("goal_update", {
        goalId: g.id,
        config: { verificationWorkflow: null },
      })
    )
    const local = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    expect(local.config.verificationWorkflow).toBeDefined()
  })

  it("retries the verifier on the desktop and toasts its outcome", async () => {
    const user = userEvent.setup()
    callMock.mockResolvedValueOnce({
      state: "settled",
      outcome: { kind: "passed", result: { passed: true, summary: "ok" } },
    })
    const g = await goalWithFailedVerification()
    render(<GoalSettingsTab goal={g} />)
    await user.click(screen.getByRole("button", { name: "Retry verification" }))
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalledWith("Verification passed"))
    expect(callMock).toHaveBeenCalledWith("goal_verify_retry", { goalId: g.id })
    expect(retryMock).not.toHaveBeenCalled()
  })

  it("says the verifier is still running when the desktop answers before it finishes", async () => {
    const user = userEvent.setup()
    callMock.mockResolvedValueOnce({ state: "running" })
    render(<GoalSettingsTab goal={await goalWithFailedVerification()} />)
    await user.click(screen.getByRole("button", { name: "Retry verification" }))
    await waitFor(() =>
      expect(toastInfoMock).toHaveBeenCalledWith(
        "Verification is still running on the desktop. Its result will show here when it finishes."
      )
    )
    expect(screen.getByRole("button", { name: "Retry verification" })).toBeEnabled()
  })
})
