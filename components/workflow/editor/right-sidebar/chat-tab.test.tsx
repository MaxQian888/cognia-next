/**
 * @jest-environment jsdom
 */
import { act, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { AttachmentManifestEntry } from "@/lib/chat/attachments/dispatch"

const attachmentManifest: readonly AttachmentManifestEntry[] = [
  { filename: "workflow.md", mediaType: "text/markdown", kind: "document" },
]

// ── Mocks ───────────────────────────────────────────────────────────────
// ChatPane is exercised by its own suite — here we stub it to surface the
// session it is bound to (`activeSession.id`) and to expose the `onCreate`
// callback as a clickable button.
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: (props: {
    activeSession: { id: string } | null
    onCreate: () => void
    onUseSample: (text: string) => void
    onSend: (content: string, manifest?: readonly AttachmentManifestEntry[]) => void | Promise<void>
  }) => (
    <div data-testid="chatpane" data-session-id={props.activeSession?.id ?? "none"}>
      <button type="button" data-testid="chatpane-create" onClick={() => props.onCreate()}>
        create
      </button>
      <button
        type="button"
        data-testid="chatpane-use-sample"
        onClick={() => props.onUseSample("add a webhook trigger")}
      >
        use sample
      </button>
      <button
        type="button"
        data-testid="chatpane-send"
        onClick={() => void props.onSend("review the workflow", attachmentManifest)}
      >
        send
      </button>
    </div>
  ),
}))

// SessionBar has its own suite — stub it so we can read the id it receives.
jest.mock("@/components/workflow/editor/chat/session-bar", () => ({
  WorkflowSessionBar: (props: {
    activeSessionId: string
    onSwitchSession?: (id: string) => void
  }) => (
    <div data-testid="session-bar" data-session-id={props.activeSessionId}>
      <button
        type="button"
        data-testid="session-bar-switch"
        onClick={() => props.onSwitchSession?.("workflow:wf_a:branch")}
      />
    </div>
  ),
}))

const claudeSend = jest.fn(async () => undefined)
jest.mock("@/hooks/chat/use-claude-chat", () => ({
  useClaudeChat: () => ({
    send: claudeSend,
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
import { WorkflowEditorChatTab, prependWorkflowRefs } from "./chat-tab"

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

// Minimal EditorStore stub. The tab now also reads nodes/edges (mention
// source) and writes the reference/highlight channels, so the stub answers
// both the hook-call form (selector over an empty graph) and `getState()`.
const editorState = {
  nodes: [] as unknown[],
  edges: [] as unknown[],
  setReferencedNodes: jest.fn(),
  setHighlightedNodes: jest.fn(),
}
const useStore = Object.assign(
  (selector?: (s: typeof editorState) => unknown) =>
    selector ? selector(editorState) : editorState,
  {
    getState: () => editorState,
    setState: () => undefined,
    subscribe: () => () => undefined,
  }
) as never

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
  it("binds the ChatPane to a scoped additional session without global focus", async () => {
    const branch = { ...DEFAULT_SESSION, id: "workflow:wf_a:branch", title: "Branch" }
    mLive.mockReturnValue(branch)
    harness()
    await userEvent.click(screen.getByTestId("session-bar-switch"))

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

  // A starter card must reach `claude.send` as a `SendContent` (string | blocks).
  // Passing a bare `{type,text}` object threw inside the mention-expansion
  // `.map` and the throw was swallowed into an opaque toast — nothing was sent.
  it("sends a starter prompt as SendContent when ChatPane's onUseSample fires", async () => {
    const user = userEvent.setup()
    harness()
    await user.click(screen.getByTestId("chatpane-use-sample"))
    await waitFor(() =>
      expect(claudeSend).toHaveBeenCalledWith("add a webhook trigger", undefined, {
        sessionId: "workflow:wf_a",
        attachmentManifest: undefined,
      })
    )
  })

  it("preserves attachment provenance through workflow mention expansion", async () => {
    const user = userEvent.setup()
    harness()
    await user.click(screen.getByTestId("chatpane-send"))
    await waitFor(() =>
      expect(claudeSend).toHaveBeenCalledWith("review the workflow", undefined, {
        sessionId: "workflow:wf_a",
        attachmentManifest,
      })
    )
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

describe("prependWorkflowRefs", () => {
  it("prepends @node / @edge tokens to a string message", () => {
    const out = prependWorkflowRefs("fix this", [
      { type: "node", id: "n_a", label: "A", kind: "ai.prompt" },
      { type: "edge", id: "e_1", label: "E", kind: "default" },
    ])
    expect(out).toBe("Referring to these workflow elements: @node:n_a @edge:e_1\n\nfix this")
  })

  it("merges into the first text block for block content", () => {
    const out = prependWorkflowRefs([{ type: "text", text: "hi" }] as never, [
      { type: "node", id: "n_a", label: "A", kind: "k" },
    ]) as Array<{ type: string; text: string }>
    expect(out[0].text).toBe("Referring to these workflow elements: @node:n_a\n\nhi")
  })

  it("unshifts a text block when the content has none", () => {
    const out = prependWorkflowRefs([{ type: "image" }] as never, [
      { type: "node", id: "n_a", label: "A", kind: "k" },
    ]) as Array<{ type: string; text?: string }>
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({
      type: "text",
      text: "Referring to these workflow elements: @node:n_a\n\n",
    })
  })
})
