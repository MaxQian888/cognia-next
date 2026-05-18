/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import type { ChatSession } from "@/lib/claude/types"
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
}
jest.mock("@/stores/chat", () => ({
  useChatStore: <T,>(selector: (s: typeof chatStoreState) => T) => selector(chatStoreState),
}))

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

function fakeStoreWithSelection(selectedIds: string[]): EditorStore {
  const fakeState = { selectedNodeIds: selectedIds } as unknown as EditorState
  const hook = (<T,>(selector: (s: EditorState) => T): T =>
    selector(fakeState)) as unknown as EditorStore
  return hook
}

function renderWithCtx(
  opts: {
    selectedIds?: string[]
    onQuickAction?: WorkflowEditorContextValue["onQuickAction"]
    noProvider?: boolean
  } = {}
) {
  const onQuickAction = opts.onQuickAction ?? jest.fn<void, [WorkflowQuickActionKind]>()
  const value: WorkflowEditorContextValue = {
    useEditorStore: fakeStoreWithSelection(opts.selectedIds ?? []),
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

  it("renders Model + Permission + Context + 3 quick actions", () => {
    renderWithCtx()
    expect(screen.getByTestId("model-picker")).toBeInTheDocument()
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

  it("dispatches the correct kind through ctx.onQuickAction on click", () => {
    const onQuickAction = jest.fn()
    renderWithCtx({ selectedIds: ["n_a"], onQuickAction })
    fireEvent.click(screen.getByTestId("workflow-quick-action-validate"))
    fireEvent.click(screen.getByTestId("workflow-quick-action-explain"))
    fireEvent.click(screen.getByTestId("workflow-quick-action-suggest"))
    expect(onQuickAction).toHaveBeenNthCalledWith(1, "validate")
    expect(onQuickAction).toHaveBeenNthCalledWith(2, "explain")
    expect(onQuickAction).toHaveBeenNthCalledWith(3, "suggest")
  })

  it("disables all quick actions while streaming", () => {
    chatStoreState.status = "streaming"
    renderWithCtx({ selectedIds: ["n_a"] })
    expect(screen.getByTestId("workflow-quick-action-validate")).toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-explain")).toBeDisabled()
    expect(screen.getByTestId("workflow-quick-action-suggest")).toBeDisabled()
  })

  it("renders nothing for the quick-action group when context is missing", () => {
    renderWithCtx({ noProvider: true })
    expect(screen.queryByTestId("workflow-quick-actions")).toBeNull()
    // But the tier-1 controls are still present.
    expect(screen.getByTestId("model-picker")).toBeInTheDocument()
    expect(screen.getByTestId("permission-mode-indicator")).toBeInTheDocument()
  })
})
