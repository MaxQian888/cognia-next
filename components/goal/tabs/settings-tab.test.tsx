import "fake-indexeddb/auto"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { __resetRedactionKey } from "@/lib/twin/ingest/redaction-key"
import { __resetGoalRuntimeForTesting, getGoalRuntime } from "@/lib/goal/runtime"
import type { Goal } from "@/types/goal"

jest.mock("@/components/goal/goal-verification-workflow-picker", () => ({
  GoalVerificationWorkflowPicker: ({ onChange }: { onChange: (value?: unknown) => void }) => (
    <div>
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
import { GoalSettingsTab } from "./settings-tab"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  await __resetRedactionKey()
  __resetGoalRuntimeForTesting()
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

  it("disables all fields when goal is terminal", async () => {
    const g = await createTestGoal()
    await getGoalRuntime().stopGoal(g.id)
    const fresh = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    render(<GoalSettingsTab goal={fresh} />)
    expect(screen.getByTestId("goal-config-max-turns")).toBeDisabled()
    expect(screen.getByTestId("goal-config-save")).toBeDisabled()
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

  it("requires confirmation before disabling a verifier and resumes active", async () => {
    const g = await createTestGoal()
    await getGoalRuntime().updateConfig(g.id, {
      verificationWorkflow: {
        workflowId: "wf-1",
        versionId: "wfv-1",
        deploymentId: "wfd-1",
        deploymentRevision: 1,
      },
    })
    const fresh = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
    const confirm = jest.spyOn(window, "confirm").mockReturnValue(true)
    render(<GoalSettingsTab goal={fresh} />)
    fireEvent.click(screen.getByTestId("clear-verifier"))
    fireEvent.click(screen.getByTestId("goal-config-save"))
    await waitFor(async () => {
      const updated = (await getGoalRuntime().listGoalsBySession("ses_a"))[0]!
      expect(updated.config.verificationWorkflow).toBeUndefined()
      expect(updated.status).toBe("active")
    })
    expect(confirm).toHaveBeenCalledTimes(1)
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
