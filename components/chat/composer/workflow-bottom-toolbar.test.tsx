/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { EditorState, EditorStore } from "@/lib/workflow/editor/store"
import {
  WorkflowEditorProvider,
  type WorkflowEditorContextValue,
  type WorkflowQuickActionKind,
} from "@/lib/workflow/editor/workflow-editor-context"

// Mock next-intl translations to echo the key.
jest.mock("next-intl", () => ({
  useTranslations: (ns?: string) => (key: string, params?: Record<string, unknown>) =>
    params ? `${ns}.${key}:${JSON.stringify(params)}` : `${ns}.${key}`,
}))

// Stub heavier siblings — we only assert on quick-action wiring.
jest.mock("./model-picker", () => ({
  ModelPicker: () => <div data-testid="model-picker" />,
}))
jest.mock("./effort-chip", () => ({
  EffortChip: () => <div data-testid="effort-chip" />,
}))
jest.mock("../permission-mode-indicator", () => ({
  PermissionModeIndicator: () => <div data-testid="permission-mode-indicator" />,
}))
jest.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/components/ai-elements/context", () => ({
  Context: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-gauge">{children}</div>
  ),
  ContextTrigger: () => null,
  ContextContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextContentHeader: () => null,
  ContextContentBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextContentFooter: () => null,
  ContextInputUsage: () => null,
  ContextOutputUsage: () => null,
  ContextCacheUsage: () => null,
}))

const chatStoreState = {
  messages: [] as unknown[],
  status: "idle" as string,
  setPermissionMode: jest.fn(),
  addReferencedWorkflowElement: jest.fn(),
}
jest.mock("@/stores/chat", () => {
  const hook = (<T,>(selector: (s: typeof chatStoreState) => T) =>
    selector(chatStoreState)) as unknown as {
    <T>(selector: (s: typeof chatStoreState) => T): T
    getState: () => typeof chatStoreState
  }
  hook.getState = () => chatStoreState
  return { useChatStore: hook }
})

jest.mock("@/stores/settings", () => ({
  useSettingsStore: <T,>(selector: (s: { settings: { defaultModel: string } | null }) => T) =>
    selector({ settings: { defaultModel: "claude-sonnet-4-5" } }),
}))

import { WorkflowBottomToolbar } from "./workflow-bottom-toolbar"

