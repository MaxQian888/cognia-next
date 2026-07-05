/**
 * @jest-environment jsdom
 */

import React from "react"
import { fireEvent, render, screen } from "@testing-library/react"
import { SubagentTemplatesTab } from "./subagent-templates-tab"
import { useSubagentRuntimeStore } from "@/stores/agent/subagent-runtime-store"
import { BUILT_IN_SUBAGENT_TEMPLATES } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

jest.mock("nanoid", () => ({ nanoid: () => "fixed-id" }))

// The provider:model picker is a Popover+Command (hard to drive in jsdom and
// already covered by its own test). Mock it to a button that fires onSelect with
// a fixed provider+model, so we can assert the tab WIRES both fields.
jest.mock("@/components/settings/provider/routing/provider-model-combobox", () => ({
  ProviderModelCombobox: ({
    providerId,
    modelId,
    onSelect,
  }: {
    providerId?: string
    modelId?: string
    onSelect: (p: string, m: string) => void
  }) => (
    <button
      type="button"
      data-testid="mock-pm-combobox"
      data-provider={providerId ?? ""}
      data-model={modelId ?? ""}
      onClick={() => onSelect("anthropic", "claude-sonnet-4-5")}
    >
      pm
    </button>
  ),
}))

const toastSuccess = jest.fn()
const toastError = jest.fn()
jest.mock("@/components/ui/sonner", () => ({
  toast: {
    success: (m: string) => toastSuccess(m),
    error: (m: string) => toastError(m),
  },
}))

// Stub Collapsible so advanced config sections are always visible in jsdom.
jest.mock("@/components/ui/collapsible", () => {
  const Collapsible = ({
    children,
  }: {
    children: React.ReactNode
    open?: boolean
    onOpenChange?: (open: boolean) => void
  }) => <>{children}</>
  const CollapsibleContent = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const CollapsibleTrigger = ({
    children,
    asChild,
    onClick,
  }: {
    children: React.ReactNode
    asChild?: boolean
    onClick?: () => void
  }) => {
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
        onClick,
      })
    }
    return (
      <button type="button" onClick={onClick}>
        {children}
      </button>
    )
  }
  return { Collapsible, CollapsibleContent, CollapsibleTrigger }
})

// Stub Select primitives so jsdom tests don't depend on Radix's pointer logic.
jest.mock("@/components/ui/select", () => {
  const Select = ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode
    value?: string
    onValueChange?: (v: string) => void
  }) => (
    <select data-testid="select" value={value} onChange={(e) => onValueChange?.(e.target.value)}>
      {children}
    </select>
  )
  const SelectTrigger = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const SelectValue = ({ children }: { children?: React.ReactNode }) => <>{children ?? null}</>
  const SelectContent = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const SelectItem = ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
  return { Select, SelectTrigger, SelectValue, SelectContent, SelectItem }
})

beforeEach(() => {
  toastSuccess.mockReset()
  toastError.mockReset()
  // Reset store to seed templates only.
  useSubagentRuntimeStore.setState((s) => {
    const seeded: Record<string, (typeof BUILT_IN_SUBAGENT_TEMPLATES)[number]> = {}
    for (const t of BUILT_IN_SUBAGENT_TEMPLATES) seeded[t.id] = t
    return { ...s, templates: seeded, subAgents: {} }
  })
})

