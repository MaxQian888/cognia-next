/**
 * @jest-environment jsdom
 */

import { useState } from "react"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { SubAgentTemplate } from "@/types/agent/sub-agent"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/motion/motion-reveal", () => ({
  useFlowMotion: () => ({ reduce: true, durationScale: 1 }),
}))

const replaceMock = jest.fn()
let searchString = ""
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: replaceMock }),
  useSearchParams: () => new URLSearchParams(searchString),
}))

let templates: Record<string, SubAgentTemplate> = {}
const addTemplate = jest.fn()
jest.mock("@/stores/agent/subagent-runtime-store", () => ({
  useSubagentRuntimeStore: (selector: (s: unknown) => unknown) =>
    selector({ templates, subAgents: {}, addTemplate, remove: jest.fn() }),
}))

let plugins: unknown[] = []
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: (selector: (s: unknown) => unknown) => selector({ plugins }),
}))

let pluginEntries: Array<{ id: string; pluginId?: string; entry: Record<string, unknown> }> = []
jest.mock("@/lib/plugin/registries/subagent-registry", () => ({
  listSubagentEntries: () => pluginEntries,
}))

jest.mock("@/components/settings/common/related-sections-strip", () => ({
  CLAUDE_CODE_RELATED: [],
  RelatedSectionsStrip: () => null,
}))
jest.mock("./subagent-import-dialog", () => ({
  SubagentImportDialog: () => null,
}))

// The panels are covered by their own suites; stub them so this file tests the
// section's own behaviour. The template stub can go dirty on demand so the
// navigation guard is exercised for real rather than simulated.
jest.mock("./panels/template-panel", () => {
  const { useReportPanelDirty } = jest.requireActual("./panel-dirty-context")
  return {
    TemplatePanel: ({ templateId }: { templateId: string }) => {
      const [dirty, setDirty] = useState(false)
      useReportPanelDirty(dirty)
      return (
        <div data-testid="stub-template-panel" data-template-id={templateId}>
          <button type="button" data-testid="make-dirty" onClick={() => setDirty(true)}>
            edit
          </button>
        </div>
      )
    },
  }
})
jest.mock("./panels/runtime-panel", () => ({
  RuntimePanel: () => <div data-testid="stub-runtime-panel" />,
}))
jest.mock("./panels/policy-panels", () => ({
  NestingPanel: () => <div data-testid="stub-nesting-panel" />,
  BackgroundPanel: () => <div data-testid="stub-background-panel" />,
}))
jest.mock("./panels/plugin-panel", () => ({
  PluginPanel: ({ runtimeId }: { runtimeId: string }) => (
    <div data-testid="stub-plugin-panel" data-runtime-id={runtimeId} />
  ),
}))

import { SubagentsSection } from "./subagents-section"

const tpl = (over: Partial<SubAgentTemplate> & { id: string }): SubAgentTemplate => ({
  name: over.id,
  description: "",
  category: "general",
  taskTemplate: "",
  config: {},
  ...over,
})

beforeEach(() => {
  replaceMock.mockReset()
  addTemplate.mockReset()
  searchString = ""
  plugins = []
  pluginEntries = []
  templates = {
    explore: tpl({ id: "explore", name: "Explore", isBuiltIn: true, category: "research" }),
    mine: tpl({ id: "mine", name: "My Fork", category: "coding" }),
  }
})

describe("SubagentsSection routing", () => {
  it("lands on the first template when the URL says nothing", () => {
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-template-panel")).toHaveAttribute("data-template-id", "explore")
  })

  it("keeps the legacy ?subagentTab=runtime deep link working", () => {
    searchString = "subagentTab=runtime"
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-runtime-panel")).toBeInTheDocument()
  })

  it("maps the legacy ?subagentTab=templates deep link onto the first template", () => {
    searchString = "subagentTab=templates"
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-template-panel")).toHaveAttribute("data-template-id", "explore")
  })

  it("resolves a template panel id", () => {
    searchString = "subagentTab=template:mine"
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-template-panel")).toHaveAttribute("data-template-id", "mine")
  })

  it("writes the panel id to the URL on select", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("subagent-nav-item-background"))
    expect(replaceMock).toHaveBeenCalled()
    expect(replaceMock.mock.calls[0][0]).toContain("subagentTab=background")
  })

  it("preselects the panel owning a ?focus= finder anchor", () => {
    // Without this the settings finder's jump to `subagent-nesting` would
    // silently stop highlighting: `use-setting-focus` queries the DOM for the
    // anchor, which only exists while its panel is mounted.
    searchString = "focus=subagent-nesting"
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-nesting-panel")).toBeInTheDocument()
  })

  it("preselects the background panel for its own finder anchor", () => {
    searchString = "focus=subagent-background-tasks"
    render(<SubagentsSection />)
    expect(screen.getByTestId("stub-background-panel")).toBeInTheDocument()
  })
})

