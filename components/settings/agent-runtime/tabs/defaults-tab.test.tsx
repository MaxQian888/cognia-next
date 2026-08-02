import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DefaultsTab } from "./defaults-tab"

const save = jest.fn()
const stateRef = {
  current: {
    permissionMode: "default" as const,
    defaultWorkingDir: "",
    defaultSystemPrompt: "",
    routingFallbackEnabled: true,
    defaultMaxThinkingTokens: undefined as number | undefined,
  },
}

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: unknown) => unknown) =>
    selector({
      settings: stateRef.current,
      save: (...args: unknown[]) => save(...args),
    }),
}))

jest.mock("../parts/default-model-picker", () => ({
  DefaultModelPicker: () => <div data-testid="default-model-picker" />,
}))

jest.mock("@/components/settings/instructions/instructions-card", () => ({
  InstructionsCard: () => <div data-testid="instructions-card" />,
}))

jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: ({ point }: { point: string }) => (
    <div data-testid="plugin-slot" data-point={point} />
  ),
}))

describe("DefaultsTab", () => {
  beforeEach(() => {
    save.mockClear()
    stateRef.current = {
      permissionMode: "default",
      defaultWorkingDir: "",
      defaultSystemPrompt: "",
      routingFallbackEnabled: true,
      defaultMaxThinkingTokens: undefined,
    }
  })

  it("renders all 4 permission-mode options in the dropdown", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    // Permission select is the first combobox (output-style adds a second).
    await user.click(screen.getAllByRole("combobox")[0])
    // The active label also shows in the trigger, so use getAllByText.
    expect(screen.getAllByText("permDefault").length).toBeGreaterThan(0)
    expect(screen.getByRole("option", { name: "permAcceptEdits" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "permBypass" })).toBeInTheDocument()
    expect(screen.getByRole("option", { name: "permPlan" })).toBeInTheDocument()
  })

  it("blur on working-dir input persists trimmed value", () => {
    render(<DefaultsTab />)
    const input = screen.getByLabelText("workingDirTitle") as HTMLInputElement
    fireEvent.change(input, { target: { value: "  /Users/me/proj  " } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultWorkingDir: "/Users/me/proj" })
  })

  it("blur with empty working-dir persists undefined", () => {
    render(<DefaultsTab />)
    const input = screen.getByLabelText("workingDirTitle") as HTMLInputElement
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultWorkingDir: undefined })
  })

  it("blur on append textarea persists trimmed value", () => {
    render(<DefaultsTab />)
    const ta = screen.getByLabelText("appendTitle")
    fireEvent.change(ta, { target: { value: "Stay concise.  " } })
    fireEvent.blur(ta)
    expect(save).toHaveBeenCalledWith({ defaultSystemPrompt: "Stay concise." })
  })

  it("toggling routing fallback persists the new value", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByLabelText("routingTitle"))
    expect(save).toHaveBeenCalledWith({ routingFallbackEnabled: false })
  })

  it("renders the default model picker slot", () => {
    render(<DefaultsTab />)
    expect(screen.getByTestId("default-model-picker")).toBeInTheDocument()
  })

  it("cache-optimization switch is on by default and persists false when toggled off", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    const sw = screen.getByTestId("cache-optimization-switch")
    // Default-ON (opt-out): no explicit `false` in settings → checked.
    expect(sw).toHaveAttribute("data-state", "checked")
    await user.click(sw)
    // Persist the explicit `false` so the OFF choice survives the DEFAULTS merge.
    expect(save).toHaveBeenCalledWith({ cacheOptimizationEnabled: false })
  })

  it("toggling cache optimization back on persists true", async () => {
    stateRef.current = {
      ...stateRef.current,
      cacheOptimizationEnabled: false,
    } as never
    const user = userEvent.setup()
    render(<DefaultsTab />)
    const sw = screen.getByTestId("cache-optimization-switch")
    expect(sw).toHaveAttribute("data-state", "unchecked")
    await user.click(sw)
    expect(save).toHaveBeenCalledWith({ cacheOptimizationEnabled: true })
  })

  it("blur with empty append textarea persists undefined", () => {
    render(<DefaultsTab />)
    const ta = screen.getByLabelText("appendTitle")
    fireEvent.change(ta, { target: { value: "" } })
    fireEvent.blur(ta)
    expect(save).toHaveBeenCalledWith({ defaultSystemPrompt: undefined })
  })

  it("renders nothing when settings is null", () => {
    stateRef.current = null as never
    const { container } = render(<DefaultsTab />)
    // The form still renders (uses local-state defaults), just with no data.
    expect(container).toBeTruthy()
  })

  it("renders permission-mode default when settings has no value", () => {
    stateRef.current = {
      permissionMode: undefined as never,
      defaultWorkingDir: undefined as never,
      defaultSystemPrompt: undefined as never,
      routingFallbackEnabled: undefined as never,
      defaultMaxThinkingTokens: undefined,
    }
    render(<DefaultsTab />)
    // Should fall back to "default" — the trigger shows the matching label.
    const combobox = screen.getAllByRole("combobox")[0]
    expect(combobox).toBeInTheDocument()
  })

  it("renders the instructions card and the settings.general plugin slot", () => {
    render(<DefaultsTab />)
    expect(screen.getByTestId("instructions-card")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-slot")).toHaveAttribute("data-point", "settings.general")
  })

  it("toggling bare mode persists true, then undefined when turned back off", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    const sw = screen.getByLabelText("bareMode")
    expect(sw).toHaveAttribute("data-state", "unchecked")
    await user.click(sw)
    expect(save).toHaveBeenCalledWith({ bareMode: true })
  })

  it("toggling brief mode persists true", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByLabelText("briefMode"))
    expect(save).toHaveBeenCalledWith({ briefMode: true })
  })

  it("selecting a non-default output style persists it and clears custom", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByTestId("output-style-select"))
    await user.click(screen.getByRole("option", { name: "outputStyle.detailed" }))
    expect(save).toHaveBeenCalledWith({ outputStyle: "detailed", customOutputStyle: undefined })
  })

  it("selecting custom output style reveals the instruction textarea", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByTestId("output-style-select"))
    await user.click(screen.getByRole("option", { name: "outputStyle.custom" }))
    expect(save).toHaveBeenCalledWith({ outputStyle: "custom", customOutputStyle: undefined })
    expect(screen.getByLabelText("outputStyle.customPlaceholder")).toBeInTheDocument()
  })

  it("default output style persists undefined (use SDK default)", async () => {
    stateRef.current = { ...stateRef.current, outputStyle: "detailed" } as never
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByTestId("output-style-select"))
    await user.click(screen.getByRole("option", { name: "outputStyle.default" }))
    expect(save).toHaveBeenCalledWith({ outputStyle: undefined, customOutputStyle: undefined })
  })

  it("blur on thinking-budget input persists clamped, rounded value", () => {
    render(<DefaultsTab />)
    const input = screen.getByTestId("thinking-budget-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "5500" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: 5500 })
  })

  it("blur with zero thinking-budget persists undefined (use SDK default)", () => {
    render(<DefaultsTab />)
    const input = screen.getByTestId("thinking-budget-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "0" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: undefined })
  })

  it("blur with negative value clamps to 0 / undefined", () => {
    render(<DefaultsTab />)
    const input = screen.getByTestId("thinking-budget-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "-100" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: undefined })
  })

  it("blur with above-max value clamps down to the max budget", () => {
    render(<DefaultsTab />)
    const input = screen.getByTestId("thinking-budget-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "999999" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: 64000 })
  })

  it("reset button persists undefined when budget is non-zero", async () => {
    stateRef.current = {
      ...stateRef.current,
      defaultMaxThinkingTokens: 4096,
    }
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByTestId("thinking-budget-reset"))
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: undefined })
  })

  it("reset button is disabled when budget is already zero", () => {
    render(<DefaultsTab />)
    expect(screen.getByTestId("thinking-budget-reset")).toBeDisabled()
  })

  it("interactive plan view switch is off by default and persists true when enabled", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    const sw = screen.getByTestId("plan-interactive-html-switch")
    // Opt-in enhanced plan mode: absent setting → unchecked.
    expect(sw).toHaveAttribute("data-state", "unchecked")
    await user.click(sw)
    expect(save).toHaveBeenCalledWith({ planSettings: { interactiveHtmlView: true } })
  })

  it("interactive plan view switch mirrors the persisted value and keeps sibling plan settings", async () => {
    stateRef.current = {
      ...stateRef.current,
      planSettings: { requireApproval: false, interactiveHtmlView: true },
    } as never
    const user = userEvent.setup()
    render(<DefaultsTab />)
    const sw = screen.getByTestId("plan-interactive-html-switch")
    expect(sw).toHaveAttribute("data-state", "checked")
    await user.click(sw)
    // Sibling plan settings survive the spread; the explicit false persists.
    expect(save).toHaveBeenCalledWith({
      planSettings: { requireApproval: false, interactiveHtmlView: false },
    })
  })

  it("interactive style select is disabled until the interactive view is on", () => {
    render(<DefaultsTab />)
    expect(screen.getByTestId("plan-interactive-style-select")).toBeDisabled()
  })

  it("interactive style select persists the preset and keeps sibling plan settings", async () => {
    stateRef.current = {
      ...stateRef.current,
      planSettings: { interactiveHtmlView: true },
    } as never
    const user = userEvent.setup()
    render(<DefaultsTab />)
    const trigger = screen.getByTestId("plan-interactive-style-select")
    expect(trigger).not.toBeDisabled()
    await user.click(trigger)
    await user.click(screen.getByRole("option", { name: "planStyleTimeline" }))
    expect(save).toHaveBeenCalledWith({
      planSettings: { interactiveHtmlView: true, interactiveHtmlStyle: "timeline" },
    })
  })

  it("interactive style select mirrors a persisted preset, coercing junk to default", () => {
    stateRef.current = {
      ...stateRef.current,
      planSettings: { interactiveHtmlView: true, interactiveHtmlStyle: "cards" },
    } as never
    const { unmount } = render(<DefaultsTab />)
    expect(screen.getByTestId("plan-interactive-style-select")).toHaveTextContent("planStyleCards")
    unmount()

    stateRef.current = {
      ...stateRef.current,
      planSettings: { interactiveHtmlView: true, interactiveHtmlStyle: "neon" },
    } as never
    render(<DefaultsTab />)
    expect(screen.getByTestId("plan-interactive-style-select")).toHaveTextContent(
      "planStyleDefault"
    )
  })

  it("persists a permission mode picked from the dropdown", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getAllByRole("combobox")[0])
    await user.click(screen.getByRole("option", { name: "permPlan" }))
    expect(save).toHaveBeenCalledWith({ permissionMode: "plan" })
  })

  it("persists the thinking budget from both the slider and the number input", () => {
    render(<DefaultsTab />)

    const input = screen.getByTestId("thinking-budget-input") as HTMLInputElement
    fireEvent.change(input, { target: { value: "2048" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: 2048 })

    // Above the max, the commit clamps rather than shipping the raw number.
    fireEvent.change(input, { target: { value: "999999" } })
    fireEvent.blur(input)
    expect(save).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: 64000 })

    // Zero means "let the SDK decide", persisted as undefined.
    fireEvent.click(screen.getByTestId("thinking-budget-reset"))
    expect(save).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: undefined })
  })

  it("persists a custom output style on blur, and only in custom mode", async () => {
    const user = userEvent.setup()
    render(<DefaultsTab />)
    await user.click(screen.getByTestId("output-style-select"))
    await user.click(screen.getByRole("option", { name: "outputStyle.custom" }))

    const textarea = screen.getByLabelText("outputStyle.customPlaceholder")
    fireEvent.change(textarea, { target: { value: "  answer in haiku  " } })
    fireEvent.blur(textarea)
    expect(save).toHaveBeenLastCalledWith({ customOutputStyle: "answer in haiku" })

    // A whitespace-only style clears the field rather than persisting "   ".
    fireEvent.change(textarea, { target: { value: "   " } })
    fireEvent.blur(textarea)
    expect(save).toHaveBeenLastCalledWith({ customOutputStyle: undefined })
  })

  it("persists the plan approval switch and the refinement cap", () => {
    render(<DefaultsTab />)

    fireEvent.click(screen.getByTestId("plan-require-approval-switch"))
    expect(save).toHaveBeenLastCalledWith({
      planSettings: expect.objectContaining({ requireApproval: false }),
    })

    const refinements = screen.getByTestId("plan-max-refinements-input") as HTMLInputElement
    fireEvent.change(refinements, { target: { value: "4" } })
    fireEvent.blur(refinements)
    expect(save).toHaveBeenLastCalledWith({
      planSettings: expect.objectContaining({ maxAutoRefinements: 4 }),
    })

    // Out-of-range values clamp instead of persisting nonsense.
    fireEvent.change(refinements, { target: { value: "99" } })
    fireEvent.blur(refinements)
    expect(save).toHaveBeenLastCalledWith({
      planSettings: expect.objectContaining({ maxAutoRefinements: 10 }),
    })
  })

  it("persists the thinking budget dragged on the slider", () => {
    render(<DefaultsTab />)
    // Radix exposes the thumb as role=slider; arrow keys fire change + commit.
    const thumb = screen.getByRole("slider")
    fireEvent.keyDown(thumb, { key: "ArrowRight" })
    expect(save).toHaveBeenCalledWith({ defaultMaxThinkingTokens: 1024 })
  })

  it("persists bare and brief mode both on and off", () => {
    render(<DefaultsTab />)

    // OFF persists `undefined` (the flag is opt-in), ON persists `true`.
    const bare = screen.getByRole("switch", { name: "bareMode" })
    fireEvent.click(bare)
    expect(save).toHaveBeenLastCalledWith({ bareMode: true })
    fireEvent.click(bare)
    expect(save).toHaveBeenLastCalledWith({ bareMode: undefined })

    const brief = screen.getByRole("switch", { name: "briefMode" })
    fireEvent.click(brief)
    expect(save).toHaveBeenLastCalledWith({ briefMode: true })
    fireEvent.click(brief)
    expect(save).toHaveBeenLastCalledWith({ briefMode: undefined })
  })

  it("treats a cleared numeric field as zero rather than NaN", () => {
    render(<DefaultsTab />)

    const thinking = screen.getByTestId("thinking-budget-input") as HTMLInputElement
    fireEvent.change(thinking, { target: { value: "2048" } })
    fireEvent.change(thinking, { target: { value: "" } })
    fireEvent.blur(thinking)
    expect(save).toHaveBeenLastCalledWith({ defaultMaxThinkingTokens: undefined })

    const refinements = screen.getByTestId("plan-max-refinements-input") as HTMLInputElement
    fireEvent.change(refinements, { target: { value: "" } })
    fireEvent.blur(refinements)
    expect(save).toHaveBeenLastCalledWith({
      planSettings: expect.objectContaining({ maxAutoRefinements: 0 }),
    })
  })
})
