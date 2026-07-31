/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

const openProposal = jest.fn()
const mockInsertNodeGroup = jest.fn(() => ({ groupId: "group-1", nodeIds: ["node-1"] }))

jest.mock("@/lib/workflow/copilot-templates", () => ({
  listCopilotTemplates: () => [
    {
      id: "starter",
      label: { en: "Starter" },
      description: { en: "A starter workflow" },
      tags: ["basic"],
      slots: [],
    },
  ],
  materializeCopilotTemplate: () => ({ ok: true, workflow: {} }),
}))

jest.mock("@/lib/workflow/editor/proposal-store", () => ({
  useProposalStore: { getState: () => ({ openProposal }) },
}))

jest.mock("@/lib/templates/catalog", () => {
  const snapshot = {
    revision: 1,
    definitions: [
      {
        apiVersion: "cognia.ai/templates/v1",
        id: "demo:review",
        domain: "workflow",
        status: "published",
        revision: 1,
        version: "1.0.0",
        metadata: { name: "Review group", description: "Prompt then output" },
        payload: {
          kind: "cognia.workflow/node-group/v1",
          nodes: [
            {
              id: "prompt",
              type: "ai.prompt",
              typeVersion: 1,
              position: { x: 0, y: 0 },
              data: { label: "Review" },
            },
          ],
          edges: [],
        },
        inputs: [],
        dependencies: [],
        capabilities: [],
        compatibility: { platforms: ["desktop"] },
        provenance: { source: "plugin", pluginId: "demo" },
        contentHash: "a".repeat(64),
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
  return {
    templateCatalog: {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      getServerSnapshot: () => snapshot,
    },
  }
})

jest.mock("@/plugins/workflow-ai/src/tools/template-tools", () => ({
  templateToProposalOps: () => ({
    ops: [
      {
        type: "add_node",
        nodeId: "node-1",
        kind: "ai.prompt",
        position: { x: 0, y: 0 },
      },
    ],
  }),
}))

jest.mock("sonner", () => ({
  toast: { success: jest.fn(), error: jest.fn() },
}))

import { TemplatesTab } from "./templates-tab"

const messages = {
  workflowEditor: {
    templates: {
      applyCta: "Apply",
      cancel: "Cancel",
      emptyState: "No templates registered.",
      slotRequiredMissing: "Complete required fields",
      tabHelp: "Choose a template",
      nodeGroups: {
        heading: "Node groups",
        help: "Insert a reusable graph fragment.",
        inserted: "Inserted {name}",
        failed: "Could not insert {name}: {message}",
      },
    },
  },
}

const editorState = {
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  insertNodeGroup: mockInsertNodeGroup,
}

const useStore = Object.assign(
  (selector: (state: typeof editorState) => unknown) => selector(editorState),
  {
    getState: () => editorState,
    setState: () => undefined,
    subscribe: () => () => undefined,
  }
) as never

function renderTab(workflowId: string | undefined) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <TemplatesTab useStore={useStore} workflowId={workflowId} />
    </NextIntlClientProvider>
  )
}

describe("TemplatesTab", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("shows the empty state until a workflow is available", () => {
    renderTab(undefined)

    expect(screen.getByTestId("workflow-templates-tab-empty")).toHaveTextContent(
      "No templates registered."
    )
  })

  it("captures the current editor revision when staging a template proposal", async () => {
    const user = userEvent.setup()
    renderTab("workflow-1")

    expect(screen.getByTestId("workflow-templates-tab")).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-x-hidden"
    )

    await user.click(screen.getByTestId("workflow-template-row-starter"))
    expect(screen.getByTestId("workflow-templates-form-starter")).toHaveClass(
      "min-w-0",
      "max-w-full",
      "overflow-x-hidden"
    )
    await user.click(screen.getByTestId("workflow-templates-form-apply"))

    expect(openProposal).toHaveBeenCalledWith(
      "workflow-1",
      expect.objectContaining({
        workflowId: "workflow-1",
        baseRevision: expect.stringMatching(/^wf:[0-9a-f]{8}$/),
      })
    )
  })

  it("lists unified-catalog node groups and inserts one atomically", async () => {
    const user = userEvent.setup()
    renderTab("workflow-1")

    expect(screen.getByText("Node groups")).toBeInTheDocument()
    await user.click(screen.getByTestId("workflow-node-group-row-demo:review"))

    expect(mockInsertNodeGroup).toHaveBeenCalledWith(
      expect.objectContaining({ id: "demo:review" }),
      { x: 160, y: 120 }
    )
  })
})