describe("SubagentsSection nav content", () => {
  it("groups built-in and user templates separately", () => {
    render(<SubagentsSection />)
    expect(screen.getByTestId("subagent-nav-item-template:explore")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-item-template:mine")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-group-builtinGroup")).toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-group-userGroup")).toBeInTheDocument()
  })

  it("lists plugin subagents under their namespaced runtime id", () => {
    pluginEntries = [
      { id: "reviewer", pluginId: "acme", entry: { name: "Reviewer", description: "" } },
    ]
    searchString = "subagentTab=plugin:acme:reviewer"
    render(<SubagentsSection />)
    expect(screen.getByTestId("subagent-nav-item-plugin:acme:reviewer")).toBeInTheDocument()
    expect(screen.getByTestId("stub-plugin-panel")).toHaveAttribute(
      "data-runtime-id",
      "acme:reviewer"
    )
  })

  it("filters the list by search", async () => {
    render(<SubagentsSection />)
    await userEvent.type(screen.getByTestId("subagent-nav-search"), "fork")
    expect(screen.queryByTestId("subagent-nav-item-template:explore")).not.toBeInTheDocument()
    expect(screen.getByTestId("subagent-nav-item-template:mine")).toBeInTheDocument()
  })

  it("filters by category and reports an empty result", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("category-filter-writing"))
    expect(screen.getByTestId("subagent-nav-empty")).toBeInTheDocument()
  })

  it("exposes the category chips as pressed-state buttons", () => {
    render(<SubagentsSection />)
    expect(screen.getByTestId("category-filter-all")).toHaveAttribute("aria-pressed", "true")
    expect(screen.getByTestId("category-filter-coding")).toHaveAttribute("aria-pressed", "false")
  })

  it("creates a template and navigates to it", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("subagent-template-new"))
    expect(addTemplate).toHaveBeenCalledTimes(1)
    const created = addTemplate.mock.calls[0][0] as SubAgentTemplate
    expect(created.isBuiltIn).toBe(false)
    // Read it back the way the app does — `toString()` percent-encodes the
    // colon in `template:<id>`, and `useSearchParams().get()` decodes it.
    const written = new URLSearchParams((replaceMock.mock.calls[0][0] as string).replace(/^\?/, ""))
    expect(written.get("subagentTab")).toBe(`template:${created.id}`)
  })
})

describe("SubagentsSection unsaved guard", () => {
  it("intercepts navigation away from a dirty panel", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("make-dirty"))
    await userEvent.click(screen.getByTestId("subagent-nav-item-background"))

    expect(screen.getByTestId("subagent-discard-confirm")).toBeInTheDocument()
    expect(replaceMock).not.toHaveBeenCalled()
  })

  it("navigates once the discard is confirmed", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("make-dirty"))
    await userEvent.click(screen.getByTestId("subagent-nav-item-background"))
    await userEvent.click(screen.getByTestId("subagent-discard-confirm-action"))

    expect(replaceMock.mock.calls[0][0]).toContain("subagentTab=background")
  })

  it("marks the dirty panel in the nav", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("make-dirty"))
    expect(screen.getByTestId("subagent-nav-dirty-template:explore")).toBeInTheDocument()
  })

  it("does not intercept when the panel is clean", async () => {
    render(<SubagentsSection />)
    await userEvent.click(screen.getByTestId("subagent-nav-item-background"))
    expect(screen.queryByTestId("subagent-discard-confirm")).not.toBeInTheDocument()
    expect(replaceMock).toHaveBeenCalled()
  })
})
