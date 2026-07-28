/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SubAgentTemplate } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, speed: 1 }),
}))
jest.mock("@/components/ui/sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() },
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))
jest.mock("@cognia/logging", () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }),
}))
jest.mock("@/components/settings/provider/routing/provider-model-combobox", () => ({
  ProviderModelCombobox: ({ onSelect }: { onSelect: (p: string, m: string) => void }) => (
    <button
      type="button"
      data-testid="stub-model-combobox"
      onClick={() => onSelect("openai", "gpt")}
    >
      pick model
    </button>
  ),
}))
jest.mock("@/lib/ai/agent/external/presets", () => ({
  BUILTIN_EXECUTABLE_PRESET_IDS: ["claude-code"],
  getPresetDisplayInfo: () => ({ name: "Claude Code" }),
}))
jest.mock("../tool-scope-field", () => ({
  ToolScopeField: ({
    label,
    value,
    onChange,
    testId,
  }: {
    label: string
    value: string[] | undefined
    onChange: (v: string[] | undefined) => void
    testId?: string
  }) => (
    <div data-testid={testId}>
      <span data-testid={`${testId}-value`}>{JSON.stringify(value ?? null)}</span>
      <button type="button" data-testid={`${testId}-set`} onClick={() => onChange(["Read"])}>
        {label}
      </button>
    </div>
  ),
}))

let templates: Record<string, SubAgentTemplate> = {}
const addTemplate = jest.fn()
const updateTemplate = jest.fn()
const deleteTemplate = jest.fn()
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ templates, addTemplate, updateTemplate, deleteTemplate }),
}))

let nestingEnabled = false
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { subagentNesting: { enabled: nestingEnabled } } }),
}))

import { TemplatePanel } from "./template-panel"

const tpl = (over: Partial<SubAgentTemplate> & { id: string }): SubAgentTemplate => ({
  name: over.id,
  description: "",
  category: "general",
  taskTemplate: "",
  config: {},
  ...over,
})

const onNavigate = jest.fn()

beforeEach(() => {
  jest.clearAllMocks()
  nestingEnabled = false
  templates = {
    mine: tpl({ id: "mine", name: "My Fork" }),
    seeded: tpl({ id: "seeded", name: "Explore", isBuiltIn: true, taskTemplate: "Look at {{x}}" }),
  }
})

describe("built-in templates", () => {
  it("are read-only and say why, offering the fork instead", () => {
    render(<TemplatePanel templateId="seeded" onNavigate={onNavigate} />)
    expect(screen.queryByTestId("editor-name")).not.toBeInTheDocument()
    expect(screen.getByTestId("template-duplicate")).toBeInTheDocument()
  })

  it("forks into an editable copy and navigates to it", async () => {
    render(<TemplatePanel templateId="seeded" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByTestId("template-duplicate"))
    const copy = addTemplate.mock.calls[0][0] as SubAgentTemplate
    expect(copy.isBuiltIn).toBe(false)
    expect(copy.id).not.toBe("seeded")
    expect(onNavigate).toHaveBeenCalledWith(copy.id)
  })
})

describe("missing template", () => {
  it("degrades to an empty state instead of crashing", () => {
    render(<TemplatePanel templateId="nope" onNavigate={onNavigate} />)
    expect(screen.queryByTestId("editor-name")).not.toBeInTheDocument()
  })
})

describe("availability controls (G1)", () => {
  it("writes `disabled` when the enable switch is turned off", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole("switch", { name: "enabledLabel" }))
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await waitFor(() => expect(updateTemplate).toHaveBeenCalled())
    expect(updateTemplate.mock.calls[0][1]).toMatchObject({ disabled: true })
  })

  it("writes `hidden` from its own switch", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByRole("switch", { name: "hiddenLabel" }))
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await waitFor(() => expect(updateTemplate).toHaveBeenCalled())
    expect(updateTemplate.mock.calls[0][1]).toMatchObject({ hidden: true })
  })

  it("locks the hidden switch once the template is fully disabled", () => {
    templates.mine = tpl({ id: "mine", name: "My Fork", disabled: true })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByRole("switch", { name: "hiddenLabel" })).toBeDisabled()
  })

  it("shows the reachability the resolvers will actually apply", () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByTestId("template-reach-direct")).toBeInTheDocument()
  })
})