const session: ChatSession = {
  id: "workflow:wf_x",
  title: "Test workflow",
  kind: "workflow-editor",
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

interface FakeStoreOpts {
  selectedNodeIds?: string[]
  selectedEdgeIds?: string[]
  nodes?: unknown[]
  edges?: unknown[]
  pulseNode?: jest.Mock
}

function fakeStore(opts: FakeStoreOpts): EditorStore {
  const fakeState = {
    selectedNodeIds: opts.selectedNodeIds ?? [],
    selectedEdgeIds: opts.selectedEdgeIds ?? [],
    nodes: opts.nodes ?? [],
    edges: opts.edges ?? [],
    pulseNode: opts.pulseNode ?? jest.fn(),
  } as unknown as EditorState
  const hook = (<T,>(selector: (s: EditorState) => T): T =>
    selector(fakeState)) as unknown as EditorStore
  ;(hook as unknown as { getState: () => EditorState }).getState = () => fakeState
  return hook
}

function renderWithCtx(
  opts: {
    selectedIds?: string[]
    selectedEdgeIds?: string[]
    nodes?: unknown[]
    edges?: unknown[]
    pulseNode?: jest.Mock
    onQuickAction?: WorkflowEditorContextValue["onQuickAction"]
    noProvider?: boolean
  } = {}
) {
  const onQuickAction = opts.onQuickAction ?? jest.fn<void, [WorkflowQuickActionKind]>()
  const value: WorkflowEditorContextValue = {
    useEditorStore: fakeStore({
      selectedNodeIds: opts.selectedIds ?? [],
      selectedEdgeIds: opts.selectedEdgeIds,
      nodes: opts.nodes,
      edges: opts.edges,
      pulseNode: opts.pulseNode,
    }),
    onQuickAction,
  }
  const ui = opts.noProvider ? (
    <WorkflowBottomToolbar session={session} />
  ) : (
    <WorkflowEditorProvider value={value}>
      <WorkflowBottomToolbar session={session} />
    </WorkflowEditorProvider>
  )
  return { ...render(ui), onQuickAction }
}

beforeEach(() => {
  chatStoreState.messages = []
  chatStoreState.status = "idle"
  chatStoreState.setPermissionMode = jest.fn()
  chatStoreState.addReferencedWorkflowElement = jest.fn()
})

describe("WorkflowBottomToolbar", () => {
  it("does NOT render AgentRuntime / AgentMode / WebSearch / Skills / generic plugin slot", () => {
    renderWithCtx()
    expect(screen.queryByTestId("agent-runtime-selector")).toBeNull()
    expect(screen.queryByTestId("agent-mode-selector")).toBeNull()
    expect(screen.queryByTestId("external-agent-selector")).toBeNull()
    expect(screen.queryByTestId("web-search-toggle")).toBeNull()
    // No `<SparklesIcon>` skill button id either; nothing with that test id.
    expect(screen.queryByLabelText(/composer\.skillPicker\.trigger/i)).toBeNull()
  })

  it("renders Model + Effort + Permission + Context + 3 quick actions", () => {
    renderWithCtx()
    expect(screen.getByTestId("model-picker")).toBeInTheDocument()
    // The chip is the thinking level's ONLY surface (the model popover no
    // longer carries a copy), so this composer has to mount it or the setting
    // is unreachable from a workflow chat.
    expect(screen.getByTestId("effort-chip")).toBeInTheDocument()
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
    expect(screen.getByTestId("context-gauge")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-quick-action-validate")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-quick-action-explain")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-quick-action-suggest")).toBeInTheDocument()
  })

  it("disables Explain when no nodes are selected", () => {
    renderWithCtx({ selectedIds: [] })
    expect(screen.getByTestId("workflow-quick-action-explain")).toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-validate")).not.toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-suggest")).not.toBeDisabled()
  })

  it("enables Explain when one or more nodes are selected", () => {
    renderWithCtx({ selectedIds: ["n_a", "n_b"] })
    expect(screen.getByTestId("workflow-quick-action-explain")).not.toBeDisabled()
  })

  it("dispatches the correct kind through the workflow CustomEvent on click", () => {
    // The toolbar funnels clicks through `dispatchWorkflowSlashAction` first
    // (the same path `/validate`, `/explain`, `/suggest` slash commands take)
    // and only falls back to `ctx.onQuickAction` when there is no DOM. In
    // jsdom the dispatch path wins, so we assert on the CustomEvent.
    const events: Array<{ kind: string }> = []
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ action: { kind: string } }>).detail
      events.push({ kind: detail.action.kind })
    }
    window.addEventListener("workflow-copilot:dispatch-action", listener)
    try {
      const onQuickAction = jest.fn()
      renderWithCtx({ selectedIds: ["n_a"], onQuickAction })
      fireEvent.click(screen.getByTestId("workflow-quick-action-validate"))
      fireEvent.click(screen.getByTestId("workflow-quick-action-explain"))
      fireEvent.click(screen.getByTestId("workflow-quick-action-suggest"))
      expect(events.map((e) => e.kind)).toEqual(["validate", "explain", "suggest"])
      // The fallback `ctx.onQuickAction` must NOT fire when the DOM dispatch
      // succeeded, otherwise the toolbar would double-dispatch slash actions.
      expect(onQuickAction).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("workflow-copilot:dispatch-action", listener)
    }
  })

  it("disables all quick actions while streaming", () => {
    chatStoreState.status = "streaming"
    renderWithCtx({ selectedIds: ["n_a"] })
    expect(screen.getByTestId("workflow-quick-action-reference")).toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-validate")).toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-explain")).toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-suggest")).toBeDisabled()
  })

  describe("reference selection", () => {
    it("disables Reference when nothing is selected", () => {
      renderWithCtx({ selectedIds: [], selectedEdgeIds: [] })
      expect(screen.getByTestId("workflow-quick-action-reference")).toBeDisabled()
    })

    it("enables Reference when a node or an edge is selected", () => {
      renderWithCtx({ selectedIds: [], selectedEdgeIds: ["e_1"] })
      expect(screen.getByTestId("workflow-quick-action-reference")).not.toBeDisabled()
    })

    it("stages the selected nodes as reference chips and pulses the first", () => {
      const pulseNode = jest.fn()
      const nodes = [
        { id: "n_a", data: { kind: "ai.prompt", label: "Draft" } },
        { id: "n_b", data: { kind: "flow.branch", label: "Split" } },
      ]
      renderWithCtx({ selectedIds: ["n_a", "n_b"], nodes, pulseNode })
      fireEvent.click(screen.getByTestId("workflow-quick-action-reference"))
      expect(chatStoreState.addReferencedWorkflowElement).toHaveBeenCalledTimes(2)
      expect(chatStoreState.addReferencedWorkflowElement).toHaveBeenCalledWith({
        type: "node",
        id: "n_a",
        label: "Draft",
        kind: "ai.prompt",
      })
      expect(pulseNode).toHaveBeenCalledWith("n_a", 1200)
    })
  })

  it("renders nothing for the quick-action group when context is missing", () => {
    renderWithCtx({ noProvider: true })
    expect(screen.queryByTestId("workflow-quick-actions")).toBeNull()
    // But the tier-1 controls are still present.
    expect(screen.getByTestId("model-picker")).toBeInTheDocument()
    expect(screen.getByTestId("effort-chip")).toBeInTheDocument()
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
  })
})
