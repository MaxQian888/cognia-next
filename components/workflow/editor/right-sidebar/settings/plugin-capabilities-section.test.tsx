/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

const snapshot: Array<{ kind: string; label: string; pluginId?: string }> = []
jest.mock("@/lib/workflow/nodes/catalog", () => ({
  subscribePluginCatalog: () => () => {},
  getPluginCatalogSnapshot: () => snapshot,
}))

const mockPush = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}))

const mockCreateWorkflow = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  createWorkflow: (...args: unknown[]) => mockCreateWorkflow(...args),
}))

import { PluginCapabilitiesSection } from "./plugin-capabilities-section"
import {
  registerWorkflowTemplate,
  __resetWorkflowTemplatesForTesting,
} from "@/lib/plugin/registries/workflow-template-registry"
import type { PluginWorkflowTemplateDef } from "@/types/plugin/plugin-workflow-template"

const messages = {
  workflowEditor: {
    settings: {
      plugins: {
        empty: "No plugin-contributed workflow capabilities installed.",
        sections: { nodes: "Nodes", triggers: "Triggers", templates: "Templates" },
        contributedBy: "Provided by {plugin}",
        useTemplate: "Use",
        missingDep: "Missing: {id}",
      },
    },
  },
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {ui}
    </NextIntlClientProvider>
  )
}

const TEMPLATE: PluginWorkflowTemplateDef = {
  id: "demo-template",
  name: "Demo pipeline",
  description: "A plugin-contributed blueprint",
  category: "automation",
  icon: "newspaper",
  complexity: "intermediate",
  nodes: [
    {
      id: "trigger",
      type: "trigger.cron",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Daily", params: { cron: "0 9 * * *" } },
    },
    {
      id: "save",
      type: "myplugin.save",
      typeVersion: 1,
      position: { x: 240, y: 0 },
      data: { label: "Save", params: { candidates: "{{ $node['trigger'].ts }}" } },
    },
  ],
  edges: [{ id: "e1", source: "trigger", target: "save" }],
  requires: { pluginNodeKinds: ["myplugin.save"] },
}

describe("PluginCapabilitiesSection", () => {
  afterEach(() => {
    snapshot.length = 0
    __resetWorkflowTemplatesForTesting()
    jest.clearAllMocks()
  })

  it("renders the empty state when no plugin capabilities are installed", () => {
    wrap(<PluginCapabilitiesSection />)
    expect(
      screen.getByText("No plugin-contributed workflow capabilities installed.")
    ).toBeInTheDocument()
  })

  it("groups plugin-contributed nodes and triggers", () => {
    snapshot.push(
      { kind: "myplugin.action.fetch", label: "Fetch page", pluginId: "myplugin" },
      { kind: "myplugin.trigger.poll", label: "Poll", pluginId: "myplugin" }
    )
    wrap(<PluginCapabilitiesSection />)
    expect(screen.getByText("Nodes")).toBeInTheDocument()
    expect(screen.getByText("Triggers")).toBeInTheDocument()
    expect(screen.getByText("Fetch page")).toBeInTheDocument()
    expect(screen.getAllByText("Provided by myplugin").length).toBeGreaterThanOrEqual(1)
  })

  it("lists registered plugin workflow templates with their contributor", () => {
    snapshot.push({ kind: "myplugin.save", label: "Save", pluginId: "myplugin" })
    registerWorkflowTemplate(TEMPLATE.id, TEMPLATE, { pluginId: "myplugin" })

    wrap(<PluginCapabilitiesSection />)

    expect(screen.getByText("Templates")).toBeInTheDocument()
    expect(screen.getByText("Demo pipeline")).toBeInTheDocument()
    expect(screen.getByTestId("plugin-template-use-demo-template")).toBeInTheDocument()
    // The required plugin node is in the catalog, so no warning chips render.
    expect(screen.queryByText(/^Missing:/)).not.toBeInTheDocument()
  })

  it("surfaces requires warnings when a plugin node kind is missing", () => {
    // Catalog left empty — `myplugin.save` is unavailable.
    registerWorkflowTemplate(TEMPLATE.id, TEMPLATE, { pluginId: "myplugin" })

    wrap(<PluginCapabilitiesSection />)

    expect(screen.getByText("Missing: myplugin.save")).toBeInTheDocument()
  })

  it("projects the blueprint into a new workflow and navigates on Use", async () => {
    snapshot.push({ kind: "myplugin.save", label: "Save", pluginId: "myplugin" })
    registerWorkflowTemplate(TEMPLATE.id, TEMPLATE, { pluginId: "myplugin" })
    mockCreateWorkflow.mockResolvedValue({ id: "wf_new" })

    wrap(<PluginCapabilitiesSection />)
    await userEvent.click(screen.getByTestId("plugin-template-use-demo-template"))

    await waitFor(() => expect(mockCreateWorkflow).toHaveBeenCalledTimes(1))
    const draft = mockCreateWorkflow.mock.calls[0][0] as {
      name: string
      nodes: Array<{ id: string; type: string }>
      edges: Array<{ id: string }>
      isTemplate: boolean
    }
    expect(draft.name).toBe("Demo pipeline")
    expect(draft.isTemplate).toBe(false)
    expect(draft.nodes.map((n) => n.id)).toEqual(["trigger", "save"])
    expect(draft.nodes[1].type).toBe("myplugin.save")
    expect(draft.edges).toHaveLength(1)
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/workflows/wf_new"))
  })
})