describe("silent-override read-outs (G5 / G6)", () => {
  it("warns that a system prompt retires the task template", async () => {
    templates.mine = tpl({
      id: "mine",
      name: "My Fork",
      taskTemplate: "do {{thing}}",
      config: { systemPrompt: "you are..." },
    })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByTestId("template-prompt-shadowed")).toBeInTheDocument()
  })

  it("stays quiet when only a task template is set", () => {
    templates.mine = tpl({ id: "mine", name: "My Fork", taskTemplate: "do {{thing}}" })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.queryByTestId("template-prompt-shadowed")).not.toBeInTheDocument()
  })

  it("names placeholders that were never declared", () => {
    templates.mine = tpl({ id: "mine", name: "My Fork", taskTemplate: "do {{thing}}" })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByTestId("template-vars-undeclared")).toBeInTheDocument()
  })

  it("names declared variables the template never uses", () => {
    templates.mine = tpl({
      id: "mine",
      name: "My Fork",
      taskTemplate: "no placeholders",
      variables: [{ name: "spare", description: "", required: false }],
    })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByTestId("template-vars-unused")).toBeInTheDocument()
  })

  it("explains that pinning a provider removes the template from direct chat", () => {
    templates.mine = tpl({ id: "mine", name: "My Fork", config: { provider: "openai" } })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByTestId("template-reach-dispatch-only")).toBeInTheDocument()
  })

  it("escalates to a blocker while the dispatch rail is switched off", () => {
    nestingEnabled = false
    templates.mine = tpl({ id: "mine", name: "My Fork", config: { externalPresetId: "codex" } })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.getByTestId("template-rail-blocked")).toBeInTheDocument()
  })

  it("downgrades to information once nesting is enabled", () => {
    nestingEnabled = true
    templates.mine = tpl({ id: "mine", name: "My Fork", config: { externalPresetId: "codex" } })
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.queryByTestId("template-rail-blocked")).not.toBeInTheDocument()
    expect(screen.getByTestId("template-dispatch-only")).toBeInTheDocument()
  })

  it("raises the warning live as the user pins a provider", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.queryByTestId("template-rail-blocked")).not.toBeInTheDocument()
    // The provider picker lives in the collapsed advanced group.
    await userEvent.click(screen.getByRole("button", { name: /configTitle/ }))
    await userEvent.click(await screen.findByTestId("stub-model-combobox"))
    expect(screen.getByTestId("template-rail-blocked")).toBeInTheDocument()
  })
})

describe("tool scope (G2)", () => {
  it("writes the tool allowlist into config", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByTestId("template-tools-set"))
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await waitFor(() => expect(updateTemplate).toHaveBeenCalled())
    expect(updateTemplate.mock.calls[0][1].config).toMatchObject({ tools: ["Read"] })
  })
})

describe("editing lifecycle", () => {
  it("keeps the bar hidden until something changes", () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    expect(screen.queryByTestId("unsaved-bar")).not.toBeInTheDocument()
  })

  it("refuses to save a blank name and keeps the draft", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    await userEvent.clear(screen.getByTestId("editor-name"))
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await waitFor(() =>
      expect(screen.getByTestId("unsaved-bar")).toHaveAttribute("data-status", "dirty")
    )
    expect(updateTemplate).not.toHaveBeenCalled()
  })

  it("trims the name on save", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    await userEvent.type(screen.getByTestId("editor-name"), "   ")
    await userEvent.click(screen.getByTestId("unsaved-bar-save"))
    await waitFor(() => expect(updateTemplate).toHaveBeenCalled())
    expect(updateTemplate.mock.calls[0][1].name).toBe("My Fork")
  })

  it("deletes after confirmation", async () => {
    render(<TemplatePanel templateId="mine" onNavigate={onNavigate} />)
    await userEvent.click(screen.getByTestId("template-delete"))
    await userEvent.click(await screen.findByTestId("template-delete-confirm"))
    expect(deleteTemplate).toHaveBeenCalledWith("mine")
  })
})
