/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  DEFAULT_STEP_DRAFT,
  PlanComposerDialog,
  buildStepParams,
  parseStepLines,
  stepDraftFromStep,
} from "./plan-composer-dialog"
import type { AgentPlan, CreatePlanInput } from "@/types/agent/plan"
import { DEFAULT_PLAN_CONFIG } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const createPlan = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ createPlan: (...a: unknown[]) => createPlan(...a) }),
}))

const applyPlanComposerEdit = jest.fn()
jest.mock("@/lib/agent/plan/draft-edit", () => {
  class PlanEditValidationError extends Error {
    constructor(
      readonly reason: string,
      readonly stepIndex?: number
    ) {
      super(reason)
    }
  }
  return {
    PlanEditValidationError,
    applyPlanComposerEdit: (...a: unknown[]) => applyPlanComposerEdit(...a),
  }
})

const loadPlanConfigDefaults = jest.fn()
jest.mock("@/lib/agent/plan/plan-settings", () => ({
  loadPlanConfigDefaults: () => loadPlanConfigDefaults(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  createPlan.mockResolvedValue({ id: "p_new" })
  loadPlanConfigDefaults.mockResolvedValue(undefined)
})

describe("parseStepLines", () => {
  it("keeps one non-empty trimmed step per line", () => {
    expect(parseStepLines("  a  \n\n b \n")).toEqual(["a", "b"])
  })

  it("strips list markers so pasted markdown works", () => {
    expect(parseStepLines("- a\n* b\n1. c\n2) d")).toEqual(["a", "b", "c", "d"])
  })

  it("drops lines that are nothing but a marker", () => {
    expect(parseStepLines("- \n- real")).toEqual(["real"])
  })

  it("truncates an over-long step", () => {
    expect(parseStepLines("x".repeat(300))[0]).toHaveLength(200)
  })

  it("returns an empty list for blank input", () => {
    expect(parseStepLines("   \n\n ")).toEqual([])
  })
})

// The dispatcher implements six step kinds; before this the composer could
// only ever emit `agent_turn`, so the other five were unreachable from the UI.
describe("buildStepParams", () => {
  it("leaves a bare agent turn without params", () => {
    expect(buildStepParams(DEFAULT_STEP_DRAFT)).toEqual({ params: undefined })
  })

  it("carries an explicit agent-turn prompt", () => {
    expect(buildStepParams({ kind: "agent_turn", prompt: " go " })).toEqual({
      params: { kind: "agent_turn", prompt: "go" },
    })
  })

  it("requires a team for delegation and keeps the teammate optional", () => {
    expect(buildStepParams({ kind: "teammate_dispatch" })).toEqual({ error: "missing" })
    expect(buildStepParams({ kind: "teammate_dispatch", teamId: "t1" })).toEqual({
      params: { kind: "teammate_dispatch", teamId: "t1" },
    })
    expect(
      buildStepParams({ kind: "teammate_dispatch", teamId: "t1", teammateId: "m1", prompt: "do" })
    ).toEqual({
      params: { kind: "teammate_dispatch", teamId: "t1", teammateId: "m1", spawnPrompt: "do" },
    })
  })

  it("requires a workflow id for a sub-workflow step", () => {
    expect(buildStepParams({ kind: "sub_workflow" })).toEqual({ error: "missing" })
    expect(buildStepParams({ kind: "sub_workflow", workflowId: "wf1" })).toEqual({
      params: { kind: "sub_workflow", workflowId: "wf1" },
    })
  })

  it("defaults a tool call's input to an empty object and rejects bad JSON", () => {
    expect(buildStepParams({ kind: "tool_call" })).toEqual({ error: "missing" })
    expect(buildStepParams({ kind: "tool_call", toolName: "fs.read" })).toEqual({
      params: { kind: "tool_call", toolName: "fs.read", input: {} },
    })
    expect(buildStepParams({ kind: "tool_call", toolName: "fs.read", toolInput: "{" })).toEqual({
      error: "json",
    })
    // A JSON array parses but is not a tool-input object.
    expect(buildStepParams({ kind: "tool_call", toolName: "fs.read", toolInput: "[1]" })).toEqual({
      error: "json",
    })
  })

  it("requires both a server and a tool for an MCP call", () => {
    expect(buildStepParams({ kind: "mcp_tool_call", toolName: "t" })).toEqual({ error: "missing" })
    expect(buildStepParams({ kind: "mcp_tool_call", serverId: "s" })).toEqual({ error: "missing" })
    expect(
      buildStepParams({ kind: "mcp_tool_call", serverId: "s", toolName: "t", toolInput: '{"a":1}' })
    ).toEqual({ params: { kind: "mcp_tool_call", serverId: "s", toolName: "t", input: { a: 1 } } })
  })

  it("treats an approval gate prompt as optional", () => {
    expect(buildStepParams({ kind: "approval_gate" })).toEqual({ params: undefined })
    expect(buildStepParams({ kind: "approval_gate", prompt: "ok?" })).toEqual({
      params: { kind: "approval_gate", prompt: "ok?" },
    })
  })
})

describe("PlanComposerDialog", () => {
  function setup(over: Partial<React.ComponentProps<typeof PlanComposerDialog>> = {}) {
    const onOpenChange = jest.fn()
    const onCreated = jest.fn()
    render(
      <PlanComposerDialog
        sessionId="ses_a"
        characterId="char_1"
        open
        onOpenChange={onOpenChange}
        onCreated={onCreated}
        {...over}
      />
    )
    return { onOpenChange, onCreated }
  }

  it("keeps create disabled until there is a title AND at least one step", async () => {
    const user = userEvent.setup()
    setup()
    const create = screen.getByTestId("plan-composer-create")
    expect(create).toBeDisabled()

    await user.type(screen.getByLabelText("titleLabel"), "Ship v2")
    expect(create).toBeDisabled()

    await user.type(screen.getByLabelText("stepsLabel"), "write the changelog")
    expect(create).toBeEnabled()
  })

  it("creates a linear manual plan and closes", async () => {
    const user = userEvent.setup()
    const { onOpenChange, onCreated } = setup()
    await user.type(screen.getByLabelText("titleLabel"), "Ship v2")
    await user.type(screen.getByLabelText("stepsLabel"), "one{Enter}two{Enter}three")
    await user.click(screen.getByTestId("plan-composer-create"))

    await waitFor(() => expect(createPlan).toHaveBeenCalled())
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.source).toBe("manual")
    expect(input.sessionId).toBe("ses_a")
    expect(input.characterId).toBe("char_1")
    expect(input.title).toBe("Ship v2")
    expect(input.steps.map((s) => s.title)).toEqual(["one", "two", "three"])
    expect(input.steps[0].dependsOn).toBeUndefined()
    expect(input.steps[2].dependsOn).toEqual([1])
    expect(onCreated).toHaveBeenCalledWith("p_new")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("emits a typed step when a kind is picked, and blocks submit until it is valid", async () => {
    const user = userEvent.setup()
    setup()
    await user.type(screen.getByLabelText("titleLabel"), "Ship v2")
    await user.type(screen.getByLabelText("stepsLabel"), "hand off{Enter}wrap up")

    // Radix Select needs a keyboard-driven open in jsdom (no pointer geometry).
    fireEvent.keyDown(screen.getByTestId("plan-step-0-kind"), { key: "Enter" })
    fireEvent.click(await screen.findByRole("option", { name: "kind.teammate_dispatch" }))

    // A delegation step without a team is incomplete — the guard must hold.
    expect(screen.getByTestId("plan-composer-invalid")).toBeInTheDocument()
    expect(screen.getByTestId("plan-composer-create")).toBeDisabled()

    await user.type(screen.getByTestId("plan-step-0-teamId"), "team_7")
    expect(screen.queryByTestId("plan-composer-invalid")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("plan-composer-create"))

    await waitFor(() => expect(createPlan).toHaveBeenCalled())
    const input = createPlan.mock.calls[0][0] as CreatePlanInput
    expect(input.steps[0]).toMatchObject({
      title: "hand off",
      kind: "teammate_dispatch",
      params: { kind: "teammate_dispatch", teamId: "team_7" },
    })
    // Untouched rows stay plain agent turns, deps intact.
    expect(input.steps[1]).toMatchObject({ title: "wrap up", kind: "agent_turn", dependsOn: [0] })
  })

  it("merges the user's plan defaults into the created plan", async () => {
    loadPlanConfigDefaults.mockResolvedValue({ requireApproval: false })
    const user = userEvent.setup()
    setup()
    await user.type(screen.getByLabelText("titleLabel"), "T")
    await user.type(screen.getByLabelText("stepsLabel"), "a")
    await user.click(screen.getByTestId("plan-composer-create"))
    await waitFor(() => expect(createPlan).toHaveBeenCalled())
    expect((createPlan.mock.calls[0][0] as CreatePlanInput).config).toEqual({
      requireApproval: false,
    })
  })

  it("surfaces a toast and stays open when the write fails", async () => {
    createPlan.mockRejectedValue(new Error("dexie down"))
    const user = userEvent.setup()
    const { onOpenChange } = setup()
    await user.type(screen.getByLabelText("titleLabel"), "T")
    await user.type(screen.getByLabelText("stepsLabel"), "a")
    await user.click(screen.getByTestId("plan-composer-create"))

    await waitFor(() => expect(toastError).toHaveBeenCalledWith("createFailed"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByTestId("plan-composer-create")).toBeEnabled()
  })

  it("omits characterId when the session has no character bound", async () => {
    const user = userEvent.setup()
    setup({ characterId: undefined })
    await user.type(screen.getByLabelText("titleLabel"), "T")
    await user.type(screen.getByLabelText("stepsLabel"), "a")
    await user.click(screen.getByTestId("plan-composer-create"))
    await waitFor(() => expect(createPlan).toHaveBeenCalled())
    expect(createPlan.mock.calls[0][0]).not.toHaveProperty("characterId")
  })

  it("cancel discards the draft, so reopening starts empty", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup()
    await user.type(screen.getByLabelText("titleLabel"), "Ship v2")
    await user.type(screen.getByLabelText("stepsLabel"), "one")
    await user.click(screen.getByText("cancel"))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(createPlan).not.toHaveBeenCalled()
    expect(screen.getByLabelText("titleLabel")).toHaveValue("")
    expect(screen.getByLabelText("stepsLabel")).toHaveValue("")
  })

  it("renders nothing while closed", () => {
    setup({ open: false })
    expect(screen.queryByTestId("plan-composer-dialog")).not.toBeInTheDocument()
  })
})

describe("buildStepParams — editor_review", () => {
  it("requires both the file and the proposal", () => {
    // Unlike the optional-prompt kinds there is no derive-from-title fallback:
    // without a path and contents there is nothing to review.
    expect(buildStepParams({ kind: "editor_review" })).toEqual({ error: "missing" })
    expect(buildStepParams({ kind: "editor_review", path: "src/a.ts" })).toEqual({
      error: "missing",
    })
    expect(buildStepParams({ kind: "editor_review", content: "next" })).toEqual({
      error: "missing",
    })
  })

  it("accepts an empty proposal — that is 'empty this file', not a blank field", () => {
    expect(buildStepParams({ kind: "editor_review", path: "src/a.ts", content: "" })).toEqual({
      params: { kind: "editor_review", path: "src/a.ts", content: "" },
    })
  })

  it("carries the optional title and prompt through", () => {
    expect(
      buildStepParams({
        kind: "editor_review",
        path: "src/a.ts",
        content: "next",
        title: "Proposed fix",
        prompt: "Does this look right?",
      })
    ).toEqual({
      params: {
        kind: "editor_review",
        path: "src/a.ts",
        content: "next",
        title: "Proposed fix",
        prompt: "Does this look right?",
      },
    })
  })
})

describe("stepDraftFromStep", () => {
  it("round-trips every kind's params back into editable fields", () => {
    expect(stepDraftFromStep({ kind: "agent_turn" })).toEqual({ kind: "agent_turn" })
    expect(
      stepDraftFromStep({
        kind: "teammate_dispatch",
        params: { kind: "teammate_dispatch", teamId: "t", spawnPrompt: "go" },
      })
    ).toEqual({ kind: "teammate_dispatch", teamId: "t", prompt: "go" })
    expect(
      stepDraftFromStep({
        kind: "tool_call",
        params: { kind: "tool_call", toolName: "x", input: { a: 1 } },
      })
    ).toEqual({ kind: "tool_call", toolName: "x", toolInput: '{"a":1}' })
    expect(
      stepDraftFromStep({
        kind: "mcp_tool_call",
        params: { kind: "mcp_tool_call", serverId: "s", toolName: "t" },
      })
    ).toEqual({ kind: "mcp_tool_call", serverId: "s", toolName: "t" })
    expect(
      stepDraftFromStep({ kind: "sub_workflow", params: { kind: "sub_workflow", workflowId: "w" } })
    ).toEqual({ kind: "sub_workflow", workflowId: "w" })
    expect(
      stepDraftFromStep({
        kind: "editor_review",
        params: { kind: "editor_review", path: "a.ts", content: "", title: "T" },
      })
    ).toEqual({ kind: "editor_review", path: "a.ts", content: "", title: "T" })
    // A draft rebuilt from its own step validates to the same params.
    const draft = stepDraftFromStep({
      kind: "approval_gate",
      params: { kind: "approval_gate", prompt: "ok?" },
    })
    expect(buildStepParams(draft)).toEqual({ params: { kind: "approval_gate", prompt: "ok?" } })
  })
})

describe("PlanComposerDialog — edit mode", () => {
  const editPlan: AgentPlan = {
    id: "p_edit",
    sessionId: "ses",
    title: "Existing plan",
    source: "manual",
    executionMode: "auto",
    status: "awaiting_approval",
    steps: [
      {
        id: "b",
        title: "second",
        kind: "agent_turn",
        status: "pending",
        order: 1,
        dependencies: ["a"],
      },
      {
        id: "a",
        title: "first",
        kind: "agent_turn",
        status: "pending",
        order: 0,
        dependencies: [],
      },
    ],
    totalSteps: 2,
    completedSteps: 0,
    config: DEFAULT_PLAN_CONFIG,
    refinementCount: 0,
    generationId: "g",
    createdAt: 0,
    updatedAt: 0,
  }

  it("opens pre-filled with the plan's title and ordered steps", () => {
    render(<PlanComposerDialog sessionId="ses" open onOpenChange={jest.fn()} editPlan={editPlan} />)
    expect(screen.getByText("editTitle")).toBeInTheDocument()
    expect(screen.getByLabelText("titleLabel")).toHaveValue("Existing plan")
    expect(screen.getByLabelText("stepsLabel")).toHaveValue("first\nsecond")
    expect(screen.queryByTestId("plan-composer-create")).not.toBeInTheDocument()
  })

  it("saves the amended plan in place and closes", async () => {
    applyPlanComposerEdit.mockResolvedValue(null)
    const onOpenChange = jest.fn()
    const onSaved = jest.fn()
    render(
      <PlanComposerDialog
        sessionId="ses"
        open
        onOpenChange={onOpenChange}
        editPlan={editPlan}
        onSaved={onSaved}
      />
    )
    fireEvent.change(screen.getByLabelText("stepsLabel"), {
      target: { value: "first\nsecond, reworded\nthird" },
    })
    await userEvent.click(screen.getByTestId("plan-composer-save"))
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("p_edit"))
    expect(applyPlanComposerEdit).toHaveBeenCalledWith(editPlan, {
      title: "Existing plan",
      steps: [
        { title: "first", kind: "agent_turn" },
        { title: "second, reworded", kind: "agent_turn" },
        { title: "third", kind: "agent_turn" },
      ],
    })
    expect(createPlan).not.toHaveBeenCalled()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keeps the dialog open with a toast when re-validation refuses the edit", async () => {
    const { PlanEditValidationError } = jest.requireMock("@/lib/agent/plan/draft-edit")
    applyPlanComposerEdit.mockRejectedValue(new PlanEditValidationError("invalid_step", 2))
    const onOpenChange = jest.fn()
    render(
      <PlanComposerDialog sessionId="ses" open onOpenChange={onOpenChange} editPlan={editPlan} />
    )
    await userEvent.click(screen.getByTestId("plan-composer-save"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("invalidStep"))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("reports a generic save failure", async () => {
    applyPlanComposerEdit.mockRejectedValue(new Error("db down"))
    render(<PlanComposerDialog sessionId="ses" open onOpenChange={jest.fn()} editPlan={editPlan} />)
    await userEvent.click(screen.getByTestId("plan-composer-save"))
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("saveFailed"))
  })
})
