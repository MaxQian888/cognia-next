/**
 * @jest-environment jsdom
 *
 * Regression: the composer remounts when ChatPane swaps the centered empty
 * layout for the docked chat layout (the two motion branches mount it at
 * different tree positions). ChatPane must restore keyboard focus to the new
 * instance once the swap completes, or the first message of a session drops
 * focus. We drive that via AnimatePresence's `onExitComplete`.
 *
 * Strategy: stub `motion/react` so we can capture and fire `onExitComplete`,
 * and stub `<Composer>` with a forwardRef that exposes a spyable `focus()`.
 */

import * as React from "react"
import { render } from "@testing-library/react"

// Capture the AnimatePresence onExitComplete so the test can fire it.
let capturedOnExitComplete: (() => void) | undefined
jest.mock("motion/react", () => ({
  AnimatePresence: ({
    children,
    onExitComplete,
  }: {
    children: React.ReactNode
    onExitComplete?: () => void
  }) => {
    capturedOnExitComplete = onExitComplete
    return <>{children}</>
  },
  motion: {
    div: ({ children, ...rest }: React.ComponentProps<"div">) => <div {...rest}>{children}</div>,
  },
  useReducedMotion: () => false,
}))

const mockComposerFocus = jest.fn()
jest.mock("./composer", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  return {
    Composer: react.forwardRef(function Composer(_props: unknown, ref: React.Ref<unknown>) {
      react.useImperativeHandle(
        ref,
        () => ({ insertMention: () => {}, focus: mockComposerFocus }),
        []
      )
      return null
    }),
  }
})

jest.mock("./chat-header", () => ({ ChatHeader: () => null }))
jest.mock("./character-missing-banner", () => ({ CharacterMissingBanner: () => null }))
jest.mock("./empty-state", () => ({ EmptyChatState: () => null }))
jest.mock("./inline-error", () => ({ InlineError: () => null }))
jest.mock("./message-list", () => ({ MessageList: () => null }))
jest.mock("@/components/agent/external-agent/session-panel", () => ({
  ExternalAgentSessionPanel: () => null,
}))
jest.mock("@/components/plugins/plugin-extension-slot", () => ({
  PluginExtensionSlot: () => null,
}))
jest.mock("sonner", () => ({ toast: { success: jest.fn() } }))
jest.mock("@/lib/ui/motion", () => ({ mobileTransition: () => ({}) }))
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))
jest.mock("@/lib/data-hooks/context", () => ({ useCharacter: jest.fn(() => undefined) }))

let mockIsMobile = false
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => mockIsMobile }))

const storeState = {
  messages: [] as unknown[],
  status: "idle" as const,
  errorMessage: null as string | null,
  messagesLoading: false,
  messagesLoadError: null as string | null,
  // Raw-selector consumers (RunPanel's usage signature, the run-record
  // persistence subscription) read per-session slices off the state object.
  sessions: {} as Record<string, { messages: unknown[] }>,
}
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
  useIsAtStreamCap: () => false,
  useSessionRunTiming: () => ({ startedAt: null, pausedAt: null, pausedAccumMs: 0 }),
  useSessionSteerQueue: () => [],
  useSessionRunId: () => 0,
  useSessionToolTimestamps: () => ({}),
}))

jest.mock("@/stores/settings", () => {
  const state = { settings: null, save: jest.fn() }
  const useSettingsStore = Object.assign((sel: (s: typeof state) => unknown) => sel(state), {
    getState: () => state,
  })
  return { useSettingsStore }
})

import { ChatPane } from "./chat-view"
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

afterEach(() => {
  jest.clearAllMocks()
  capturedOnExitComplete = undefined
  storeState.messages = []
  mockIsMobile = false
})

describe("ChatPane focus-on-transition", () => {
  it("refocuses the docked composer once the empty→chat swap completes", () => {
    storeState.messages = [{ id: "m1" }] // chat layout: docked composer is mounted
    render(<ChatPane {...makeProps()} />)
    expect(typeof capturedOnExitComplete).toBe("function")

    mockComposerFocus.mockClear()
    capturedOnExitComplete?.()
    expect(mockComposerFocus).toHaveBeenCalledTimes(1)
  })

  it("does not steal focus when returning to the empty welcome", () => {
    storeState.messages = [] // empty layout: no docked composer, guard must hold
    render(<ChatPane {...makeProps()} />)
    capturedOnExitComplete?.()
    expect(mockComposerFocus).not.toHaveBeenCalled()
  })

  it("forwards the live composer handle to the external composerRef", () => {
    storeState.messages = [{ id: "m1" }]
    const externalRef = React.createRef<{ insertMention: (n: string) => void; focus: () => void }>()
    render(<ChatPane {...makeProps()} composerRef={externalRef} />)
    // The merged callback ref must populate the external ref with the handle.
    expect(externalRef.current).not.toBeNull()
    externalRef.current?.focus()
    expect(mockComposerFocus).toHaveBeenCalledTimes(1)
  })

  it("does not autofocus on mobile viewports to avoid opening the virtual keyboard", () => {
    mockIsMobile = true
    storeState.messages = [{ id: "m1" }]
    render(<ChatPane {...makeProps()} />)
    expect(typeof capturedOnExitComplete).toBe("function")

    mockComposerFocus.mockClear()
    capturedOnExitComplete?.()
    expect(mockComposerFocus).not.toHaveBeenCalled()
  })
})
