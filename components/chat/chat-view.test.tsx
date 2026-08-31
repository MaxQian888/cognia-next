// Tests for ChatPane callback stability and render behavior.
// Focuses on the perf-critical path: stable useCallback refs prevent
// MessageRenderer from re-rendering on every ChatPane re-render.

import * as ReactForMocks from "react"

const mockComposerProps: Array<Record<string, unknown>> = []
jest.mock("./composer", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  return {
    // forwardRef so the callback ref ChatPane now attaches doesn't warn.
    Composer: react.forwardRef(function Composer(
      props: Record<string, unknown>,
      ref: React.Ref<unknown>
    ) {
      mockComposerProps.push(props)
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
jest.mock("@/components/error/diagnostic-card", () => ({
  InlineError: jest.fn(() => null),
  DiagnosticCard: jest.fn(() => null),
}))
jest.mock("./message-list", () => ({
  MessageList: jest.fn(() => null),
}))
const companionTranscriptMessagesMock = jest.fn((..._args: unknown[]) => null)
jest.mock("./companion-transcript-messages", () => ({
  CompanionTranscriptMessages: (props: Record<string, unknown>) =>
    companionTranscriptMessagesMock(props),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: jest.fn(() => false),
}))
let historyModeMock: "timeline" | "legacy" | null = null
const hydrateSessionHistoryMock = jest.fn()
jest.mock("@/lib/sync/session-history", () => ({
  getSessionHistoryMode: () => historyModeMock,
  hydrateSessionHistory: (...args: unknown[]) => hydrateSessionHistoryMock(...args),
  subscribeSessionHistoryMode: () => () => {},
}))
jest.mock("./workspace-changes-card", () => ({
  WorkspaceChangesCard: ({ session }: { session: { id: string } }) => (
    <div data-testid="workspace-changes-card" data-session={session.id} />
  ),
}))
jest.mock("@/components/agent/external-agent/session-panel", () => ({
  ExternalAgentSessionPanel: () => null,
}))
// Transparent spy over the real AnimatePresence: behavior is untouched, but
// the surface-swap tests can assert the presence mode the pane mounts with.
const animatePresenceProps: Array<Record<string, unknown>> = []
jest.mock("motion/react", () => {
  const actual = jest.requireActual<typeof import("motion/react")>("motion/react")
  const react = jest.requireActual<typeof import("react")>("react")
  return {
    ...actual,
    AnimatePresence: (props: Record<string, unknown>) => {
      animatePresenceProps.push(props)
      return react.createElement(actual.AnimatePresence, props)
    },
  }
})
jest.mock("next-intl", () => {
  // Stable function reference — prevents useCallback deps from changing across renders
  const t = (k: string) => k
  return { useTranslations: () => t }
})

const storeState = {
  messages: [{ id: "m1", role: "user", parts: [] }] as unknown[],
  status: "idle",
  errorMessage: null as string | null,
  errorDiagnostic: null as CogniaDiagnostic | null,
  messagesLoading: false,
  messagesLoadError: null as string | null,
  atCapacity: false,
  ephemeralSkillIds: [] as string[],
  setEphemeralSkillIds: jest.fn((ids: string[]) => {
    storeState.ephemeralSkillIds = ids
  }),
  // Raw-selector consumers (RunPanel's usage signature) read per-session
  // slices directly off the state object.
  sessions: {} as Record<string, { messages: unknown[] }>,
  setSessionError: jest.fn(),
  setSessionMessagesLoadError: jest.fn(),
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
  useSessionErrorDiagnostic: () => storeState.errorDiagnostic,
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
    settings: null as {
      welcomeHidden?: { tryPrompt?: boolean }
      welcomeStyle?: "rich" | "minimal"
      userName?: string
    } | null,
    save: jest.fn(),
    completeOnboarding: jest.fn().mockResolvedValue(undefined),
    skipOnboarding: jest.fn().mockResolvedValue(undefined),
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

jest.mock("@/hooks/chat/use-effective-cwd", () => ({
  useEffectiveCwd: () => "/repo",
}))

interface PendingPromptMockRecord {
  id: string
  sessionId: string
  prompt: string
  skillIds: string[]
  requestId?: string
}

const peekPendingChatPromptMock = jest.fn<PendingPromptMockRecord | null, [string]>(() => null)
const acknowledgePendingChatPromptMock = jest.fn<boolean, [string, string]>(() => true)
jest.mock("@/lib/chat/pending-prompt", () => ({
  peekPendingChatPrompt: (sessionId: string) => peekPendingChatPromptMock(sessionId),
  acknowledgePendingChatPrompt: (sessionId: string, id: string) =>
    acknowledgePendingChatPromptMock(sessionId, id),
}))

type OnboardingRequestMockRecord = null | { state: string; skillId: string }

const readOnboardingRequestMock = jest.fn<OnboardingRequestMockRecord, [string]>(() => null)
const beginOnboardingRequestAttemptMock = jest.fn<unknown, [string]>()
const failOnboardingRequestMock = jest.fn<unknown, [string, string]>()
const reconcileOnboardingRequestMessagesMock = jest.fn<unknown, [string, unknown[]]>()
const hasPersistedInitialOnboardingPromptMock = jest.fn<boolean, [unknown, unknown[]]>(() => false)
const hasPersistedPromptMessageMock = jest.fn<boolean, [string, unknown[]]>(() => false)
jest.mock("@/lib/onboarding/request", () => ({
  readOnboardingRequest: (sessionId: string) => readOnboardingRequestMock(sessionId),
  beginOnboardingRequestAttempt: (sessionId: string) =>
    beginOnboardingRequestAttemptMock(sessionId),
  failOnboardingRequest: (sessionId: string, error: string) =>
    failOnboardingRequestMock(sessionId, error),
  reconcileOnboardingRequestMessages: (sessionId: string, messages: unknown[]) =>
    reconcileOnboardingRequestMessagesMock(sessionId, messages),
  hasPersistedInitialOnboardingPrompt: (request: unknown, messages: unknown[]) =>
    hasPersistedInitialOnboardingPromptMock(request, messages),
  hasPersistedPromptMessage: (prompt: string, messages: unknown[]) =>
    hasPersistedPromptMessageMock(prompt, messages),
}))

const listMessagesMock = jest.fn().mockResolvedValue([])
jest.mock("@/lib/db/messages", () => ({
  listMessages: (sessionId: string) => listMessagesMock(sessionId),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import { SparklesIcon } from "lucide-react"
import { ChatPane } from "./chat-view"
import { MessageList } from "./message-list"
import { DiagnosticCard, InlineError } from "@/components/error/diagnostic-card"
import { chatColumnClass } from "./chat-column"
import { createDiagnostic } from "@cognia/diagnostics"
import type { CogniaDiagnostic } from "@cognia/diagnostics"
import type { ChatSession, SendContent } from "@cognia/agent-config-types"
import { hasWebCompanionTarget } from "@/lib/platform/web-companion"
import { transport as companionTransportMock } from "@/lib/tauri/transport-instance"
import {
  clearComputerUsePipState,
  publishComputerUseActivity,
} from "@/lib/automation/computer-use-pip"
import { EmptyChatState } from "./empty-state"
import { useSettingsStore } from "@/stores/settings"

const settingsState = useSettingsStore.getState() as unknown as {
  settings: {
    welcomeHidden?: { tryPrompt?: boolean }
    welcomeStyle?: "rich" | "minimal"
    userName?: string
  } | null
  completeOnboarding: jest.Mock<Promise<void>, []>
  skipOnboarding: jest.Mock<Promise<void>, [string, string]>
}

const mockSession = { id: "s1", title: "Test" } as unknown as ChatSession
const hasWebCompanionTargetMock = jest.mocked(hasWebCompanionTarget)

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
  beforeEach(() => {
    peekPendingChatPromptMock.mockReset().mockReturnValue(null)
    acknowledgePendingChatPromptMock.mockReset().mockReturnValue(true)
    readOnboardingRequestMock.mockReset().mockReturnValue(null)
    beginOnboardingRequestAttemptMock.mockReset()
    failOnboardingRequestMock.mockReset().mockReturnValue({
      state: "failed",
      skillId: "skill-onboarding",
    })
    reconcileOnboardingRequestMessagesMock.mockReset()
    hasPersistedInitialOnboardingPromptMock.mockReset().mockReturnValue(false)
    hasPersistedPromptMessageMock.mockReset().mockReturnValue(false)
    listMessagesMock.mockReset().mockResolvedValue([])
    storeState.messagesLoading = false
    storeState.ephemeralSkillIds = []
    storeState.setEphemeralSkillIds.mockClear()
    settingsState.completeOnboarding.mockClear()
    settingsState.skipOnboarding.mockClear()
    hasWebCompanionTargetMock.mockReset().mockReturnValue(false)
    historyModeMock = null
    companionTranscriptMessagesMock.mockClear()
    hydrateSessionHistoryMock.mockReset().mockResolvedValue({
      applied: 0,
      total: 0,
      mode: "timeline",
    })
    clearComputerUsePipState()
  })

  it("mounts live Computer Use activity inside the real chat pane", async () => {
    publishComputerUseActivity("s1", "screenshot", {
      ok: true,
      output: "FRAME",
      display_width_px: 1440,
      display_height_px: 900,
    })

    render(<ChatPane {...makeProps()} />)

    expect(await screen.findByRole("region", { name: "title" })).toBeInTheDocument()
    expect(screen.getByRole("img", { name: "screenAlt" })).toHaveAttribute(
      "src",
      "data:image/png;base64,FRAME"
    )
  })

  it("sends a queued configuration prompt once through the normal sender", async () => {
    peekPendingChatPromptMock.mockReturnValue({
      id: "dispatch-1",
      sessionId: "s1",
      prompt: "Configure WebDAV",
      skillIds: ["skill-onboarding"],
      requestId: "request-1",
    })
    readOnboardingRequestMock.mockReturnValue({
      state: "awaiting-input",
      skillId: "skill-onboarding",
    })
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    await waitFor(() =>
      expect(props.onSend).toHaveBeenCalledWith("Configure WebDAV", undefined, undefined, undefined)
    )
    expect(peekPendingChatPromptMock).toHaveBeenCalledWith("s1")
    expect(storeState.setEphemeralSkillIds).toHaveBeenCalledWith(["skill-onboarding"], "s1")
    expect(beginOnboardingRequestAttemptMock).toHaveBeenCalledWith("s1")
    // A resolved sender promise is not a durable dispatch receipt.
    expect(acknowledgePendingChatPromptMock).not.toHaveBeenCalled()

    rerender(<ChatPane {...props} />)
    expect(props.onSend).toHaveBeenCalledTimes(1)
  })

  it("stages skill ids carried by a durable handoff even without request metadata", async () => {
    peekPendingChatPromptMock.mockReturnValue({
      id: "dispatch-skill",
      sessionId: "s1",
      prompt: "Run with the scoped skill",
      skillIds: ["skill-scoped"],
    })
    const props = makeProps()
    render(<ChatPane {...props} />)

    await waitFor(() => expect(props.onSend).toHaveBeenCalled())
    expect(storeState.setEphemeralSkillIds).toHaveBeenCalledWith(["skill-scoped"], "s1")
    expect(acknowledgePendingChatPromptMock).toHaveBeenCalledWith("s1", "dispatch-skill")
  })

  it("never resends a non-onboarding handoff the transcript already carries", async () => {
    // The record now outlives the tab (localStorage, 24h), so a reload between
    // the durable write and the acknowledgement must not dispatch it twice.
    // A legacy handoff has no onboarding record, which is exactly why the
    // transcript, not the record, has to be what proves it already went out.
    readOnboardingRequestMock.mockReturnValue(undefined)
    hasPersistedPromptMessageMock.mockReturnValue(true)
    peekPendingChatPromptMock.mockReturnValue({
      id: "dispatch-replay",
      sessionId: "s1",
      prompt: "Configure the WebDAV target",
      skillIds: [],
    })
    const props = makeProps()
    render(<ChatPane {...props} />)

    await waitFor(() =>
      expect(acknowledgePendingChatPromptMock).toHaveBeenCalledWith("s1", "dispatch-replay")
    )
    expect(props.onSend).not.toHaveBeenCalled()
    expect(reconcileOnboardingRequestMessagesMock).not.toHaveBeenCalled()
  })

  it("retries a durable handoff after a transient transcript read failure", async () => {
    peekPendingChatPromptMock.mockReturnValue({
      id: "dispatch-retry",
      sessionId: "s1",
      prompt: "Resume the queued task",
      skillIds: [],
    })
    listMessagesMock
      .mockRejectedValueOnce(new Error("temporary IndexedDB read failure"))
      .mockResolvedValueOnce([])
    const props = makeProps()
    const { rerender } = render(<ChatPane {...props} />)

    await waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(1))

    storeState.messagesLoading = true
    rerender(<ChatPane {...props} />)
    storeState.messagesLoading = false
    rerender(<ChatPane {...props} />)

    await waitFor(() => expect(listMessagesMock).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(props.onSend).toHaveBeenCalledWith(
        "Resume the queued task",
        undefined,
        undefined,
        undefined
      )
    )
    expect(acknowledgePendingChatPromptMock).toHaveBeenCalledWith("s1", "dispatch-retry")
  })

  it("fails closed before sending a queued prompt that contains PII", async () => {
    peekPendingChatPromptMock.mockReturnValue({
      id: "dispatch-pii",
      sessionId: "s1",
      prompt: "Configure alice@example.com",
      skillIds: [],
    })
    const props = makeProps()
    render(<ChatPane {...props} />)

    await waitFor(() => expect(peekPendingChatPromptMock).toHaveBeenCalledWith("s1"))
    expect(props.onSend).not.toHaveBeenCalled()
    expect(acknowledgePendingChatPromptMock).toHaveBeenCalledWith("s1", "dispatch-pii")
    expect(failOnboardingRequestMock).toHaveBeenCalledWith("s1", "pending-prompt-pii-blocked")
    expect(settingsState.skipOnboarding).toHaveBeenCalledWith("task_failed", "first-run")
  })

  it("acknowledges dispatch and settles only from the persisted transcript", async () => {
    const request = { state: "in-flight", skillId: "skill-onboarding" }
    readOnboardingRequestMock.mockReturnValue(request)
    peekPendingChatPromptMock.mockReturnValue({
      id: "dispatch-1",
      sessionId: "s1",
      prompt: "Summarize a web page",
      skillIds: ["skill-onboarding"],
      requestId: "request-1",
    })
    const persisted = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "Summarize a web page" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "Which URL?" }] },
    ]
    listMessagesMock.mockResolvedValue(persisted)
    hasPersistedInitialOnboardingPromptMock.mockReturnValue(true)
    reconcileOnboardingRequestMessagesMock.mockReturnValue({
      ...request,
      state: "succeeded",
      resultMessageId: "a1",
    })

    render(<ChatPane {...makeProps()} />)

    await waitFor(() => expect(listMessagesMock).toHaveBeenCalledWith("s1"))
    expect(acknowledgePendingChatPromptMock).toHaveBeenCalledWith("s1", "dispatch-1")
    expect(reconcileOnboardingRequestMessagesMock).toHaveBeenCalledWith("s1", persisted)
    expect(settingsState.completeOnboarding).toHaveBeenCalled()
  })

  it("forwards the attachment manifest from Composer to the workspace sender", async () => {
    const props = makeProps()
    render(<ChatPane {...props} />)
    const onSend = mockComposerProps.at(-1)?.onSend as (
      content: SendContent,
      manifest: readonly unknown[]
    ) => Promise<void>
    const manifest = [{ filename: "report.txt", mediaType: "text/plain", kind: "document" }]

    await act(async () => {
      await onSend("summarize", manifest)
    })

    expect(props.onSend).toHaveBeenCalledWith("summarize", manifest, undefined, undefined)
  })

  it("forwards pre-search turn metadata from Composer", async () => {
    const props = makeProps()
    render(<ChatPane {...props} />)
    const onSend = mockComposerProps.at(-1)?.onSend as (...args: unknown[]) => Promise<void>
    const metadata = {
      webSearchContext: {
        provider: "tavily",
        results: [{ title: "A", url: "https://a.test", content: "a", score: 1 }],
      },
    }

    await act(async () => {
      await onSend("question", undefined, null, metadata)
    })

    expect(props.onSend).toHaveBeenCalledWith("question", undefined, null, metadata)
  })

  it("binds Composer to this pane's streaming status", () => {
    storeState.status = "streaming"
    try {
      render(<ChatPane {...makeProps()} />)
      expect(mockComposerProps.at(-1)).toEqual(
        expect.objectContaining({
          status: "streaming",
        })
      )
    } finally {
      storeState.status = "idle"
    }
  })

  it("disables the Composer when runtime writes are unavailable", () => {
    render(<ChatPane {...makeProps()} composerDisabled />)

    expect(mockComposerProps.at(-1)).toEqual(expect.objectContaining({ disabled: true }))
  })

  it("passes the effective session cwd to the message list", () => {
    render(<ChatPane {...makeProps()} />)
    expect(MessageList).toHaveBeenCalledWith(
      expect.objectContaining({ projectRoot: "/repo" }),
      undefined
    )
  })

  it("passes the session message-display override to the active transcript", () => {
    const activeSession = {
      ...mockSession,
      messageDisplayOverride: { preset: "focused" as const },
    }
    render(<ChatPane {...makeProps()} activeSession={activeSession} />)

    expect(MessageList).toHaveBeenCalledWith(
      expect.objectContaining({ messageDisplayOverride: { preset: "focused" } }),
      undefined
    )
  })

  it("routes browser companion sessions through the bounded transcript surface", () => {
    hasWebCompanionTargetMock.mockReturnValue(true)
    historyModeMock = "timeline"
    const MockList = MessageList as jest.Mock
    MockList.mockClear()

    render(<ChatPane {...makeProps()} />)

    expect(companionTranscriptMessagesMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "s1", projectRoot: "/repo" })
    )
    expect(MockList).not.toHaveBeenCalled()
  })

  it("mounts a remote timeline even when the bounded local tail is empty", () => {
    const savedMessages = storeState.messages
    storeState.messages = []
    hasWebCompanionTargetMock.mockReturnValue(true)
    historyModeMock = "timeline"
    try {
      render(<ChatPane {...makeProps()} />)
      expect(companionTranscriptMessagesMock).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: "s1", messages: [] })
      )
    } finally {
      storeState.messages = savedMessages
    }
  })

  it("negotiates transcript capability for a pane-bound non-active session", async () => {
    hasWebCompanionTargetMock.mockReturnValue(true)
    historyModeMock = null

    render(<ChatPane {...makeProps()} sessionId="split-session" />)

    await waitFor(() =>
      expect(hydrateSessionHistoryMock).toHaveBeenCalledWith(
        companionTransportMock,
        "split-session"
      )
    )
  })

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

  it("renders the structured card when the producer emitted a diagnostic", () => {
    const MockDiagnosticCard = DiagnosticCard as jest.Mock
    const MockInlineError = InlineError as jest.Mock
    MockDiagnosticCard.mockClear()
    MockInlineError.mockClear()
    const diagnostic = createDiagnostic("sidecarExited", {
      source: "chat",
      now: () => 0,
      id: "d1",
    })
    storeState.errorDiagnostic = diagnostic
    storeState.errorMessage = diagnostic.message
    try {
      render(<ChatPane {...makeProps()} />)
      // The card owns the label/hint/buttons now — the view no longer maps a
      // sentinel string onto a localized message.
      expect(MockDiagnosticCard).toHaveBeenCalledWith(
        expect.objectContaining({ diagnostic }),
        undefined
      )
      expect(MockInlineError).not.toHaveBeenCalled()
    } finally {
      storeState.errorDiagnostic = null
      storeState.errorMessage = null
    }
  })

  it("serves every action its own registry entry prescribes for a chat failure", () => {
    // An action with no handler is DROPPED, not rendered disabled
    // (`diagnostic-actions.tsx`), so a short map silently removes buttons the
    // registry ordered. `sidecarExited` asks for restart-sidecar and view-logs
    // and used to show neither; view-logs alone is prescribed by 18 codes.
    const MockDiagnosticCard = DiagnosticCard as jest.Mock
    MockDiagnosticCard.mockClear()
    const diagnostic = createDiagnostic("sidecarExited", {
      source: "chat",
      now: () => 0,
      id: "d1",
    })
    storeState.errorDiagnostic = diagnostic
    try {
      render(<ChatPane {...makeProps()} />)
      const handlers = MockDiagnosticCard.mock.calls[0]?.[0]?.handlers ?? {}
      for (const action of diagnostic.actions) {
        expect(Object.keys(handlers)).toContain(action.kind)
      }
    } finally {
      storeState.errorDiagnostic = null
    }
  })

  it("serves the workspace codes the send path now emits", () => {
    const MockDiagnosticCard = DiagnosticCard as jest.Mock
    for (const code of [
      "workspaceUnavailable",
      "workspaceBundleFailed",
      "environmentUnavailable",
      "environmentSetupFailed",
    ] as const) {
      MockDiagnosticCard.mockClear()
      const diagnostic = createDiagnostic(code, { source: "chat", now: () => 0, id: code })
      storeState.errorDiagnostic = diagnostic
      try {
        render(<ChatPane {...makeProps()} />)
        const handlers = MockDiagnosticCard.mock.calls[0]?.[0]?.handlers ?? {}
        // `retry` is conditional on having history, so only assert the rest.
        for (const action of diagnostic.actions.filter((a) => a.kind !== "retry")) {
          expect({ code, kind: action.kind, served: action.kind in handlers }).toEqual({
            code,
            kind: action.kind,
            served: true,
          })
        }
      } finally {
        storeState.errorDiagnostic = null
      }
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

    it("docks the over-capacity notice inside the chat reading column", () => {
      // Notices sit between the transcript and the composer, which both cap at
      // 52rem. Without the shared wrapper this one spans the whole pane and
      // reads as a full-bleed band across a centred conversation.
      storeState.atCapacity = true
      const { getByRole } = render(<ChatPane {...makeProps()} />)
      const column = getByRole("status").closest('[data-slot="chat-notice-column"]')
      expect(column).not.toBeNull()
      expect(column).toHaveClass(...chatColumnClass.split(" "))
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

    it("forwards the compact split exit action to ChatHeader", () => {
      const { ChatHeader } = jest.requireMock("./chat-header") as {
        ChatHeader: jest.Mock
      }
      const onExitSplit = jest.fn()
      ChatHeader.mockClear()
      render(<ChatPane {...makeProps()} onExitSplit={onExitSplit} />)
      expect(ChatHeader.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ onExitSplit }))
    })

    it("forwards the compact split entry action to ChatHeader", () => {
      const { ChatHeader } = jest.requireMock("./chat-header") as {
        ChatHeader: jest.Mock
      }
      const onSplitView = jest.fn()
      ChatHeader.mockClear()
      render(<ChatPane {...makeProps()} onSplitView={onSplitView} />)
      expect(ChatHeader.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ onSplitView }))
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

    it("passes the usage dashboard to the generic welcome", () => {
      const saved = storeState.messages
      storeState.messages = []
      EmptyChatState.mockClear()
      EmptyChatState.mockReturnValue(null)
      render(<ChatPane {...makeProps()} />)
      expect(EmptyChatState.mock.calls.at(-1)?.[0]?.statsSlot).toBeTruthy()
      storeState.messages = saved
    })

    it("omits the usage dashboard on surfaces that replace the welcome copy", () => {
      const saved = storeState.messages
      storeState.messages = []
      EmptyChatState.mockClear()
      EmptyChatState.mockReturnValue(null)
      // The workflow-editor chat tab supplies its own copy; a generic usage
      // dashboard underneath it would read as off-topic.
      render(<ChatPane {...makeProps()} emptyState={{ title: "Build a workflow" }} />)
      expect(EmptyChatState.mock.calls.at(-1)?.[0]?.statsSlot).toBeUndefined()
      storeState.messages = saved
    })
  })

  describe("history hydration motion", () => {
    const loadedMessage = { id: "loaded", role: "user", parts: [] }
    let savedMessages: unknown[]
    let savedLoading: boolean

    beforeEach(() => {
      jest.useFakeTimers()
      savedMessages = storeState.messages
      savedLoading = storeState.messagesLoading
      storeState.messages = []
      storeState.messagesLoading = true
      ;(MessageList as jest.Mock).mockClear()
    })

    afterEach(() => {
      storeState.messages = savedMessages
      storeState.messagesLoading = savedLoading
      jest.useRealTimers()
    })

    it("defers the accessible loader so a fast Dexie read does not flash", () => {
      render(<ChatPane {...makeProps()} />)

      expect(screen.queryByRole("status")).not.toBeInTheDocument()

      act(() => jest.advanceTimersByTime(179))
      expect(screen.queryByRole("status")).not.toBeInTheDocument()

      act(() => jest.advanceTimersByTime(1))
      expect(screen.getByRole("status")).toHaveTextContent("loading")
    })

    it("finishes the loader beat before revealing history that arrived mid-animation", () => {
      const props = makeProps()
      const { rerender } = render(<ChatPane {...props} />)

      act(() => jest.advanceTimersByTime(180))
      expect(screen.getByRole("status")).toHaveTextContent("loading")

      storeState.messages = [loadedMessage]
      storeState.messagesLoading = false
      rerender(<ChatPane {...props} />)

      expect(MessageList).not.toHaveBeenCalled()
      act(() => jest.advanceTimersByTime(319))
      expect(MessageList).not.toHaveBeenCalled()

      act(() => jest.advanceTimersByTime(1))
      expect(MessageList).toHaveBeenCalled()
    })

    it("reveals fast-loaded history without ever mounting the loader", () => {
      const props = makeProps()
      const { rerender } = render(<ChatPane {...props} />)

      storeState.messages = [loadedMessage]
      storeState.messagesLoading = false
      rerender(<ChatPane {...props} />)

      expect(screen.queryByRole("status")).not.toBeInTheDocument()
      expect(MessageList).toHaveBeenCalled()
    })

    // Regression: under `mode="sync"` the exiting loader kept its `flex-1`
    // slot in the column for the length of its exit, so the transcript
    // mounted in the lower half of the pane and snapped to full height when
    // the exit finished. `popLayout` lifts the exiting surface out of flow —
    // the swap is a crossfade in place.
    it("swaps surfaces with popLayout so the entering surface never shares the column", () => {
      animatePresenceProps.length = 0
      const props = makeProps()
      const { rerender } = render(<ChatPane {...props} />)
      act(() => jest.advanceTimersByTime(180))
      expect(screen.getByRole("status")).toHaveTextContent("loading")

      storeState.messages = [loadedMessage]
      storeState.messagesLoading = false
      rerender(<ChatPane {...props} />)
      act(() => jest.advanceTimersByTime(320))
      expect(MessageList).toHaveBeenCalled()

      const surfaceSwap = animatePresenceProps.filter(
        (p) => p.initial === false && typeof p.onExitComplete === "function"
      )
      expect(surfaceSwap.length).toBeGreaterThan(0)
      for (const p of surfaceSwap) expect(p.mode).toBe("popLayout")
    })

    it("mounts every surface inside one positioned stage that owns the pane height", () => {
      const props = makeProps()
      const { container, rerender } = render(<ChatPane {...props} />)
      act(() => jest.advanceTimersByTime(180))

      const stage = container.querySelector<HTMLElement>('[data-slot="chat-surface-stage"]')
      expect(stage).not.toBeNull()
      // `relative`: popLayout pins the exiting surface against this box.
      // `flex-1 min-h-0`: the stage — not the surfaces — claims the column
      // height, so whichever surface is present fills it edge to edge.
      expect(stage).toHaveClass("relative", "flex-1", "min-h-0", "flex-col")
      expect(stage).toContainElement(screen.getByRole("status"))

      storeState.messages = [loadedMessage]
      storeState.messagesLoading = false
      rerender(<ChatPane {...props} />)
      act(() => jest.advanceTimersByTime(320))

      expect(stage).toContainElement(screen.getByTestId("composer"))
    })
  })
})

