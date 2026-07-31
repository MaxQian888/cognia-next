/**
 * Tests for InteractivePageDialog — the execution → A2UI page bridge UI.
 * Keeps the pure projectors real; mocks the heavy children (preview surface,
 * share dialog) and the LLM enhancer so branches are deterministic.
 */

import React from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import enMessages from "@/i18n/messages/en.json"
import type { ExecutionPageSource } from "@/lib/a2ui/from-execution"
import type { VisualWorkflow, WorkflowRunEventRow, WorkflowRunRow } from "@/types/workflow/visual"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

const processMessages = jest.fn()
const deleteSurface = jest.fn()
jest.mock("@/stores/a2ui", () => ({
  useA2UIStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ processMessages, deleteSurface }),
}))

const createCustomApp = jest.fn((): string | null => "custom-123")
jest.mock("@/hooks/a2ui/use-app-builder", () => ({
  useA2UIAppBuilder: () => ({ createCustomApp }),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}))

jest.mock("@/lib/a2ui/parser", () => ({
  createA2UISurface: jest.fn(() => [{ type: "createSurface" }]),
}))

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

// Light stubs for heavy children.
jest.mock("@/components/a2ui/a2ui-surface", () => ({
  A2UISurface: ({ surfaceId }: { surfaceId: string }) => (
    <div data-testid="preview" data-surface={surfaceId} />
  ),
}))
jest.mock("@/components/share/share-link-dialog", () => ({
  ShareLinkDialog: ({
    buildPayload,
    trigger,
  }: {
    buildPayload: () => unknown
    trigger: React.ReactNode
  }) => (
    <div>
      {trigger}
      <button
        type="button"
        onClick={() => ((globalThis as Record<string, unknown>).__sharePayload = buildPayload())}
      >
        invoke-build-payload
      </button>
    </div>
  ),
}))

// Keep projectors real; only stub the LLM enhancer.
const enhanceExecutionPage = jest.fn()
jest.mock("@/lib/a2ui/from-execution", () => ({
  ...jest.requireActual("@/lib/a2ui/from-execution"),
  enhanceExecutionPage: (...a: unknown[]) => enhanceExecutionPage(...a),
}))

import { InteractivePageDialog } from "./interactive-page-dialog"
import { toast } from "sonner"

const workflow = {
  id: "wf1",
  schemaVersion: 2,
  name: "My WF",
  createdAt: 0,
  updatedAt: 0,
  edges: [],
  settings: {},
  nodes: [
    {
      id: "n1",
      type: "action.code",
      typeVersion: 1,
      position: { x: 0, y: 0 },
      data: { label: "Step" },
    },
  ],
} as unknown as VisualWorkflow
const run = {
  id: "run1",
  workflowId: "wf1",
  status: "succeeded",
  triggerKind: "trigger.manual",
  triggerPayload: {},
  startedAt: 0,
  completedAt: 1000,
  workflowSnapshot: workflow,
  title: "My Run",
} as unknown as WorkflowRunRow
const events = [
  { id: "e1", runId: "run1", ts: 0, type: "step_started", stepId: "n1" },
  {
    id: "e2",
    runId: "run1",
    ts: 500,
    type: "step_completed",
    stepId: "n1",
    payload: { output: "x" },
  },
] as unknown as WorkflowRunEventRow[]
const wfSource: ExecutionPageSource = { kind: "workflow-run", run, events, workflowName: "My WF" }

function renderDialog(
  source: ExecutionPageSource | (() => Promise<ExecutionPageSource>) = wfSource
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages as Record<string, unknown>}>
      <InteractivePageDialog source={source} trigger={<button type="button">Open</button>} />
    </NextIntlClientProvider>
  )
}

async function open(source?: ExecutionPageSource | (() => Promise<ExecutionPageSource>)) {
  renderDialog(source)
  fireEvent.click(screen.getByText("Open"))
  // wait for the async build to populate the name input
  await waitFor(() => expect(screen.getByDisplayValue("My Run")).toBeInTheDocument())
}

