// Tests for ChatPane callback stability and render behavior.
// Focuses on the perf-critical path: stable useCallback refs prevent
// MessageRenderer from re-rendering on every ChatPane re-render.

import * as ReactForMocks from "react"

jest.mock("./composer", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  return {
    // forwardRef so the callback ref ChatPane now attaches doesn't warn.
    Composer: react.forwardRef(function Composer(_props: unknown, ref: React.Ref<unknown>) {
      react.useImperativeHandle(ref, () => ({ insertMention: () => {}, focus: () => {} }), [])
      return react.createElement("div", { "data-testid": "composer" })
    }),
  }
})
jest.mock("./chat-header", () => ({
  ChatHeader: jest.fn(() => null),
}))
jest.mock("./character-missing-banner", () => ({
  CharacterMissingBanner: () => null,
}))
jest.mock("./empty-state", () => ({ EmptyChatState: jest.fn(() => null) }))
jest.mock("./inline-error", () => ({ InlineError: jest.fn(() => null) }))
jest.mock("./message-list", () => ({
  MessageList: jest.fn(() => null),
}))
jest.mock("./workspace-changes-card", () => ({
  WorkspaceChangesCard: ({ session }: { session: { id: string } }) => (
    <div data-testid="workspace-changes-card" data-session={session.id} />
  ),
}))
jest.mock("@/components/agent/external-agent/session-panel", () => ({
  ExternalAgentSessionPanel: () => null,
}))
jest.mock("next-intl", () => {
  // Stable function reference — prevents useCallback deps from changing across renders
  const t = (k: string) => k
  return { useTranslations: () => t }
})

const storeState = {
  messages: [{ id: "m1", role: "user", parts: [] }] as unknown[],
  status: "idle",
  errorMessage: null as string | null,
  messagesLoading: false,
  messagesLoadError: null as string | null,
  atCapacity: false,
  // Raw-selector consumers (RunPanel's usage signature) read per-session
  // slices directly off the state object.
  sessions: {} as Record<string, { messages: unknown[] }>,
  setSessionError: jest.fn(),
  requestSessionMessagesReload: jest.fn(),
}

// ChatPane now reads its bound session via the per-session selector hooks; the
// test models a single session whose slice IS `storeState`.
jest.mock("@/stores/chat", () => ({
  useChatStore: Object.assign(
    jest.fn((sel: (s: typeof storeState) => unknown) => sel(storeState)),
    { getState: () => storeState, subscribe: () => () => {} }
  ),
  useSessionMessages: () => storeState.messages,
  useSessionStatus: () => storeState.status,
  useSessionErrorMessage: () => storeState.errorMessage,
  useSessionHasMessages: () => storeState.messages.length > 0,
  useSessionMessagesLoading: () => storeState.messagesLoading,
  useSessionMessagesLoadError: () => storeState.messagesLoadError,
  useIsAtStreamCap: () => storeState.atCapacity,
  useSessionRunTiming: () => ({ startedAt: null, pausedAt: null, pausedAccumMs: 0 }),
  useSessionSteerQueue: () => [],
  useSessionRunId: () => 0,
  useSessionToolTimestamps: () => ({}),
}))

// Welcome-section dismissal persistence (AppSettings.welcomeHidden).
jest.mock("@/stores/settings", () => {
  const state = {
    settings: null as { welcomeHidden?: { tryPrompt?: boolean } } | null,
    save: jest.fn(),
  }
  const useSettingsStore = Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    getState: () => state,
  })
  return { useSettingsStore, __settingsState: state }
})

// ChatPane resolves the active character to surface its exemplar prompts.
jest.mock("@/lib/data-hooks/context", () => ({
  useCharacter: jest.fn(() => undefined),
}))

jest.mock("@/hooks/ui/use-mobile", () => ({
  useIsMobile: () => false,
}))

import { render, screen } from "@testing-library/react"
import { SparklesIcon } from "lucide-react"
import { ChatPane } from "./chat-view"
import { MessageList } from "./message-list"
import { InlineError } from "./inline-error"
import { SIDECAR_EXITED_ERROR } from "@/hooks/chat/use-claude-chat"
import type { ChatSession, SendContent } from "@cognia/agent-config-types"

const mockSession = { id: "s1", title: "Test" } as unknown as ChatSession

function makeProps() {
  return {
    activeSession: mockSession,
    onSend: jest.fn(async (_c: SendContent) => {}),
    onStop: jest.fn(async () => {}),
    onRegenerate: jest.fn(async () => {}),
    onEditResend: jest.fn(async (_id: string, _content: SendContent) => {}),
    onCreate: jest.fn(),
    onUseSample: jest.fn(),
    onOpenSettings: jest.fn(),
  }
}

