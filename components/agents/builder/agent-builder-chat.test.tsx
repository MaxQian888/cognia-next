/** @jest-environment jsdom */

// The builder conversation (ADR-0220): the chat pane bound to the builder
// session. The pane itself is stubbed to a probe; the cases prove the history
// load, the send routing through the one chat runtime, and the starters.

import { act, render, screen, waitFor } from "@testing-library/react"

import type { UIMessage } from "ai"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))
jest.mock("@/lib/db/messages", () => ({ listMessages: jest.fn() }))
jest.mock("@/hooks/chat/use-claude-chat", () => ({ useClaudeChat: jest.fn() }))
jest.mock("@/stores/chat", () => {
  const state = {
    sessions: {} as Record<string, { messagesReloadNonce?: number }>,
    setSessionMessages: jest.fn(),
    setSessionMessagesLoadError: jest.fn(),
  }
  const useChatStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state,
  })
  return { useChatStore }
})
jest.mock("@/components/chat/chat-scope-provider", () => ({
  ChatScopeProvider: ({
    sessionId,
    children,
  }: {
    sessionId: string
    children: React.ReactNode
  }) => (
    <div data-testid="chat-scope" data-session={sessionId}>
      {children}
    </div>
  ),
}))

interface PaneProps {
  activeSession: ChatSession
  sessionId: string
  onSend: (...args: unknown[]) => Promise<void>
  onStop: () => void
  onRegenerate: () => void
  onEditResend: (messageId: string, content: string) => void
  onCreate: () => unknown
  onUseSample: (text: string) => void
  onOpenSettings: (tab?: string) => void
  showHeader: boolean
  emptyState: {
    title: string
    subtitle: string
    samplesHeading: string
    samples: { key: string; title: string; prompt: string }[]
  }
}
let paneProps: PaneProps
jest.mock("@/components/chat/chat-view", () => ({
  ChatPane: (props: PaneProps) => {
    paneProps = props
    return <div data-testid="chat-pane" />
  },
}))

import { toast } from "sonner"
import { listMessages } from "@/lib/db/messages"
import { useClaudeChat } from "@/hooks/chat/use-claude-chat"
import { useChatStore } from "@/stores/chat"
import { AgentBuilderChat, buildAgentBuilderStarters } from "./agent-builder-chat"

const listMessagesMock = listMessages as jest.Mock
const useClaudeChatMock = useClaudeChat as jest.Mock
const toastError = toast.error as jest.Mock
const store = useChatStore.getState() as unknown as {
  sessions: Record<string, { messagesReloadNonce?: number }>
  setSessionMessages: jest.Mock
  setSessionMessagesLoadError: jest.Mock
}

const claude = {
  send: jest.fn((..._args: unknown[]) => Promise.resolve()),
  stop: jest.fn(),
  regenerate: jest.fn(),
  editAndResend: jest.fn(),
}

const session = {
  id: "s1",
  title: "Agent Builder",
  kind: "agent-builder",
} as unknown as ChatSession
const messages = [{ id: "m1" }] as unknown as UIMessage[]

beforeEach(() => {
  jest.clearAllMocks()
  store.sessions = {}
  useClaudeChatMock.mockReturnValue(claude)
  claude.send.mockImplementation(() => Promise.resolve())
  listMessagesMock.mockResolvedValue(messages)
})

describe("buildAgentBuilderStarters", () => {
  it("offers three translated examples", () => {
    const starters = buildAgentBuilderStarters((key) => `t:${key}`)
    expect(starters.map((s) => s.key)).toEqual(["pr-review", "research", "planning"])
    expect(starters[0]).toMatchObject({
      title: "t:starters.reviewTitle",
      prompt: "t:starters.reviewPrompt",
    })
    expect(starters[1]).toMatchObject({
      title: "t:starters.researchTitle",
      prompt: "t:starters.researchPrompt",
    })
    expect(starters[2]).toMatchObject({
      title: "t:starters.planTitle",
      prompt: "t:starters.planPrompt",
    })
    for (const s of starters) expect(s.icon).toBeDefined()
  })
})