beforeEach(() => {
  jest.clearAllMocks()
  createCustomApp.mockReturnValue("custom-123")
})

describe("InteractivePageDialog", () => {
  it("builds the page on open and renders a preview surface", async () => {
    await open()
    expect(screen.getByText("Generate Interactive Page")).toBeInTheDocument()
    expect(screen.getByTestId("preview")).toBeInTheDocument()
    expect(processMessages).toHaveBeenCalled()
  })

  it("saves the page to Mini-Apps and navigates to the hub", async () => {
    await open()
    fireEvent.click(screen.getByText("Save to Mini-Apps"))
    expect(createCustomApp).toHaveBeenCalledWith("My Run", expect.any(Array), expect.any(Object))
    expect(toast.success).toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith("/a2ui?app=custom-123")
  })

  it("uses the edited name when saving", async () => {
    await open()
    fireEvent.change(screen.getByDisplayValue("My Run"), { target: { value: "Renamed" } })
    fireEvent.click(screen.getByText("Save to Mini-Apps"))
    expect(createCustomApp).toHaveBeenCalledWith("Renamed", expect.any(Array), expect.any(Object))
  })

  it("falls back to the app name when the name field is cleared", async () => {
    await open()
    fireEvent.change(screen.getByDisplayValue("My Run"), { target: { value: "   " } })
    // share payload falls back to the app name (assert before save closes the dialog)
    fireEvent.click(screen.getByText("invoke-build-payload"))
    const payload = (globalThis as Record<string, unknown>).__sharePayload as { data: string }
    expect(JSON.parse(payload.data).app.title).toBe("My Run")
    // save also falls back to the app name
    fireEvent.click(screen.getByText("Save to Mini-Apps"))
    expect(createCustomApp).toHaveBeenCalledWith("My Run", expect.any(Array), expect.any(Object))
  })

  it("surfaces a save failure", async () => {
    createCustomApp.mockReturnValueOnce(null)
    await open()
    fireEvent.click(screen.getByText("Save to Mini-Apps"))
    expect(toast.error).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it("builds a share payload from the current app", async () => {
    await open()
    fireEvent.click(screen.getByText("invoke-build-payload"))
    const payload = (globalThis as Record<string, unknown>).__sharePayload as {
      kind: string
      data: string
    }
    expect(payload.kind).toBe("a2ui")
    const parsed = JSON.parse(payload.data) as { app: { components: unknown[]; title: string } }
    expect(parsed.app.title).toBe("My Run")
    expect(parsed.app.components.length).toBeGreaterThan(0)
  })

  it("applies an AI enhancement and updates the name", async () => {
    enhanceExecutionPage.mockResolvedValue({
      title: "Enhanced",
      summary: "All good",
      insights: ["fast"],
    })
    await open()
    fireEvent.click(screen.getByText("AI summary"))
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(screen.getByDisplayValue("Enhanced")).toBeInTheDocument()
  })

  it("reports an enhancement failure without changing the page", async () => {
    enhanceExecutionPage.mockResolvedValue(null)
    await open()
    fireEvent.click(screen.getByText("AI summary"))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(screen.getByDisplayValue("My Run")).toBeInTheDocument()
  })

  it("resolves an async (conversation) source on open", async () => {
    const session = {
      id: "s1",
      title: "My Run",
      kind: "direct",
      createdAt: 0,
      updatedAt: 0,
    } as unknown as ChatSession
    const messages = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        createdAt: 0,
      },
    ] as unknown as StoredMessage[]
    const resolver = jest.fn(
      async () => ({ kind: "conversation", session, messages }) as ExecutionPageSource
    )
    await open(resolver)
    expect(resolver).toHaveBeenCalled()
    expect(screen.getByTestId("preview")).toBeInTheDocument()
  })

  it("tears down the preview surface on close", async () => {
    await open()
    fireEvent.click(screen.getByText("Open")) // toggle closed via the trigger? use Escape instead
    // Close by pressing Escape on the dialog
    fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" })
    await waitFor(() => expect(deleteSurface).toHaveBeenCalled())
  })
})
