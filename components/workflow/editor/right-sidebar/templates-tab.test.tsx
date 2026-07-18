/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

const openProposal = jest.fn()

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
    },
  },
}

const editorState = {
  nodes: [],
  edges: [],
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

    await user.click(screen.getByTestId("workflow-template-row-starter"))
    await user.click(screen.getByTestId("workflow-templates-form-apply"))

    expect(openProposal).toHaveBeenCalledWith(
      "workflow-1",
      expect.objectContaining({
        workflowId: "workflow-1",
        baseRevision: expect.stringMatching(/^wf:[0-9a-f]{8}$/),
      })
    )
  })
})
