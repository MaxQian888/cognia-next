/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

// ── Mocks ───────────────────────────────────────────────────────────────
// ChatPane is exercised by its own suite — here we stub it to surface the
// session it is bound to (`activeSession.id`) and to expose the `onCreate`
// callback as a clickable button.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: (props: { activeSession: { id: string } | null; onCreate: () => void }) => (
    <div data-testid="chatpane" data-session-id={props.activeSession?.id ?? "none"}>
      <button type="button" data-testid="chatpane-create" onClick={() => props.onCreate()}>
        create
      </button>
    </div>
  ),
}))

// SessionBar has its own suite — stub it so we can read the id it receives.
jest.mock("@/components/workflow/editor/chat/session-bar", () => ({
  WorkflowSessionBar: (props: { activeSessionId: string }) => (
    <div data-testid="session-bar" data-session-id={props.activeSessionId} />
  ),
}))

jest.mock("@/hooks/chat/use-claude-chat", () => ({
  useClaudeChat: () => ({
    send: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    regenerate: jest.fn(async () => undefined),
    editAndResend: jest.fn(async () => undefined),
  }),
}))

// Keep the real `createWorkflowEditorSession` + `workflowSessionId` so the
// onCreate path actually persists; only the pinning hook is overridden.
jest.mock("@/hooks/chat/use-workflow-editor-session", () => {
  const actual = jest.requireActual("@/hooks/chat/use-workflow-editor-session")
  return { ...actual, useWorkflowEditorSession: jest.fn() }
})

const sessionsPut = jest.fn(async () => undefined)
const sessionsGet = jest.fn(async () => undefined)
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ sessions: { put: sessionsPut, get: sessionsGet } }),
}))

jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn(async () => []) }))

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))

jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn() } }))

jest.mock("@/lib/perf", () => ({
  PerfBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/lib/workflow/editor/workflow-editor-context", () => ({
  WorkflowEditorProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))
jest.mock("@/lib/workflow/editor/quick-action-prompts", () => ({
  buildQuickActionPrompt: () => null,
}))
jest.mock("@/lib/workflow/editor/mention-expand", () => ({
  expandWorkflowMentions: (x: string) => x,
  snapshotFromEditorState: () => ({}),
}))
jest.mock("@/lib/slash-commands/actions/workflow", () => ({
  WORKFLOW_COPILOT_DISPATCH_EVENT: "workflow-copilot-dispatch",
  buildWorkflowSlashPrompt: () => null,
}))
jest.mock("./workflow-chat-starters", () => ({ buildWorkflowChatStarters: () => [] }))

import { waitFor } from "@testing-library/react"
import { useLiveQuery } from "dexie-react-hooks"
import { listMessages } from "@/lib/db/messages"
import { useWorkflowEditorSession } from "@/hooks/chat/use-workflow-editor-session"
import { useChatStore } from "@/stores/chat"
import { WorkflowEditorChatTab } from "./chat-tab"

const mLive = useLiveQuery as jest.Mock
const mSession = useWorkflowEditorSession as jest.Mock
const mListMessages = listMessages as jest.Mock

const DEFAULT_SESSION = {
  id: "workflow:wf_a",
  title: "My Flow — chat",
  kind: "workflow-editor" as const,
  createdAt: 0,
  updatedAt: 0,
}

const MESSAGES = {
  workflowEditor: {
    chat: {
      noWorkflow: "No workflow",
      loading: "Loading",
      ariaLabel: "Copilot for {name}",
      starters: { title: "T", subtitle: "S", heading: "H" },
      session: { newDefault: "Workflow chat", newSuffixed: "{name} — extra" },
    },
  },
}

// Minimal EditorStore stub — the tab only reads it on send/quick-action.
const useStore = Object.assign(() => undefined, {
  getState: () => ({}),
  setState: () => undefined,
  subscribe: () => () => undefined,
}) as never

function harness() {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never}>
      <WorkflowEditorChatTab useStore={useStore} workflowId="wf_a" workflowName="My Flow" />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  mSession.mockReturnValue({
    session: DEFAULT_SESSION,
    sessionId: DEFAULT_SESSION.id,
    loading: false,
  })
  mLive.mockReturnValue(undefined)
  mListMessages.mockResolvedValue([])
  act(() => useChatStore.getState().clear())
  act(() => useChatStore.getState().setActiveSession(DEFAULT_SESSION.id))
})

describe("WorkflowEditorChatTab session wiring", () => {
  it("binds the ChatPane to the store's active session when it is an additional workflow session", () => {
    const branch = { ...DEFAULT_SESSION, id: "workflow:wf_a:branch", title: "Branch" }
    mLive.mockReturnValue(branch)
    act(() => useChatStore.getState().setActiveSession(branch.id))

    harness()

    expect(screen.getByTestId("chatpane")).toHaveAttribute(
      "data-session-id",
      "workflow:wf_a:branch"
    )
    expect(screen.getByTestId("session-bar")).toHaveAttribute(
      "data-session-id",
      "workflow:wf_a:branch"
    )
  })

  it("falls back to the default session when the store points elsewhere", () => {
    act(() => useChatStore.getState().setActiveSession(DEFAULT_SESSION.id))
    harness()
    expect(screen.getByTestId("chatpane")).toHaveAttribute("data-session-id", "workflow:wf_a")
  })

  it("hydrates the active session's history from Dexie on mount", async () => {
    mListMessages.mockResolvedValue([{ id: "m1" }])
    harness()
    await waitFor(() =>
      expect(useChatStore.getState().sessions["workflow:wf_a"]?.messages).toEqual([{ id: "m1" }])
    )
    expect(mListMessages).toHaveBeenCalledWith("workflow:wf_a")
  })

  it("creates a new workflow session when ChatPane's onCreate fires", async () => {
    const user = userEvent.setup()
    harness()
    await user.click(screen.getByTestId("chatpane-create"))
    expect(sessionsPut).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "workflow-editor",
        id: expect.stringMatching(/^workflow:wf_a:/),
      })
    )
  })
})
