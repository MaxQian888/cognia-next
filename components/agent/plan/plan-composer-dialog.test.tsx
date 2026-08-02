/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { PlanComposerDialog, parseStepLines } from "./plan-composer-dialog"
import type { CreatePlanInput } from "@/types/agent/plan"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const toastError = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastError(...a) } }))

const createPlan = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ createPlan: (...a: unknown[]) => createPlan(...a) }),
}))

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
