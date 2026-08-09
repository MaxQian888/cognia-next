/**
 * @jest-environment jsdom
 */
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const loadCompanionConfig = jest.fn<Record<string, unknown> | null, []>(() => ({
  baseUrl: "https://desk.local",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint",
  deviceId: "d1",
}))
const isTauri = jest.fn(() => false)

jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => loadCompanionConfig(),
}))
jest.mock("@/lib/tauri", () => ({ isTauri: () => isTauri() }))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The chat tab is heavy + lazy; stand in a marker so we only assert the sheet
// mounts it (its own wiring is covered by chat-tab.test.tsx).
jest.mock("@/components/workflow/editor/right-sidebar/chat-tab", () => ({
  WorkflowEditorChatTab: (props: { workflowId?: string }) => (
    <div data-testid="mock-workflow-chat-tab">{props.workflowId}</div>
  ),
}))

import { MobileWorkflowCopilotSheet } from "./mobile-workflow-copilot-sheet"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

function wf(): VisualWorkflow {
  return {
    id: "wf_cp",
    schemaVersion: 1,
    name: "Copilot WF",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function renderSheet(open: boolean) {
  const store: EditorStore = createEditorStore(wf())
  const onOpenChange = jest.fn()
  render(
    <MobileWorkflowCopilotSheet
      open={open}
      onOpenChange={onOpenChange}
      store={store}
      workflowId="wf_cp"
      workflowName="Copilot WF"
    />
  )
  return { onOpenChange }
}

beforeEach(() => {
  loadCompanionConfig.mockReturnValue({ baseUrl: "https://desk.local", devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
      deviceKeyThumbprint: "thumbprint", deviceId: "d1" })
  isTauri.mockReturnValue(false)
})

describe("<MobileWorkflowCopilotSheet />", () => {
  it("does not mount the chat tab until first opened (lazy)", () => {
    renderSheet(false)
    expect(screen.queryByTestId("mock-workflow-chat-tab")).not.toBeInTheDocument()
  })

  it("mounts the chat tab when opened and keeps it mounted after close (persistent stream)", async () => {
    const store: EditorStore = createEditorStore(wf())
    const onOpenChange = jest.fn()
    const { rerender } = render(
      <MobileWorkflowCopilotSheet
        open
        onOpenChange={onOpenChange}
        store={store}
        workflowId="wf_cp"
        workflowName="Copilot WF"
      />
    )
    expect(await screen.findByTestId("mock-workflow-chat-tab")).toBeInTheDocument()

    // Close: the sheet hides (translate off-screen) but the chat tab STAYS
    // mounted so a streaming turn never drops its subscription.
    rerender(
      <MobileWorkflowCopilotSheet
        open={false}
        onOpenChange={onOpenChange}
        store={store}
        workflowId="wf_cp"
        workflowName="Copilot WF"
      />
    )
    expect(screen.getByTestId("mock-workflow-chat-tab")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-copilot-sheet")).toHaveAttribute("data-state", "closed")
  })

  it("fires onOpenChange(false) from the close button and the scrim", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = renderSheet(true)
    await user.click(screen.getByTestId("mobile-copilot-close"))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
    await user.click(screen.getByTestId("mobile-copilot-scrim"))
    expect(onOpenChange).toHaveBeenLastCalledWith(false)
  })

  it("shows the offline hint (no chat) when no desktop is reachable", () => {
    loadCompanionConfig.mockReturnValue(null)
    isTauri.mockReturnValue(false)
    renderSheet(true)
    expect(screen.getByTestId("mobile-copilot-offline")).toBeInTheDocument()
    expect(screen.queryByTestId("mock-workflow-chat-tab")).not.toBeInTheDocument()
  })
})