// ── The welcome screen actually reads what settings wrote ──────────────────
//
// `EmptyChatState` has always ACCEPTED `welcomeStyle` / `userName` /
// `onToggleStyle` and rendered a style toggle for them — but no production
// caller passed any of the three, so the name a user typed into Settings was
// written and never read, and the page was permanently `rich`. These pin the
// wiring so it cannot rot back.
describe("ChatPane — welcome personalization reaches the welcome page", () => {
  const emptyStateMock = jest.mocked(EmptyChatState)

  function renderWelcome() {
    // No active session → the welcome branch.
    render(<ChatPane {...makeProps()} activeSession={null} />)
    const props = emptyStateMock.mock.calls.at(-1)?.[0]
    if (!props) throw new Error("EmptyChatState was not rendered")
    return props
  }

  beforeEach(() => {
    emptyStateMock.mockClear()
    settingsState.settings = null
  })

  it("passes the stored display name through to the greeting", () => {
    settingsState.settings = { userName: "Max" }
    expect(renderWelcome().userName).toBe("Max")
  })

  it("passes the stored style through", () => {
    settingsState.settings = { welcomeStyle: "minimal" }
    expect(renderWelcome().welcomeStyle).toBe("minimal")
  })

  it("defaults to rich when nothing is stored", () => {
    expect(renderWelcome().welcomeStyle).toBe("rich")
  })

  it("offers the inline style toggle on desktop", () => {
    expect(typeof renderWelcome().onToggleStyle).toBe("function")
  })

  it("supplies a hero composer when the shell can dispatch a first turn", () => {
    render(<ChatPane {...makeProps()} activeSession={null} onHeroSend={jest.fn()} />)
    expect(emptyStateMock.mock.calls.at(-1)?.[0].composerSlot).toBeTruthy()
  })

  it("omits the hero composer when the shell cannot create a session", () => {
    expect(renderWelcome().composerSlot).toBeUndefined()
  })
})