describe("ChatPane", () => {
  it("mounts the workspace changes card for this pane's session", () => {
    render(<ChatPane {...makeProps()} />)
    expect(screen.getByTestId("workspace-changes-card")).toHaveAttribute("data-session", "s1")
  })

  it("passes stable onCopy reference across re-renders", () => {
    const MockList = MessageList as jest.Mock
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    const firstOnCopy = MockList.mock.calls[0]?.[0]?.onCopy
    expect(firstOnCopy).toBeDefined()

    MockList.mockClear()
    // Re-render with fresh prop objects — same logical values, new references
    rerender(<ChatPane {...makeProps()} />)
    const secondOnCopy = MockList.mock.calls[0]?.[0]?.onCopy

    // useCallback keeps the same reference when deps haven't changed
    expect(firstOnCopy).toBe(secondOnCopy)
  })

  it("passes stable onRegenerate reference when prop is unchanged", () => {
    // When ChatPane re-renders (e.g. due to store messages update) but the
    // shell-level onRegenerate prop stays the same, handleRegenerate should
    // not change reference so MessageRenderer memo stays effective.
    const MockList = MessageList as jest.Mock
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    const first = MockList.mock.calls[0]?.[0]?.onRegenerate
    MockList.mockClear()
    rerender(<ChatPane {...props} />) // same props — simulates a store update re-render
    const second = MockList.mock.calls[0]?.[0]?.onRegenerate

    expect(first).toBe(second)
  })

  it("maps the sidecar-exited sentinel error to a localized message", () => {
    const MockInlineError = InlineError as jest.Mock
    MockInlineError.mockClear()
    storeState.errorMessage = SIDECAR_EXITED_ERROR
    try {
      render(<ChatPane {...makeProps()} />)
      // next-intl mock returns the key, so the mapped message is the i18n key.
      expect(MockInlineError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "sidecarExited" }),
        undefined
      )
    } finally {
      storeState.errorMessage = null
    }
  })

  it("passes any other error message through unchanged", () => {
    const MockInlineError = InlineError as jest.Mock
    MockInlineError.mockClear()
    storeState.errorMessage = "network down"
    try {
      render(<ChatPane {...makeProps()} />)
      expect(MockInlineError).toHaveBeenCalledWith(
        expect.objectContaining({ message: "network down" }),
        undefined
      )
    } finally {
      storeState.errorMessage = null
    }
  })

  it("passes stable onEditResend reference when prop is unchanged", () => {
    const MockList = MessageList as jest.Mock
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    const first = MockList.mock.calls[0]?.[0]?.onEditResend
    MockList.mockClear()
    rerender(<ChatPane {...props} />)
    const second = MockList.mock.calls[0]?.[0]?.onEditResend

    expect(first).toBe(second)
  })

  it("renders EmptyChatState when activeSession is null", () => {
    const { EmptyChatState } = jest.requireMock("./empty-state") as {
      EmptyChatState: jest.Mock
    }
    EmptyChatState.mockReturnValue(ReactForMocks.createElement("div", { "data-test": "empty" }))
    render(<ChatPane {...makeProps()} activeSession={null} />)
    expect(document.querySelector("[data-test='empty']")).toBeTruthy()
  })

  it("renders EmptyChatState inline when session exists but messages list is empty", () => {
    const savedMessages = storeState.messages
    storeState.messages = []
    const { EmptyChatState } = jest.requireMock("./empty-state") as {
      EmptyChatState: jest.Mock
    }
    EmptyChatState.mockReturnValue(
      ReactForMocks.createElement("div", { "data-test": "empty-inline" })
    )
    render(<ChatPane {...makeProps()} />)
    expect(document.querySelector("[data-test='empty-inline']")).toBeTruthy()
    storeState.messages = savedMessages
  })

  it("onCopy callback invokes handleCopySuccess without throwing", () => {
    const MockList = MessageList as jest.Mock
    MockList.mockClear()
    render(<ChatPane {...makeProps()} />)
    const onCopy = MockList.mock.calls[0]?.[0]?.onCopy as (() => void) | undefined
    expect(onCopy).toBeDefined()
    expect(() => onCopy?.()).not.toThrow()
  })

  it("onRegenerate callback delegates to the prop", async () => {
    const MockList = MessageList as jest.Mock
    MockList.mockClear()
    const props = makeProps()
    render(<ChatPane {...props} />)
    const onRegenerate = MockList.mock.calls[0]?.[0]?.onRegenerate as
      (() => void | Promise<void>) | undefined
    expect(onRegenerate).toBeDefined()
    await onRegenerate?.()
    expect(props.onRegenerate).toHaveBeenCalled()
  })

  it("onEditResend callback delegates to the prop with id and content", async () => {
    const MockList = MessageList as jest.Mock
    MockList.mockClear()
    const props = makeProps()
    render(<ChatPane {...props} />)
    const onEditResend = MockList.mock.calls[0]?.[0]?.onEditResend as
      ((id: string, content: unknown) => void | Promise<void>) | undefined
    expect(onEditResend).toBeDefined()
    await onEditResend?.("msg-1", { text: "edited" })
    expect(props.onEditResend).toHaveBeenCalledWith("msg-1", { text: "edited" })
  })

  describe("concurrency cap", () => {
    it("renders the over-capacity notice when the bound session is at the stream cap", () => {
      storeState.atCapacity = true
      const { getByRole } = render(<ChatPane {...makeProps()} />)
      const notice = getByRole("status")
      expect(notice.textContent).toContain("overCapacity")
      storeState.atCapacity = false
    })

    it("omits the over-capacity notice when below the cap", () => {
      storeState.atCapacity = false
      const { queryByRole } = render(<ChatPane {...makeProps()} />)
      expect(queryByRole("status")).toBeNull()
    })

    it("binds to an explicit sessionId prop over the active session", () => {
      const MockList = MessageList as jest.Mock
      MockList.mockClear()
      // No assertion on slice value here (mock is single-session); this simply
      // exercises the sessionId-prop branch of `boundId` without throwing.
      expect(() => render(<ChatPane {...makeProps()} sessionId="explicit" />)).not.toThrow()
    })
  })

  describe("showHeader prop", () => {
    it("renders ChatHeader by default", () => {
      const { ChatHeader } = jest.requireMock("./chat-header") as {
        ChatHeader: jest.Mock
      }
      ChatHeader.mockClear()
      render(<ChatPane {...makeProps()} />)
      expect(ChatHeader).toHaveBeenCalled()
    })

    it("omits ChatHeader when showHeader is false", () => {
      const { ChatHeader } = jest.requireMock("./chat-header") as {
        ChatHeader: jest.Mock
      }
      ChatHeader.mockClear()
      render(<ChatPane {...makeProps()} showHeader={false} />)
      expect(ChatHeader).not.toHaveBeenCalled()
    })
  })

  describe("welcome layout (no messages)", () => {
    const { EmptyChatState } = jest.requireMock("./empty-state") as {
      EmptyChatState: jest.Mock
    }

    it("docks the composer below the empty state instead of centering it inside", () => {
      const saved = storeState.messages
      storeState.messages = []
      EmptyChatState.mockClear()
      EmptyChatState.mockReturnValue(
        ReactForMocks.createElement("div", { "data-testid": "empty-state" })
      )
      render(<ChatPane {...makeProps()} />)
      const props = EmptyChatState.mock.calls.at(-1)?.[0]
      expect(props?.composerSlot).toBeUndefined()
      expect(props?.variant).toBe("inline")
      // Welcome content renders above, the live composer below it.
      const empty = document.querySelector("[data-testid='empty-state']")
      const composer = document.querySelector("[data-testid='composer']")
      expect(empty).toBeTruthy()
      expect(composer).toBeTruthy()
      expect(
        empty!.compareDocumentPosition(composer!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
      storeState.messages = saved
    })

    it("renders MessageList and docks the composer once messages exist", () => {
      const MockList = MessageList as jest.Mock
      EmptyChatState.mockClear()
      MockList.mockClear()
      render(<ChatPane {...makeProps()} />) // default storeState has one message
      expect(EmptyChatState).not.toHaveBeenCalled()
      expect(MockList).toHaveBeenCalled()
    })

    it("forwards welcomeHidden from settings and persists a section dismissal", () => {
      const saved = storeState.messages
      storeState.messages = []
      const { __settingsState } = jest.requireMock("@/stores/settings") as {
        __settingsState: {
          settings: { welcomeHidden?: { tryPrompt?: boolean } } | null
          save: jest.Mock
        }
      }
      __settingsState.settings = { welcomeHidden: { tryPrompt: true } }
      EmptyChatState.mockClear()
      EmptyChatState.mockReturnValue(null)
      render(<ChatPane {...makeProps()} />)
      const props = EmptyChatState.mock.calls.at(-1)?.[0]
      expect(props?.hiddenSections).toEqual({ tryPrompt: true })
      // Dismissing persists the flag via settings.save (merging existing flags).
      props?.onDismissSection?.("tryPrompt")
      expect(__settingsState.save).toHaveBeenCalledWith({
        welcomeHidden: { tryPrompt: true },
      })
      __settingsState.settings = null
      __settingsState.save.mockClear()
      storeState.messages = saved
    })

    it("forwards recentSessions / onResumeSession to the empty state", () => {
      const saved = storeState.messages
      storeState.messages = []
      EmptyChatState.mockClear()
      EmptyChatState.mockReturnValue(null)
      const onResumeSession = jest.fn()
      const recentSessions = [{ id: "a", title: "A", updatedAt: 1 }]
      render(
        <ChatPane
          {...makeProps()}
          recentSessions={recentSessions}
          onResumeSession={onResumeSession}
        />
      )
      const props = EmptyChatState.mock.calls.at(-1)?.[0]
      expect(props?.recentSessions).toBe(recentSessions)
      expect(props?.onResumeSession).toBe(onResumeSession)
      storeState.messages = saved
    })

    it("forwards the emptyState override to the empty state", () => {
      const saved = storeState.messages
      storeState.messages = []
      EmptyChatState.mockClear()
      EmptyChatState.mockReturnValue(null)
      const emptyState = {
        title: "Build or refine this workflow",
        samplesHeading: "Workflow starters",
        samples: [{ key: "build", icon: SparklesIcon, title: "Scaffold", prompt: "Build it" }],
      }
      render(<ChatPane {...makeProps()} emptyState={emptyState} />)
      const props = EmptyChatState.mock.calls.at(-1)?.[0]
      expect(props?.override).toBe(emptyState)
      storeState.messages = saved
    })
  })
})