describe("AgentBuilderChat", () => {
  it("renders the pane in the session's scope, without a header", async () => {
    render(<AgentBuilderChat session={session} />)
    expect(screen.getByTestId("agent-builder-chat")).toBeInTheDocument()
    expect(screen.getByTestId("chat-scope")).toHaveAttribute("data-session", "s1")
    expect(paneProps.activeSession).toBe(session)
    expect(paneProps.sessionId).toBe("s1")
    expect(paneProps.showHeader).toBe(false)
    expect(paneProps.onCreate()).toBeUndefined()
    await waitFor(() => expect(store.setSessionMessages).toHaveBeenCalled())
  })

  it("titles the empty conversation with the builder's copy and starters", async () => {
    render(<AgentBuilderChat session={session} />)
    expect(paneProps.emptyState.title).toBe("What should this agent do?")
    expect(paneProps.emptyState.subtitle).toMatch(/^Describe what this agent should do/)
    expect(paneProps.emptyState.samplesHeading).toBe("Start from an example")
    expect(paneProps.emptyState.samples.map((s) => s.title)).toEqual([
      "Review frontend pull requests",
      "Research competitors and summarize findings",
      "Help our team plan and write projects",
    ])
    await waitFor(() => expect(store.setSessionMessages).toHaveBeenCalled())
  })

  it("loads the conversation's history into the store", async () => {
    render(<AgentBuilderChat session={session} />)
    expect(listMessagesMock).toHaveBeenCalledWith("s1")
    await waitFor(() => expect(store.setSessionMessages).toHaveBeenCalledWith("s1", messages))
    expect(store.setSessionMessagesLoadError).not.toHaveBeenCalled()
  })

  it.each([
    ["an Error", new Error("disk gone"), "disk gone"],
    ["a non-Error", "plain failure", "plain failure"],
  ])("records the load error from %s", async (_n, err, message) => {
    listMessagesMock.mockRejectedValue(err)
    render(<AgentBuilderChat session={session} />)
    await waitFor(() =>
      expect(store.setSessionMessagesLoadError).toHaveBeenCalledWith("s1", message)
    )
    expect(store.setSessionMessages).not.toHaveBeenCalled()
  })

  it("ignores a load that settles after unmount", async () => {
    let resolve: (value: UIMessage[]) => void = () => undefined
    listMessagesMock.mockImplementation(() => new Promise<UIMessage[]>((r) => (resolve = r)))
    const { unmount } = render(<AgentBuilderChat session={session} />)
    unmount()
    await act(async () => resolve(messages))
    expect(store.setSessionMessages).not.toHaveBeenCalled()
  })

  it("ignores a failed load that settles after unmount", async () => {
    let reject: (err: unknown) => void = () => undefined
    listMessagesMock.mockImplementation(() => new Promise<UIMessage[]>((_r, j) => (reject = j)))
    const { unmount } = render(<AgentBuilderChat session={session} />)
    unmount()
    await act(async () => reject(new Error("late")))
    expect(store.setSessionMessagesLoadError).not.toHaveBeenCalled()
  })

  it("reloads the history when the store's reload nonce moves", async () => {
    const { rerender } = render(<AgentBuilderChat session={session} />)
    await waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(1))
    store.sessions = { s1: { messagesReloadNonce: 1 } }
    rerender(<AgentBuilderChat session={session} />)
    await waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(2))
  })

  it("sends through the chat runtime on the builder session", async () => {
    render(<AgentBuilderChat session={session} />)
    const manifest = [{ id: "att" }]
    const templateRun = { templateId: "tpl" }
    await act(() =>
      paneProps.onSend("hello", manifest, templateRun, {
        replyTo: { messageId: "m0" },
        targetMemberIds: [],
      })
    )
    expect(claude.send).toHaveBeenCalledWith("hello", undefined, {
      sessionId: "s1",
      attachmentManifest: manifest,
      templateRun,
      replyTo: { messageId: "m0" },
    })
  })

  it("omits the template run when there is none", async () => {
    render(<AgentBuilderChat session={session} />)
    await act(() => paneProps.onSend("hi", undefined, null))
    expect(claude.send).toHaveBeenCalledWith("hi", undefined, {
      sessionId: "s1",
      attachmentManifest: undefined,
    })
  })

  it.each([
    ["an Error", new Error("no provider"), "no provider"],
    ["a non-Error", "nope", "nope"],
  ])("toasts a send that fails with %s", async (_n, err, message) => {
    claude.send.mockImplementation(() => Promise.reject(err))
    render(<AgentBuilderChat session={session} />)
    await act(() => paneProps.onSend("hello"))
    expect(toastError).toHaveBeenCalledWith(message)
  })

  it("sends a starter's prompt as a message", async () => {
    render(<AgentBuilderChat session={session} />)
    act(() => paneProps.onUseSample("Build a reviewer"))
    await waitFor(() =>
      expect(claude.send).toHaveBeenCalledWith("Build a reviewer", undefined, {
        sessionId: "s1",
        attachmentManifest: undefined,
      })
    )
  })

  it("routes stop, regenerate and edit-resend to the builder session", async () => {
    render(<AgentBuilderChat session={session} />)
    paneProps.onStop()
    expect(claude.stop).toHaveBeenCalledWith("s1")
    paneProps.onRegenerate()
    expect(claude.regenerate).toHaveBeenCalledWith("s1")
    paneProps.onEditResend("m2", "edited")
    expect(claude.editAndResend).toHaveBeenCalledWith("m2", "edited", "s1")
    await waitFor(() => expect(store.setSessionMessages).toHaveBeenCalled())
  })

  it("forwards settings requests, and tolerates a host without one", async () => {
    const onOpenSettings = jest.fn()
    const { rerender } = render(
      <AgentBuilderChat session={session} onOpenSettings={onOpenSettings} />
    )
    paneProps.onOpenSettings("providers")
    expect(onOpenSettings).toHaveBeenCalledWith("providers")
    rerender(<AgentBuilderChat session={session} />)
    expect(() => paneProps.onOpenSettings("providers")).not.toThrow()
    await waitFor(() => expect(store.setSessionMessages).toHaveBeenCalled())
  })
})