describe("SubagentTemplatesTab", () => {
  it("renders one row per built-in template", () => {
    render(<SubagentTemplatesTab />)
    for (const t of BUILT_IN_SUBAGENT_TEMPLATES) {
      expect(screen.getByTestId(`subagent-template-row-${t.id}`)).toBeInTheDocument()
    }
  })

  it("built-in rows are read-only (edit + delete buttons disabled)", () => {
    render(<SubagentTemplatesTab />)
    const id = BUILT_IN_SUBAGENT_TEMPLATES[0].id
    expect(screen.getByTestId(`edit-${id}`)).toBeDisabled()
    expect(screen.getByTestId(`delete-${id}`)).toBeDisabled()
  })

  it("Duplicate forks a built-in into an editable user copy and opens the editor", () => {
    render(<SubagentTemplatesTab />)
    const id = BUILT_IN_SUBAGENT_TEMPLATES[0].id
    fireEvent.click(screen.getByTestId(`duplicate-${id}`))
    // The forked copy lands in the store with id = "fixed-id" (nanoid mock).
    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]?.isBuiltIn).toBe(false)
    // Editor opens automatically (form fields visible).
    expect(screen.getByTestId("subagent-template-editor")).toBeInTheDocument()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("New template opens an empty editor and saves on submit with a fresh id", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))

    const nameInput = screen.getByTestId("editor-name") as HTMLInputElement
    fireEvent.change(nameInput, { target: { value: "My agent" } })
    fireEvent.click(screen.getByTestId("editor-submit"))

    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]?.name).toBe("My agent")
    expect(toastSuccess).toHaveBeenCalled()
  })

  it("New template can back a subagent with an external CLI runtime (A2)", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.change(screen.getByTestId("editor-name"), { target: { value: "Ext Coder" } })
    // The mocked Select shares a testid across all selects, so locate the
    // external-runtime one by the unique "Claude Code" option it renders.
    const claudeOption = screen.getByRole("option", { name: "Claude Code" }) as HTMLOptionElement
    const select = claudeOption.closest("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "claude-code" } })
    fireEvent.click(screen.getByTestId("editor-submit"))
    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]?.config.externalPresetId).toBe(
      "claude-code"
    )
  })

  it("New template refuses an empty name (toast.error)", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.click(screen.getByTestId("editor-submit"))
    expect(toastError).toHaveBeenCalled()
    // Store unchanged.
    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]).toBeUndefined()
  })

  it("editing a user template patches it in the store", () => {
    // Seed a user template.
    useSubagentRuntimeStore.getState().addTemplate({
      id: "u",
      name: "Mine",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("edit-u"))
    fireEvent.change(screen.getByTestId("editor-name"), { target: { value: "Mine v2" } })
    fireEvent.click(screen.getByTestId("editor-submit"))
    expect(useSubagentRuntimeStore.getState().templates.u?.name).toBe("Mine v2")
  })

  it("persists allowNesting + maxNestingDepth on a user template", () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "u2",
      name: "Nestable",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("edit-u2"))
    fireEvent.click(screen.getByTestId("editor-allow-nesting"))
    fireEvent.change(screen.getByTestId("editor-max-nesting-depth"), { target: { value: "3" } })
    fireEvent.click(screen.getByTestId("editor-submit"))
    const cfg = useSubagentRuntimeStore.getState().templates.u2?.config
    expect(cfg?.allowNesting).toBe(true)
    expect(cfg?.maxNestingDepth).toBe(3)
  })

  it("deleting a user template removes it after confirming the alert", () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "u",
      name: "Mine",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("delete-u"))
    // AlertDialog renders confirm action — use accessible role.
    const confirmButtons = screen.getAllByRole("button", { name: /delete/i })
    // Click the alert's Action button (last "delete" button is the confirm).
    fireEvent.click(confirmButtons[confirmButtons.length - 1])
    expect(useSubagentRuntimeStore.getState().templates.u).toBeUndefined()
  })

  it("search filters templates by name", () => {
    useSubagentRuntimeStore.getState().addTemplate({
      id: "u",
      name: "My Custom Agent",
      description: "",
      category: "general",
      taskTemplate: "",
      config: {},
      isBuiltIn: false,
    })
    render(<SubagentTemplatesTab />)
    // Built-ins are visible, custom template is visible.
    expect(screen.getByTestId("subagent-template-row-u")).toBeInTheDocument()
    // Type a search that only matches the custom template.
    fireEvent.change(screen.getByTestId("subagent-template-search"), {
      target: { value: "Custom" },
    })
    expect(screen.getByTestId("subagent-template-row-u")).toBeInTheDocument()
    // Built-ins should be filtered out.
    expect(screen.queryByTestId("subagent-template-row-research-web")).not.toBeInTheDocument()
  })

  it("category filter shows only matching templates", () => {
    render(<SubagentTemplatesTab />)
    // All templates visible initially.
    expect(screen.getByTestId("subagent-template-row-research-web")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-template-row-code-review")).toBeInTheDocument()
    // Filter by "coding" category.
    fireEvent.click(screen.getByTestId("category-filter-coding"))
    expect(screen.getByTestId("subagent-template-row-code-review")).toBeInTheDocument()
    expect(screen.queryByTestId("subagent-template-row-research-web")).not.toBeInTheDocument()
  })

  it("shows no-results empty state when search matches nothing", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.change(screen.getByTestId("subagent-template-search"), {
      target: { value: "zzz_nonexistent" },
    })
    expect(screen.getByText("noResults")).toBeInTheDocument()
  })

  it("editor includes icon field that saves", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.change(screen.getByTestId("editor-name"), {
      target: { value: "Icon Agent" },
    })
    fireEvent.change(screen.getByTestId("editor-icon"), {
      target: { value: "Search" },
    })
    fireEvent.click(screen.getByTestId("editor-submit"))
    expect(useSubagentRuntimeStore.getState().templates["fixed-id"]?.icon).toBe("Search")
  })

  it("editor can add and remove variables", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.change(screen.getByTestId("editor-name"), {
      target: { value: "Var Agent" },
    })
    // Add a variable.
    fireEvent.click(screen.getByTestId("editor-add-variable"))
    expect(screen.getByTestId("editor-variable-row-0")).toBeInTheDocument()
    // Fill it in.
    fireEvent.change(screen.getByTestId("editor-var-name-0"), {
      target: { value: "topic" },
    })
    fireEvent.change(screen.getByTestId("editor-var-desc-0"), {
      target: { value: "Research topic" },
    })
    // Submit and verify variables are saved.
    fireEvent.click(screen.getByTestId("editor-submit"))
    const saved = useSubagentRuntimeStore.getState().templates["fixed-id"]
    expect(saved?.variables?.length).toBe(1)
    expect(saved?.variables?.[0].name).toBe("topic")
  })

  it("editor advanced config fields save correctly", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.change(screen.getByTestId("editor-name"), {
      target: { value: "Config Agent" },
    })
    fireEvent.change(screen.getByTestId("editor-max-steps"), {
      target: { value: "20" },
    })
    fireEvent.change(screen.getByTestId("editor-timeout"), {
      target: { value: "300000" },
    })
    fireEvent.change(screen.getByTestId("editor-temperature"), {
      target: { value: "0.7" },
    })
    fireEvent.click(screen.getByTestId("editor-submit"))
    const saved = useSubagentRuntimeStore.getState().templates["fixed-id"]
    expect(saved?.config?.maxSteps).toBe(20)
    expect(saved?.config?.timeout).toBe(300000)
    expect(saved?.config?.temperature).toBe(0.7)
  })

  it("provider:model picker wires BOTH provider and model onto the config", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.change(screen.getByTestId("editor-name"), { target: { value: "Cross Agent" } })
    // The picker fires onSelect(provider, model) as one unit.
    fireEvent.click(screen.getByTestId("mock-pm-combobox"))
    fireEvent.click(screen.getByTestId("editor-submit"))
    const saved = useSubagentRuntimeStore.getState().templates["fixed-id"]
    expect(saved?.config?.provider).toBe("anthropic")
    expect(saved?.config?.model).toBe("claude-sonnet-4-5")
  })

  it("clear button removes both provider and model (inherit the session)", () => {
    render(<SubagentTemplatesTab />)
    fireEvent.click(screen.getByTestId("subagent-template-new"))
    fireEvent.change(screen.getByTestId("editor-name"), { target: { value: "Clear Agent" } })
    fireEvent.click(screen.getByTestId("mock-pm-combobox")) // sets provider+model
    fireEvent.click(screen.getByTestId("editor-model-clear")) // unsets both
    fireEvent.click(screen.getByTestId("editor-submit"))
    const saved = useSubagentRuntimeStore.getState().templates["fixed-id"]
    expect(saved?.config?.provider).toBeUndefined()
    expect(saved?.config?.model).toBeUndefined()
  })
})
