jest.mock("@/hooks/chat/use-follow-up-suggestions", () => ({
  useFollowUpSuggestions: jest.fn(() => ({
    suggestions: [],
    loading: false,
    dismiss: jest.fn(),
    status: "ineligible",
    retry: jest.fn(),
  })),
}))
jest.mock("@/hooks/chat/use-remote-doc-staging", () => ({
  ...jest.requireActual("@/hooks/chat/use-remote-doc-staging"),
  useRemoteDocStaging: jest.fn(
    jest.requireActual("@/hooks/chat/use-remote-doc-staging").useRemoteDocStaging
  ),
}))
import { useRemoteDocStaging } from "@/hooks/chat/use-remote-doc-staging"
jest.mock("@/lib/i18n/runtime-translator", () => ({
  getRuntimeTranslator: async () => (key: string) => key,
}))
jest.mock("@/lib/best-of-n/entry", () => ({
  prepareBestOfNChat: jest.fn(async (_sessionId: string, prompt: string, n: number) => ({
    session: {
      id: _sessionId,
      kind: "direct",
      title: "Composer Test Chat",
      createdAt: 0,
      updatedAt: 0,
    },
    requestId: "bon-request",
    prompt,
    n,
    baseSha: "abc",
    dirty: true,
    targetRef: "best-of-n/bon-request",
    branches: ["main"],
    agents: Array.from({ length: n }, () => "session"),
    agentOptions: [{ value: "session", kind: "session", label: "session" }],
  })),
  startPreparedBestOfN: jest.fn(async () => ({ groupId: "bon-group" })),
}))

// Coverage for the data-hooks integration point in composer — the inner
// component now reads `useUpdateSession()` from the adapter and uses it to
// persist permissionMode changes back to the session row. This test mounts
// the full <Composer> with a stub adapter, then drives a permissionMode
// change through the chat-store and asserts the adapter mutation is called.

// Heavy file-system / shell / memory / slash-command modules pull in Tauri
// IPC and disk reads that have no place in a logic-level component test.
jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({
  executeShell: jest.fn(),
  formatShellResult: jest.fn(),
}))
// `!` lines run through the transport-routed one-shot exec now, under the
// user's configured shell — not `shell_exec`'s hard-coded `sh -c` (ADR-0039).
jest.mock("@/lib/terminal/remote-api", () => ({
  ...jest.requireActual("@/lib/terminal/remote-api"),
  execTerminalCommand: jest.fn(async () => ({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  })),
}))
// A Host has to be reachable for a `!` line to run at all; these cases are
// about WHERE it runs, so the transport is present throughout.
jest.mock("@/lib/terminal/pick-transport", () => ({
  ...jest.requireActual("@/lib/terminal/pick-transport"),
  terminalAvailable: jest.fn(() => true),
}))
// Interactive `!command` routing: control the desktop gate and stub the dock
// spawn so a routed command doesn't hit the real terminal orchestrator.
//
// Mocked at `@/lib/platform/detect`, which is where `isTauri` is DEFINED —
// `@/lib/tauri` only re-exports it, and so does everything else that asks. A
// mock on the re-export left `useShellContext` (which imports the definition)
// answering "no host" in the very cases these tests set up as a desktop, so
// every `!` line refused before it could reach the exec. One process, one
// answer.
jest.mock("@/lib/platform/detect", () => ({
  ...jest.requireActual("@/lib/platform/detect"),
  isTauri: jest.fn(() => false),
}))
jest.mock("@/lib/terminal/run-in-dock", () => ({
  runInTerminalDock: jest.fn(async () => undefined),
  runInDockTab: jest.fn(async () => ({ kind: "ok" })),
}))
// Desktop-only SDK context-usage hook: with isTauri() flipped on it would fire
// a Tauri IPC that doesn't exist in jsdom. Stub it — it's a display leaf,
// irrelevant to composer logic.
jest.mock("@/hooks/chat/use-sdk-context-usage", () => ({
  useSdkContextUsage: () => ({ snapshot: null, refresh: () => undefined }),
}))
// With isTauri() flipped on, the composer's plugin-quick-actions-menu mounts
// desktop tray hooks that hit Tauri event/subscription IPC absent in jsdom.
// Stub them to static values — they're status leaves, irrelevant here.
jest.mock("@/lib/tray/state-snapshot", () => ({
  useTrayStateSnapshot: () => jest.requireActual("@/lib/tray/sync").defaultSnapshot(),
}))
jest.mock("@/lib/tray/usage", () => ({
  useTrayUsage: () => null,
}))
jest.mock("@tauri-apps/api/event", () => ({
  listen: jest.fn(async () => () => undefined),
  once: jest.fn(async () => () => undefined),
  emit: jest.fn(async () => undefined),
}))
jest.mock("@tauri-apps/api/core", () => ({
  invoke: jest.fn(async () => null),
}))
jest.mock("@/lib/files/memory", () => ({
  appendMemory: jest.fn(),
}))
// The attachment dispatch pipeline (token counting / PII / oversize) pulls in
// heavy deps irrelevant to composer logic tests. Stub it so a send reaches the
// `onSend` prop cleanly.
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  buildSendContent: jest.fn(async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 1,
    manifest: [],
  })),
  INLINE_TOKEN_CEILING: 1_000_000,
}))
// Chat-draft persistence hits IndexedDB; stub it so clear-after-send and draft
// hydration are no-ops in the logic test.
jest.mock("@/lib/db/chat-drafts", () => ({
  clearDraft: jest.fn(async () => undefined),
  getDraft: jest.fn(async () => undefined),
  setDraftDebounced: jest.fn(() => undefined),
}))
const trackEventMock = jest.fn()
jest.mock("@/lib/telemetry/events/track-event", () => ({
  trackEvent: (...a: unknown[]) => trackEventMock(...a),
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
jest.mock("@/components/inbox/canned-response-picker", () => ({
  CannedResponsePicker: () => <button type="button" data-testid="canned-response-trigger" />,
}))
jest.mock("@/components/inbox/inbox-composer-actions-host", () => ({
  InboxComposerActionsHost: () => null,
}))
// Platform is the gate for the mobile (Capacitor) Claude-style layout. Default
// to "web" so the existing tests keep the desktop/web responsive layout.
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
// Pass-through spy: the composer's half of soft-keyboard avoidance.
jest.mock("./composer/use-composer-keyboard-avoidance", () => {
  const actual = jest.requireActual("./composer/use-composer-keyboard-avoidance")
  return { useComposerKeyboardAvoidance: jest.fn(actual.useComposerKeyboardAvoidance) }
})
// Layout and pointer are separate questions from the platform (see
// `hooks/ui/use-compact-layout.ts`); each test sets the combination it means.
jest.mock("@/hooks/ui/use-compact-layout", () => ({ useCompactLayout: jest.fn(() => false) }))
jest.mock("@/hooks/ui/use-pointer", () => ({
  ...jest.requireActual("@/hooks/ui/use-pointer"),
  useCoarsePointer: jest.fn(() => false),
}))
// Capacitor wrappers consumed by the mobile send path (haptic on send,
// keyboard dismiss after send). Mocked so the mobile tests can assert calls.
jest.mock("@/lib/capacitor/haptics", () => ({
  __esModule: true,
  impact: jest.fn(),
  notify: jest.fn(),
  selectionFeedback: jest.fn(),
}))
jest.mock("@/lib/capacitor/keyboard", () => ({
  __esModule: true,
  hideKeyboard: jest.fn(async () => undefined),
  showKeyboard: jest.fn(async () => undefined),
}))
jest.mock("@/hooks/use-camera-recovery", () => ({ useCameraRecovery: jest.fn() }))
jest.mock("@/components/mobile/chat/composer-attachment", () => {
  const actual = jest.requireActual("@/components/mobile/chat/composer-attachment")
  return { ...actual, attachmentToFiles: jest.fn(actual.attachmentToFiles) }
})
jest.mock("@/lib/chat/attachments/prepare", () => {
  const actual = jest.requireActual("@/lib/chat/attachments/prepare")
  return { ...actual, prepareComposerAttachments: jest.fn(actual.prepareComposerAttachments) }
})

import { toast } from "sonner"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { act } from "react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { useFollowUpSuggestions } from "@/hooks/chat/use-follow-up-suggestions"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { composerReadSlice, useChatStore } from "@/stores/chat"
import { stripPromptPreamble } from "@/lib/chat/prompt-preamble"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { usePlatform } from "@/hooks/use-platform"
import { useCompactLayout } from "@/hooks/ui/use-compact-layout"
import { useCoarsePointer } from "@/hooks/ui/use-pointer"
import { execTerminalCommand } from "@/lib/terminal/remote-api"
import { isTauri } from "@/lib/tauri"
import { setRuntimeSnapshot } from "@/lib/runtime/runtime-snapshot-store"
import { getCommandDescriptor } from "@/lib/tauri/command-descriptors"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { useComposerKeyboardAvoidance } from "./composer/use-composer-keyboard-avoidance"
import { useCameraRecovery } from "@/hooks/use-camera-recovery"
import { getDraft } from "@/lib/db/chat-drafts"
import * as attachmentConversion from "@/components/mobile/chat/composer-attachment"
import * as attachmentPreparation from "@/lib/chat/attachments/prepare"

const mockUsePlatform = usePlatform as jest.Mock
const mockUseCompactLayout = useCompactLayout as jest.Mock
const mockUseCoarsePointer = useCoarsePointer as jest.Mock

function makeAdapter(overrides: Partial<DataAdapter> = {}): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
    ...overrides,
  }
}

function withAdapter(adapter: DataAdapter) {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <DataAdapterProvider adapter={adapter}>
      <TooltipProvider>{children}</TooltipProvider>
    </DataAdapterProvider>
  )
  Wrapper.displayName = "ComposerTestWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_42",
  title: "Composer Test Chat",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

beforeEach(() => {
  jest.mocked(useFollowUpSuggestions).mockReturnValue({
    suggestions: [],
    loading: false,
    dismiss: jest.fn(),
    status: "ineligible",
    retry: jest.fn(),
  })
  jest.mocked(useCameraRecovery).mockClear()
  useChatStore.getState().clear()
  useComposerIntentStore.setState({ pendingBySession: {} })
  useSettingsStore.setState({ settings: undefined as never })
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  mockUsePlatform.mockReturnValue("web")
  // Default to non-desktop so `!command` uses the capture path unless a test
  // opts into desktop.
  ;(isTauri as jest.Mock).mockReturnValue(false)
  // …and to a client with no Host at all, which is what a plain browser is.
  // `setRuntimeSnapshot` (not `__resetRuntimeSnapshotForTesting`) because the
  // reset helper also drops every listener, and the components under test
  // subscribe to this store through `useSyncExternalStore`.
  setRuntimeSnapshot({ target: null, vaultState: "unavailable", connectionState: "offline" })
})

/**
 * Pair this client to a desktop Host, the way `!` mode meets one in the wild.
 *
 * `useShellContext` refuses to run anything until a Host is reachable, and for
 * a browser that verdict is the negotiated manifest — not `terminalAvailable()`,
 * which answers the looser question of whether a terminal dock could be shown.
 * A test that stubs only the transport gets `no-host` and never reaches the
 * exec, which is exactly how these cases went quietly red.
 */
function pairCompanionHost(): void {
  setRuntimeSnapshot({
    target: { id: "web-companion-test", kind: "companion", hostKind: "desktop", platform: "web" },
    vaultState: "unlocked",
    connectionState: "online",
    host: {
      compatible: true,
      operations: ["terminal_exec"],
      // Read from the command manifest rather than spelled out, so a capability
      // rename cannot quietly turn this back into an unpaired client.
      grants: [getCommandDescriptor("terminal_exec")?.capability ?? "terminal.open"],
    },
  })
}

describe("Composer — data-hooks integration", () => {
  it("invalidates a captured document destination across session A-B-A", () => {
    const Wrapper = withAdapter(makeAdapter())
    const renderComposer = (id: string) => (
      <Wrapper>
        <Composer
          session={mkSession({ id })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const view = render(renderComposer("session-a"))
    const capture = jest.mocked(useRemoteDocStaging).mock.calls.at(-1)![0].captureDestination!
    const original = capture()
    expect(original()).toBe(true)
    view.rerender(renderComposer("session-b"))
    view.rerender(renderComposer("session-a"))
    expect(original()).toBe(false)
    expect(jest.mocked(useRemoteDocStaging).mock.calls.at(-1)![0].captureDestination!()()).toBe(
      true
    )
  })
  it("retains a restored photo when the attachment gate refuses every file", async () => {
    const file = new File(["photo"], "photo.png", { type: "image/png" })
    const conversion = jest.mocked(attachmentConversion.attachmentToFiles).mockResolvedValue([file])
    const preparation = jest
      .mocked(attachmentPreparation.prepareComposerAttachments)
      .mockResolvedValue({
        files: [],
        unsupportedCount: 1,
        tooLargeCount: 0,
        optimizedCount: 0,
        motionTooLargeCount: 0,
      })
    const Wrapper = withAdapter(makeAdapter())
    try {
      render(
        <Wrapper>
          <Composer
            session={mkSession()}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </Wrapper>
      )
      await waitFor(() =>
        expect(jest.mocked(useCameraRecovery).mock.calls.at(-1)?.[0]).toEqual({
          kind: "chat",
          id: "ses_42",
        })
      )
      const deliver = jest.mocked(useCameraRecovery).mock.calls.at(-1)![1]
      await act(async () => {
        await expect(
          deliver({ kind: "photo", photo: { base64: "AAAA", format: "png" } }, () => true)
        ).resolves.toBe(false)
      })
      expect(preparation).toHaveBeenCalledWith([file], expect.any(Object))
    } finally {
      conversion.mockImplementation(
        jest.requireActual("@/components/mobile/chat/composer-attachment").attachmentToFiles
      )
      preparation.mockImplementation(
        jest.requireActual("@/lib/chat/attachments/prepare").prepareComposerAttachments
      )
    }
  })

  it.each([true, false])(
    "registers camera recovery after draft readiness (persistDrafts=%s)",
    async (persistDrafts) => {
      let hydrate!: (value: Awaited<ReturnType<typeof getDraft>>) => void
      if (persistDrafts) {
        jest.mocked(getDraft).mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              hydrate = resolve
            })
        )
      } else {
        useSettingsStore.setState({
          settings: { composerBehavior: { persistDrafts: false } } as never,
        })
      }
      const Wrapper = withAdapter(makeAdapter())
      render(
        <Wrapper>
          <Composer
            session={mkSession()}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </Wrapper>
      )
      if (persistDrafts) {
        expect(jest.mocked(useCameraRecovery).mock.calls.every(([target]) => target === null)).toBe(
          true
        )
        await act(async () => {
          hydrate(null)
        })
      }
      await waitFor(() =>
        expect(jest.mocked(useCameraRecovery).mock.calls.at(-1)?.[0]).toEqual({
          kind: "chat",
          id: "ses_42",
        })
      )
    }
  )

  it("applies explicit editor replacement and empty clears after IME completes", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "human draft" } })
    fireEvent.compositionStart(textarea)
    await act(async () => {
      useComposerIntentStore
        .getState()
        .stage("ses_42", { candidateId: "replace", prompt: "replacement", mode: "replace" })
    })
    expect(textarea).toHaveValue("human draft")
    fireEvent.compositionEnd(textarea)
    await waitFor(() => expect(textarea).toHaveValue("replacement"))
    await act(async () => {
      useComposerIntentStore
        .getState()
        .stage("ses_42", { candidateId: "clear", prompt: "", mode: "replace" })
    })
    await waitFor(() => expect(textarea).toHaveValue(""))
  }, 20_000)

  it("rejects a stale external editor intent without changing the draft", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "human draft" } })
    await act(async () => {
      useComposerIntentStore.getState().stage("ses_42", {
        candidateId: "stale",
        prompt: "wrong",
        mode: "replace",
        externalSession: { agentId: "old", sessionId: "native" },
      })
    })
    await waitFor(() =>
      expect(useComposerIntentStore.getState().pendingBySession.ses_42).toBeUndefined()
    )
    expect(textarea).toHaveValue("human draft")
  }, 20_000)

  it("consumes a selection intent after draft hydration without overwriting typed text", async () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "Existing draft" } })

    await act(async () => {
      await Promise.resolve()
      useComposerIntentStore.getState().stage("ses_42", {
        candidateId: "candidate-1",
        prompt: "Please explain this selection.",
      })
    })

    await waitFor(() =>
      expect(textarea).toHaveValue("Existing draft\n\nPlease explain this selection.")
    )
    // Focus lands one animation frame after the text does — the intent effect
    // schedules `textareaRef.current?.focus()` inside a `requestAnimationFrame`,
    // and jsdom services that on a ~16ms timer. A bare assertion here raced the
    // frame and failed ~1 run in 4 with the value already correct but focus
    // still on <body>, so wait for the frame instead of assuming it landed.
    await waitFor(() => expect(textarea).toHaveFocus())
    expect(useComposerIntentStore.getState().pendingBySession["ses_42"]).toBeUndefined()
    // Explicit budget: this mounts the whole composer — every toolbar control,
    // store subscription and Dexie live query included — and then waits on two
    // async settle points. It has been sitting just under jsdom's 5s default,
    // so any control added to the toolbar failed it as a timeout rather than as
    // the assertion it actually is.
  }, 20_000)

  it("renders without crashing when DataAdapterProvider is mounted", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    // The textarea is the source-of-truth element — composer is wired up.
    expect(document.querySelector("textarea")).not.toBeNull()
  })

  it("persists permissionMode changes via adapter.updateSession", async () => {
    const updateSession = jest.fn(async () => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <TooltipProvider>
          <Composer
            session={mkSession({ permissionMode: undefined })}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </TooltipProvider>
      </DataAdapterProvider>
    )

    // Drive a permissionMode change through the chat-store; the inner
    // composer's useEffect should detect the divergence from the session row
    // and route the mutation through the adapter. Keyed by the composer's own
    // conversation, which is both where the composer writes it and where it
    // reads it back — the bare call lands on the FOCUSED session's projection,
    // and this composer's session is never focused here.
    await act(async () => {
      useChatStore.getState().setPermissionMode("acceptEdits", "ses_42")
    })

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith("ses_42", {
        permissionMode: "acceptEdits",
      })
    })
  })

  it("does not re-fire updateSession when permissionMode already matches the session row", async () => {
    const updateSession = jest.fn(async () => undefined)
    const adapter = makeAdapter({ updateSession })
    render(
      <DataAdapterProvider adapter={adapter}>
        <TooltipProvider>
          <Composer
            session={mkSession({ permissionMode: "plan" })}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={async () => undefined}
            onStop={async () => undefined}
          />
        </TooltipProvider>
      </DataAdapterProvider>
    )

    // Hydrate the chat-store with the same value the session already carries.
    await act(async () => {
      useChatStore.getState().setPermissionMode("plan")
    })

    // No divergence ⇒ no write.
    await waitFor(() => {
      // Allow the microtask queue to settle then assert no call.
      return new Promise((r) => setTimeout(r, 30))
    })
    expect(updateSession).not.toHaveBeenCalled()
  })

  it("keeps IM actions accessible separately from the model status row", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({
            platformBinding: {
              platform: "telegram",
              adapterId: "adapter_1",
              conversationKey: "telegram:adapter_1:chat_1",
              conversationRef: { platform: "telegram", adapterId: "adapter_1" },
            },
          })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )

    const footer = screen.getByTestId("composer-footer")
    expect(footer.className).toContain("flex-nowrap")
    expect(screen.getByTestId("canned-response-trigger")).toBeInTheDocument()
    expect(footer).not.toContainElement(screen.getByTestId("canned-response-trigger"))
    expect(screen.getByRole("button", { name: "Reply copilot" })).toBeInTheDocument()
    // The wide footer holds the execution controls inline — there is no "⋯" to
    // fold them into at this width.
    expect(footer).toContainElement(screen.getByTestId("composer-execution-controls"))
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
  })
})

describe("Composer — run status slot", () => {
  it("docks the host's run strip directly on top of the input card, inset by the skin radius", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={() => undefined}
          runStatus={<div data-testid="run-strip">run</div>}
        />
      </Wrapper>
    )
    const slot = document.querySelector('[data-slot="composer-run-status"]') as HTMLElement
    expect(slot).toContainElement(screen.getByTestId("run-strip"))
    // Classic skin: 16px card radius → the strip's sides land where the
    // card's top edge turns straight (16px inset), 10px strip corners.
    expect(slot.style.paddingInline).toBe("16px")
    expect(slot.style.getPropertyValue("--run-strip-radius")).toBe("10px")
    // Flush against the card: the very next element is the box itself.
    expect(slot.nextElementSibling).toBe(document.querySelector("[data-composer-layout]"))
  })

  // The phone card rounds to 28px, not the classic skin's 16px. Insetting by
  // the skin's radius ended the strip's sides on the card's curve, leaving a
  // visible gap at both ends above the card.
  it("insets the strip by the stacked card's own radius on the phone layout", () => {
    useSettingsStore.setState({
      settings: { composerBehavior: { compactLayout: true } } as never,
    })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={() => undefined}
          runStatus={<div data-testid="run-strip">run</div>}
        />
      </Wrapper>
    )
    const slot = document.querySelector('[data-slot="composer-run-status"]') as HTMLElement
    expect(document.querySelector("[data-composer-layout]")).toHaveAttribute(
      "data-composer-layout",
      "compact"
    )
    expect(slot.style.paddingInline).toBe("28px")
    expect(slot.style.getPropertyValue("--run-strip-radius")).toBe("17px")
  })

  it("renders no slot when the host has no run strip", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={() => undefined}
        />
      </Wrapper>
    )
    expect(document.querySelector('[data-slot="composer-run-status"]')).toBeNull()
  })
})

describe("Composer — keyboard avoidance", () => {
  function renderAt(placement?: "docked" | "hero") {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <Composer
          session={mkSession()}
          placement={placement}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={() => undefined}
        />
      </Wrapper>
    )
  }

  function lastAvoidanceCall() {
    const calls = (useComposerKeyboardAvoidance as jest.Mock).mock.calls
    return calls[calls.length - 1][0] as {
      root: HTMLElement | null
      placement: string
      enabled: boolean
    }
  }

  it("marks its root so the popovers can resolve their collision boundary", () => {
    renderAt()
    const root = document.querySelector("[data-composer-root]") as HTMLElement
    expect(root).not.toBeNull()
    expect(root.dataset.placement).toBe("docked")
    expect(root).toContainElement(document.querySelector("textarea"))
  })

  it("hands the docked root to keyboard avoidance on a soft-keyboard device", () => {
    mockUsePlatform.mockReturnValue("mobile")
    try {
      renderAt()
      const call = lastAvoidanceCall()
      expect(call.enabled).toBe(true)
      expect(call.placement).toBe("docked")
      expect(call.root).toBe(document.querySelector("[data-composer-root]"))
    } finally {
      mockUsePlatform.mockReturnValue("web")
    }
  })

  it("passes the hero placement through, and stays off on a desktop", () => {
    renderAt("hero")
    const call = lastAvoidanceCall()
    expect(call.placement).toBe("hero")
    expect(call.enabled).toBe(false)
    expect(document.querySelector("[data-composer-root]")).toHaveAttribute("data-placement", "hero")
  })
})

describe("Composer — send protection", () => {
  it("uses the pane status for the Stop action instead of the focused session status", () => {
    const onStop = jest.fn()
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          status="streaming"
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={onStop}
        />
      </Wrapper>
    )

    fireEvent.click(screen.getByRole("button", { name: "Stop" }))
    expect(onStop).toHaveBeenCalledTimes(1)
  })

  it("switches the send button to a disabled running state while a send is in flight", async () => {
    // onSend never resolves, holding the composer in its "sending" window —
    // before the chat store would flip to "streaming".
    const onSend = jest.fn(() => new Promise<void>(() => {}))
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "hello" } })
    })

    const sendBtn = document.querySelector('button[aria-label="Send"]') as HTMLButtonElement | null
    expect(sendBtn).not.toBeNull()

    await act(async () => {
      fireEvent.click(sendBtn as HTMLButtonElement)
      await Promise.resolve()
    })

    // The button immediately reflects the running state: relabelled "Sending…"
    // and disabled so a fast second submit cannot double-send.
    const sending = document.querySelector(
      'button[aria-label="Sending…"]'
    ) as HTMLButtonElement | null
    expect(sending).not.toBeNull()
    expect(sending?.disabled).toBe(true)
    expect(onSend).toHaveBeenCalledTimes(1)
    // Optimistic clear: the input empties the instant the turn is dispatched,
    // not after the whole send pipeline resolves.
    expect(textarea.value).toBe("")
  })

  it("restores the typed text if the send fails", async () => {
    const onSend = jest.fn(async () => {
      throw new Error("send boom")
    })
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "keep me" } })
    })

    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })

    // The failed send must not lose the user's text.
    await waitFor(() => expect(textarea.value).toBe("keep me"))
    expect(onSend).toHaveBeenCalledTimes(1)
  })
})

describe("Composer — mobile (Claude-style) layout", () => {
  function renderComposer() {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
  }

  // The pill container carries `rounded-2xl`; the layout direction lives on the
  // same element. We assert the responsive-class *strategy* (jsdom computes no
  // geometry), which is the meaningful structural difference between platforms.
  function pillClass(): string {
    const ta = document.querySelector("textarea")
    // By the box's own marker, not a radius class: the phone's one-surface
    // layout draws a larger corner than the desktop pill.
    const pill = ta?.closest("[data-composer-skin]")
    return pill?.className ?? ""
  }

  it("stacks textarea over a single wrapping action row on mobile", () => {
    mockUsePlatform.mockReturnValue("mobile")
    renderComposer()
    const cls = pillClass()
    expect(cls).toContain("flex-wrap")
    expect(cls).not.toContain("flex-col")
    // Mobile never picks up the container-query row layout — the textarea
    // wrapper keeps its stacked w-full row regardless of container width.
    const taWrapper = document.querySelector("textarea")?.parentElement
    expect(taWrapper?.className ?? "").not.toContain("@sm/composer:flex-1")
  })

  it("mounts the plus menu instead of the paperclip button on mobile", () => {
    mockUsePlatform.mockReturnValue("mobile")
    renderComposer()
    expect(screen.getByTestId("composer-plus-toggle")).toBeInTheDocument()
  })

  it("fires a light haptic and dismisses the keyboard after a mobile send", async () => {
    mockUsePlatform.mockReturnValue("mobile")
    const { impact } = jest.requireMock("@/lib/capacitor/haptics") as { impact: jest.Mock }
    const { hideKeyboard } = jest.requireMock("@/lib/capacitor/keyboard") as {
      hideKeyboard: jest.Mock
    }
    impact.mockClear()
    hideKeyboard.mockClear()
    renderComposer()
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: "hello" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() => expect(hideKeyboard).toHaveBeenCalled())
    expect(impact).toHaveBeenCalledWith("light")
    // Mobile must NOT refocus the textarea (that would reopen the keyboard).
    expect(document.activeElement).not.toBe(ta)
  })

  it("does not touch the keyboard wrapper on web sends", async () => {
    mockUsePlatform.mockReturnValue("web")
    const { hideKeyboard } = jest.requireMock("@/lib/capacitor/keyboard") as {
      hideKeyboard: jest.Mock
    }
    hideKeyboard.mockClear()
    renderComposer()
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: "hello" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() => expect(ta.value).toBe(""))
    expect(hideKeyboard).not.toHaveBeenCalled()
  })

  // A phone browser renders the mobile shell and has a soft keyboard, but no
  // Capacitor plugin: blur so the keyboard folds, never call the native one.
  it("folds a phone browser's keyboard by blurring, without the native plugin", async () => {
    mockUsePlatform.mockReturnValue("web")
    mockUseCompactLayout.mockReturnValue(true)
    mockUseCoarsePointer.mockReturnValue(true)
    const { impact } = jest.requireMock("@/lib/capacitor/haptics") as { impact: jest.Mock }
    const { hideKeyboard } = jest.requireMock("@/lib/capacitor/keyboard") as {
      hideKeyboard: jest.Mock
    }
    impact.mockClear()
    hideKeyboard.mockClear()
    try {
      renderComposer()
      const ta = document.querySelector("textarea") as HTMLTextAreaElement
      ta.focus()
      await act(async () => {
        fireEvent.change(ta, { target: { value: "hello" } })
      })
      await act(async () => {
        fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
        await Promise.resolve()
      })
      await waitFor(() => expect(ta.value).toBe(""))
      expect(document.activeElement).not.toBe(ta)
      expect(hideKeyboard).not.toHaveBeenCalled()
      expect(impact).not.toHaveBeenCalled()
    } finally {
      mockUseCompactLayout.mockReturnValue(false)
      mockUseCoarsePointer.mockReturnValue(false)
    }
  })

  // Phone-shaped, but with a hardware keyboard: the follow-up is typed right
  // away, so the box keeps focus.
  it("keeps focus after a send in a narrow desktop window", async () => {
    mockUsePlatform.mockReturnValue("web")
    mockUseCompactLayout.mockReturnValue(true)
    try {
      renderComposer()
      const ta = document.querySelector("textarea") as HTMLTextAreaElement
      await act(async () => {
        fireEvent.change(ta, { target: { value: "hello" } })
      })
      await act(async () => {
        fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
        await Promise.resolve()
      })
      await waitFor(() => expect(ta.value).toBe(""))
      await waitFor(() => expect(document.activeElement).toBe(ta))
    } finally {
      mockUseCompactLayout.mockReturnValue(false)
    }
  })

  it("lays a narrow browser out like the phone, but keeps its paperclip", () => {
    mockUsePlatform.mockReturnValue("web")
    mockUseCompactLayout.mockReturnValue(true)
    try {
      renderComposer()
      expect(screen.queryByTestId("composer-plus-toggle")).toBeNull()
      expect(document.querySelector('button[aria-label="Send"]')?.className).toContain("touch-hit")
    } finally {
      mockUseCompactLayout.mockReturnValue(false)
    }
  })

  it("keeps the paperclip button (no plus menu) on web/desktop", () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()
    expect(screen.queryByTestId("composer-plus-toggle")).toBeNull()
  })

  it("places web search and Skills inside the desktop `+` menu", () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()

    fireEvent.click(screen.getByTestId("composer-attach-menu"))

    expect(screen.getByRole("button", { name: "Toggle web search" })).toBeInTheDocument()
    expect(screen.getByTestId("composer-skill-trigger")).toBeInTheDocument()
  })

  it("places the same capability group inside the mobile `+` menu", () => {
    mockUsePlatform.mockReturnValue("mobile")
    renderComposer()

    fireEvent.click(screen.getByTestId("composer-plus-toggle"))

    // The sheet's rows are menu items. With no search provider configured in
    // this fixture the web row opens a setup card rather than toggling, so it
    // carries the plain `menuitem` role rather than `menuitemcheckbox`.
    expect(screen.getByRole("menuitem", { name: "Toggle web search" })).toBeInTheDocument()
    expect(screen.getByTestId("composer-skill-trigger")).toBeInTheDocument()
  })

  // The wand rewrites what is IN the box, so it lives on the box — beside the
  // save-as-template bookmark — not behind the `+` menu that holds the turn
  // capabilities. Both corner controls appear on the same condition: there is
  // something written to act on.
  it("shows the enhance wand beside the bookmark once there is a draft, no menu needed", async () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()

    expect(screen.queryByTestId("composer-enhance-trigger")).toBeNull()

    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: "make this better" } })
    })

    expect(screen.getByTestId("composer-enhance-trigger")).toBeInTheDocument()
    expect(screen.getByTestId("composer-save-as-template")).toBeInTheDocument()
  })

  it("keeps the drag overlay up when a non-file dragleave interleaves a file drag", () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()
    const dropZone = document.querySelector("[data-composer-layout]") as HTMLElement
    const overlay = dropZone.querySelector(".border-dashed") as HTMLElement

    fireEvent.dragEnter(dropZone, { dataTransfer: { types: ["Files"] } })
    expect(overlay).toHaveClass("opacity-100")

    // A non-file dragleave (e.g. selected text leaving a child) must NOT drop
    // the file-drag counter and flicker the overlay off.
    fireEvent.dragLeave(dropZone, { dataTransfer: { types: ["text/plain"] } })
    expect(overlay).toHaveClass("opacity-100")

    // A real file dragleave does dismiss it.
    fireEvent.dragLeave(dropZone, { dataTransfer: { types: ["Files"] } })
    expect(overlay).toHaveClass("opacity-0")
  })

  it("renders the opt-in compact composer as one unified control surface", () => {
    mockUsePlatform.mockReturnValue("web")
    useSettingsStore.setState({
      settings: { composerBehavior: { compactLayout: true } } as never,
    })
    renderComposer()

    const textarea = document.querySelector("textarea") as HTMLTextAreaElement
    const surface = textarea.closest('[data-composer-layout="compact"]')
    expect(surface).not.toBeNull()
    // Desktop compact keeps `ComposerAttachMenu` (the WeChat-style plus sheet is
    // mobile-only): its camera/album branches both degrade to the same file
    // picker off-mobile, so three entries would be redundant there.
    expect(screen.queryByTestId("composer-plus-toggle")).toBeNull()
    expect(screen.getByTestId("composer-attach-menu")).toBeInTheDocument()
    expect(surface).toContainElement(screen.getByTestId("composer-toolbar-embedded"))
  })

  it("restores one row at @sm without letting the placeholder increase its height", () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()
    const cls = pillClass()
    // Narrow containers (e.g. the workflow-editor right sidebar) must get the
    // same two-row wrap as mobile — textarea on its own full-width row, the
    // attach cluster + send button sharing ONE bottom row. The old `flex-col`
    // strategy put attach and send on separate rows (three rows total).
    expect(cls).toContain("flex-wrap")
    expect(cls).not.toContain("flex-col")
    // At @sm/composer the children reset their order / width to re-form the
    // single-row [attach | textarea (flex-1) | send] layout. The placeholder
    // stays on one line instead of increasing the textarea height when space
    // is tight.
    const taWrapper = document.querySelector("textarea")?.parentElement
    const textarea = document.querySelector("textarea")
    expect(taWrapper?.className ?? "").toContain("@sm/composer:flex-1")
    expect(taWrapper?.className ?? "").toContain("@sm/composer:w-auto")
    expect(taWrapper?.className ?? "").not.toContain("@lg/composer:flex-1")
    expect(textarea?.className ?? "").toContain("min-h-9")
    expect(textarea?.className ?? "").toContain("h-9")
    expect(textarea?.className ?? "").toContain("overflow-hidden")
  })

  it("keeps long unbroken text readable inside a capped, independently scrolling editor", () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()
    const textarea = document.querySelector("textarea") as HTMLTextAreaElement

    fireEvent.change(textarea, { target: { value: "长".repeat(500) } })

    expect(textarea.className).toContain("field-sizing-content")
    expect(textarea.className).toContain("break-words")
    expect(textarea.className).toContain("overflow-y-auto")
    expect(textarea.className).toContain("overscroll-contain")
    expect(textarea.className).toContain("[scrollbar-width:none]")
    expect(textarea.className).toContain("[&::-webkit-scrollbar]:hidden")
    expect(textarea.className).not.toContain("overflow-hidden")
    expect(textarea.style.maxHeight).toBe("12rem")
    expect(textarea.parentElement?.className ?? "").toContain("min-w-0")
  })
})

describe("Composer — wallpaper-aware tonality", () => {
  function renderComposer() {
    const Wrapper = withAdapter(makeAdapter())
    return render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
  }

  it("flags the input pill as a translucent tonality surface", () => {
    renderComposer()
    const pill = document.querySelector("textarea")?.closest("[class*='rounded-2xl']")
    expect(pill).toHaveAttribute("data-tonality", "translucent")
  })

  // Regression: the bar used to pair a Tailwind `from-background` gradient with
  // `data-tonality="glass"`. The tonality rules only swap `background-color`, so
  // the gradient (a `background-image`) painted an opaque slab over the
  // wallpaper the message list a few pixels above was showing. One class owns
  // the fade now, and app/globals.css §4d re-mixes it for an active wallpaper.
  it("fades the bottom bar with the wallpaper-aware composer scrim", () => {
    renderComposer()
    const bar = document.querySelector("[class*='@container/composer']")
    expect(bar).toHaveClass("composer-scrim")
    expect(bar).not.toHaveAttribute("data-tonality")
    expect(bar?.className).not.toContain("from-background")
  })

  // The list ends on its own small gap; a 20-24px top pad here stacked on it
  // and left the run strip and input floating well below the last message.
  it("keeps the docked bar's top padding tight", () => {
    renderComposer()
    const bar = document.querySelector("[class*='@container/composer']")
    expect(bar).toHaveClass("pt-2", "sm:pt-3")
    expect(bar).not.toHaveClass("pt-5")
  })

  it("aligns the composer with the conversation reading column", () => {
    renderComposer()
    const column = document.querySelector('[data-slot="composer-reading-column"]')
    expect(column).toHaveClass("mx-auto", "max-w-[52rem]")
  })

  // The composer box and the message text must share one content edge. That
  // only holds while BOTH cap first and pad second — `message-list.tsx` pads
  // its rows inside the capped reading column, so the padding has to live on
  // this element and not on the gradient bar around it.
  it("pads inside the width cap so the content edge matches the message rows", () => {
    renderComposer()
    const column = document.querySelector('[data-slot="composer-reading-column"]')
    expect(column).toHaveClass("px-3", "sm:px-5")
    const bar = document.querySelector("[class*='@container/composer']")
    expect(bar).not.toHaveClass("px-3")
    expect(bar).not.toHaveClass("sm:px-5")
  })
})

describe("Composer — large-paste folding", () => {
  const BIG = "L1\nL2\nL3\nL4\nL5\nL6" // 6 lines → crosses the line threshold

  function renderComposer(onSend: (c: unknown) => Promise<void> = async () => undefined) {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    return document.querySelector("textarea") as HTMLTextAreaElement
  }

  function pasteText(ta: HTMLTextAreaElement, text: string) {
    fireEvent.paste(ta, {
      clipboardData: { items: [], getData: () => text },
    })
  }

  it("folds an oversized paste into a placeholder + chip instead of raw text", () => {
    const ta = renderComposer()
    pasteText(ta, BIG)
    expect(ta.value).toContain("[Pasted 6 lines #0]")
    expect(ta.value).not.toContain("L6")
    expect(screen.getByTestId("composer-pasted-chips")).toBeInTheDocument()
    expect(screen.getByLabelText("Remove pasted text")).toHaveAttribute("data-slot", "button")
  })

  it("leaves a small paste inline (no chip, no placeholder)", () => {
    const ta = renderComposer()
    pasteText(ta, "just a line")
    expect(ta.value).not.toContain("[Pasted")
    expect(screen.queryByTestId("composer-pasted-chips")).not.toBeInTheDocument()
  })

  it("expands the placeholder back to full text on send", async () => {
    const onSend = jest.fn(async (_text: unknown) => undefined)
    const ta = renderComposer(onSend)
    pasteText(ta, BIG)
    expect(ta.value).toContain("[Pasted 6 lines #0]")
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    // The placeholder is expanded back to the full body before dispatch.
    const sent = onSend.mock.calls[0][0] as string
    expect(sent).toContain(BIG)
    expect(sent).not.toContain("[Pasted")
  })

  it("removing a chip strips its placeholder from the text", () => {
    const ta = renderComposer()
    pasteText(ta, BIG)
    expect(ta.value).toContain("[Pasted 6 lines #0]")
    fireEvent.click(screen.getByLabelText("Remove pasted text"))
    expect(ta.value).not.toContain("[Pasted")
    expect(screen.queryByTestId("composer-pasted-chips")).not.toBeInTheDocument()
  })
})

describe("Composer — effective cwd (workspace fallback)", () => {
  // Regression: the composer used to read `session.workingDir` directly, so a
  // selected workspace ran model turns in its root while `!` shell commands
  // claimed no working directory existed. Both surfaces now resolve through
  // the shared effective-cwd chain.
  const seedActiveWorkspace = (path: string) => {
    const project = {
      id: "proj-ws",
      name: "WS",
      roots: [{ id: "r1", path, isPrimary: true }],
      knowledgeBase: [],
      sessionIds: [],
      sessionCount: 0,
      messageCount: 0,
      isArchived: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastAccessedAt: new Date(),
    } as Project
    useProjectStore.setState({ projects: [project], activeProjectId: project.id, loaded: false })
  }

  function renderComposer() {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()} // no session.workingDir on purpose
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    return document.querySelector("textarea") as HTMLTextAreaElement
  }

  it("keeps the effective cwd contextual instead of rendering a separate directory row", () => {
    seedActiveWorkspace("/ws/root")
    renderComposer()
    expect(screen.queryByTitle("/ws/root")).not.toBeInTheDocument()
  })

  it("runs a ! shell command in the active workspace root instead of erroring", async () => {
    // A paired browser, not the desktop: ADR-0039 moved `!` onto the routed
    // `terminal_exec` precisely so this client can run one at all.
    pairCompanionHost()
    seedActiveWorkspace("/ws/root")
    const execMock = execTerminalCommand as jest.Mock
    execMock.mockClear()
    const ta = renderComposer()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!echo hi" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({ args: expect.arrayContaining(["echo hi"]), cwd: "/ws/root" })
      )
    )
  })

  it("routes an interactive ! command to the integrated terminal (not capture) on desktop", async () => {
    seedActiveWorkspace("/ws/root")
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const execMock = execTerminalCommand as jest.Mock
    execMock.mockClear()
    const routeMock = runInTerminalDock as jest.Mock
    routeMock.mockClear()
    const ta = renderComposer()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!ssh example.com" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(routeMock).toHaveBeenCalledWith("ssh example.com", "/ws/root", expect.any(String))
    )
    expect(execMock).not.toHaveBeenCalled()
  })

  it("keeps a non-interactive ! command on the capture path even on desktop", async () => {
    seedActiveWorkspace("/ws/root")
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const execMock = execTerminalCommand as jest.Mock
    execMock.mockClear()
    const routeMock = runInTerminalDock as jest.Mock
    routeMock.mockClear()
    const ta = renderComposer()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!echo hi" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({ args: expect.arrayContaining(["echo hi"]), cwd: "/ws/root" })
      )
    )
    expect(routeMock).not.toHaveBeenCalled()
  })

  it("surfaces a failure system message when interactive routing throws", async () => {
    seedActiveWorkspace("/ws/root")
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const routeMock = runInTerminalDock as jest.Mock
    routeMock.mockClear()
    routeMock.mockRejectedValueOnce(new Error("dock boom"))
    const execMock = execTerminalCommand as jest.Mock
    execMock.mockClear()
    const ta = renderComposer()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!ssh example.com" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() => expect(routeMock).toHaveBeenCalled())
    // The catch handled it: no fall-through to capture, and a system message
    // was appended.
    expect(execMock).not.toHaveBeenCalled()
    // Appended to THIS composer's conversation (`appendMessageToSession`), not
    // to whichever one has focus — an unfocused pane echoing its shell result
    // into the pane beside it is the bug that keying fixed.
    await waitFor(() =>
      expect(
        composerReadSlice(useChatStore.getState(), "ses_42").messages.some(
          (m) => m.role === "system"
        )
      ).toBe(true)
    )
  })

  it("refuses an interactive ! command with noHost rather than routing it to a dead dock", async () => {
    // `terminalAvailable()` is true here (an unpaired Capacitor shell, or a
    // browser with a companion target whose Host has not answered) while no
    // Host is actually reachable. Handing `ssh` to the dock in that state
    // spawns nothing and says nothing; the capture path below names the fix.
    seedActiveWorkspace("/ws/root")
    const routeMock = runInTerminalDock as jest.Mock
    routeMock.mockClear()
    const execMock = execTerminalCommand as jest.Mock
    execMock.mockClear()
    const ta = renderComposer()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!ssh example.com" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        composerReadSlice(useChatStore.getState(), "ses_42").messages.some(
          (m) => m.role === "system"
        )
      ).toBe(true)
    )
    expect(routeMock).not.toHaveBeenCalled()
    expect(execMock).not.toHaveBeenCalled()
  })

  it("still prefers a per-session workingDir over the workspace root", async () => {
    pairCompanionHost()
    seedActiveWorkspace("/ws/root")
    const execMock = execTerminalCommand as jest.Mock
    execMock.mockClear()
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession({ workingDir: "/session/dir" })}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!echo hi" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(execMock).toHaveBeenCalledWith(
        expect.objectContaining({ args: expect.arrayContaining(["echo hi"]), cwd: "/session/dir" })
      )
    )
  })
})

describe("Composer — auto-resize is IME-safe", () => {
  // The JS auto-resize fallback only runs when CSS `field-sizing` is absent
  // (older mobile WebViews). It must NOT mutate the textarea mid-composition,
  // or it aborts the IME buffer and on-device typing swallows characters.
  let originalCSS: typeof globalThis.CSS

  beforeEach(() => {
    originalCSS = globalThis.CSS
    // Force the fallback path: report no field-sizing support.
    ;(globalThis as { CSS?: unknown }).CSS = { supports: () => false }
  })

  afterEach(() => {
    ;(globalThis as { CSS?: unknown }).CSS = originalCSS
  })

  it("defers height adjustment until composition ends", () => {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={async () => undefined}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    expect(ta).not.toBeNull()

    // Begin an IME composition, then plant a sentinel height. While composing,
    // a value change must leave the height untouched.
    fireEvent.compositionStart(ta)
    ta.style.height = "123px"
    fireEvent.change(ta, { target: { value: "测试" } })
    expect(ta.style.height).toBe("123px")

    // After composition ends the effect re-runs and resizes (scrollHeight is 0
    // in jsdom ⇒ "0px"), proving the resize was only deferred, not dropped.
    fireEvent.compositionEnd(ta)
    expect(ta.style.height).toBe("0px")
  })
})

// A review verdict ("I rejected your proposal" / "I kept 2 of your 5 hunks")
// rides along on the next message so the assistant stops re-proposing what the
// user turned down. It is read while the prompt is built but must only be
// forgotten once the message actually commits.
describe("Composer — review receipts survive a send that never commits", () => {
  function seedRejectedReceipt() {
    const artifact = useArtifactStore.getState().createArtifact({
      sessionId: "ses_42",
      messageId: "msg_1",
      title: "Draft spec",
      type: "document",
      content: "a\nb\nc\nd",
    })
    useArtifactStore.getState().proposeArtifactUpdate(artifact.id, "A\nb\nc\nD")
    useArtifactStore.getState().rejectArtifactReview(artifact.id)
    expect(useArtifactStore.getState().peekReviewReceipts("ses_42")).toHaveLength(1)
  }

  function renderComposer(onSend: (c: unknown) => Promise<void>) {
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    return document.querySelector("textarea") as HTMLTextAreaElement
  }

  async function send(ta: HTMLTextAreaElement, text: string) {
    fireEvent.change(ta, { target: { value: text } })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
  }

  afterEach(() => {
    useArtifactStore.setState({ reviewReceipts: [] })
  })

  it("tells the assistant about the verdict and then forgets it", async () => {
    seedRejectedReceipt()
    const onSend = jest.fn(async (_c: unknown) => undefined)
    await send(renderComposer(onSend), "try again")

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(String(onSend.mock.calls[0][0])).toContain("Draft spec")
    // Committed → the receipt must not ride the next message too.
    await waitFor(() =>
      expect(useArtifactStore.getState().peekReviewReceipts("ses_42")).toEqual([])
    )
  })

  it("keeps the verdict when onSend throws", async () => {
    seedRejectedReceipt()
    const onSend = jest.fn(async (_c: unknown) => {
      throw new Error("transport down")
    })
    await send(renderComposer(onSend), "try again")

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    // The message never landed, so the assistant was never told — the verdict
    // has to still be there for the retry.
    expect(useArtifactStore.getState().peekReviewReceipts("ses_42")).toHaveLength(1)
  })
})

// The new-chat composer has no conversation yet. Its staged references used to
// be formatted only `if (session?.id)` and then cleared, so the first message of
// a conversation started FROM a reference went out without it.
describe("Composer — references staged before a conversation exists", () => {
  afterEach(() => {
    act(() => useChatStore.getState().clearContextSelections(null))
  })

  it("sends the references in the envelope and hands the citations over with the turn", async () => {
    act(() =>
      useChatStore.getState().addContextSelection(
        {
          kind: "entity",
          entityKind: "issue",
          entityId: "i1",
          title: "Broker race",
          snapshot: "ISSUE BODY",
          comment: "",
          capturedAt: 1,
        },
        null
      )
    )
    const onSend = jest.fn(async (..._args: unknown[]) => undefined)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          placement="hero"
          session={null}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "what is left to fix?" } })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    const [content, , , turnMetadata] = onSend.mock.calls[0] as [
      string,
      unknown,
      unknown,
      Record<string, unknown>,
    ]
    expect(content).toContain("ISSUE BODY")
    expect(stripPromptPreamble(content)).toBe("what is left to fix?")
    expect(turnMetadata).toMatchObject({
      citations: [{ kind: "entity", id: "issue:i1", label: "Broker race" }],
      promptPreamble: {
        sections: ["references"],
        references: [{ kind: "entity", entityKind: "issue", title: "Broker race" }],
      },
    })
    // Reference telemetry carries the kind set and the stale count — ids,
    // enums and numbers, never titles or bodies. It fires once the send has
    // resolved, so it is awaited rather than read inline.
    await waitFor(() =>
      expect(trackEventMock).toHaveBeenCalledWith("chat.reference.sent", {
        kinds: "entity",
        staleCount: 0,
      })
    )
    // Consumed by exactly this turn.
    await waitFor(() =>
      expect(composerReadSlice(useChatStore.getState(), null).contextSelections).toEqual([])
    )
  })

  it("does not emit reference telemetry on a plain send", async () => {
    const onSend = jest.fn(async (..._args: unknown[]) => undefined)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          placement="hero"
          session={null}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "no references here" } })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(trackEventMock).not.toHaveBeenCalledWith("chat.reference.sent", expect.anything())
  })
})

describe("plugin command progress and cancellation", () => {
  it.each(["Cancel command", "Stop"])(
    "shows progress, cancels with %s, and drops a late response",
    async (cancelLabel) => {
      const { registerSlashCommand, unregisterSlashCommand } =
        await import("@/lib/slash-commands/registry")
      let commandContext!: import("@/lib/slash-commands/registry").SlashCommandContext
      let finish!: (value: { message: string }) => void
      registerSlashCommand({
        id: "test.research",
        name: "research",
        source: "plugin",
        handler: (_args, context) => {
          commandContext = context!
          context?.reportProgress?.(0.4, "Searching sources")
          return new Promise((resolve) => {
            finish = resolve
          })
        },
      })
      const Wrapper = withAdapter(makeAdapter())
      const onStop = jest.fn()
      const onSend = jest.fn(async () => undefined)
      const view = render(
        <Wrapper>
          <Composer
            session={mkSession()}
            onStartNewSession={async () => undefined}
            onOpenSettings={() => undefined}
            onSend={onSend}
            onStop={onStop}
          />
        </Wrapper>
      )
      try {
        fireEvent.change(document.querySelector("textarea")!, {
          target: { value: "/research topic" },
        })
        fireEvent.click(screen.getByRole("button", { name: /^Send$/ }))
        await waitFor(() => expect(screen.getByText("Searching sources")).toBeInTheDocument())
        const progress = screen.getByRole("progressbar")
        expect(progress).toHaveAttribute("aria-valuemin", "0")
        expect(progress).toHaveAttribute("aria-valuemax", "100")
        expect(progress).toHaveAttribute("aria-valuenow", "40")
        expect(progress).toHaveClass("bg-primary/20")
        fireEvent.click(screen.getByRole("button", { name: cancelLabel }))
        await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument())
        expect(commandContext.signal?.aborted).toBe(true)
        expect(onStop).not.toHaveBeenCalled()
        await act(async () => {
          finish({ message: "late research answer" })
        })
        expect(
          composerReadSlice(useChatStore.getState(), "ses_42").messages.some((message) =>
            JSON.stringify(message.parts).includes("late research answer")
          )
        ).toBe(false)
        expect(onSend).not.toHaveBeenCalled()
      } finally {
        view.unmount()
        unregisterSlashCommand("test.research")
      }
    }
  )
})

describe("Composer — best-of-N consumes exactly one send", () => {
  it("uses the shared start preview then resets the chip before the next ordinary send", async () => {
    const user = userEvent.setup()
    const { startPreparedBestOfN } = await import("@/lib/best-of-n/entry")
    jest.mocked(startPreparedBestOfN).mockClear()
    const onSend = jest.fn(async () => undefined)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    expect(
      screen.queryByRole("combobox", { name: "Best-of-N for the next send" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "More controls" }))
    await user.click(screen.getByRole("combobox", { name: "Best-of-N for the next send" }))
    await user.click(screen.getByRole("option", { name: "Best of 3" }))
    await user.keyboard("{Escape}")
    expect(
      screen.getByRole("button", { name: "Turn off Best-of-N for the next send" })
    ).toBeVisible()
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "try three approaches" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(await screen.findByRole("button", { name: "Start attempts" }))
    await waitFor(() => expect(startPreparedBestOfN).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(onSend).not.toHaveBeenCalled()
    expect(
      screen.queryByRole("button", { name: "Turn off Best-of-N for the next send" })
    ).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "More controls" }))
    expect(screen.getByRole("combobox", { name: "Best-of-N for the next send" })).toHaveTextContent(
      "Best-of-N off"
    )
    await user.keyboard("{Escape}")
    fireEvent.change(ta, { target: { value: "ordinary follow-up" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(startPreparedBestOfN).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])("slash start consumes the parent send (confirm=%s)", async (confirm) => {
    const { startPreparedBestOfN } = await import("@/lib/best-of-n/entry")
    jest.mocked(startPreparedBestOfN).mockClear()
    const onSend = jest.fn(async () => undefined)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: "/best-of-n 2 fix this\nwith tests" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.click(
      await screen.findByRole("button", { name: confirm ? "Start attempts" : "Cancel" })
    )
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(startPreparedBestOfN).toHaveBeenCalledTimes(confirm ? 1 : 0)
    expect(onSend).not.toHaveBeenCalled()
    if (!confirm) await waitFor(() => expect(ta).toHaveValue("/best-of-n 2 fix this\nwith tests"))
  })
  it("refuses /best-of-n inside a mixed batch before any command or send runs", async () => {
    const { startPreparedBestOfN } = await import("@/lib/best-of-n/entry")
    jest.mocked(startPreparedBestOfN).mockClear()
    const { registerSlashCommand, unregisterSlashCommand } =
      await import("@/lib/slash-commands/registry")
    const probe = jest.fn(async () => ({ message: "probe ran" }))
    registerSlashCommand({ id: "test.probe", name: "probe", source: "plugin", handler: probe })
    const onSend = jest.fn(async () => undefined)
    const Wrapper = withAdapter(makeAdapter())
    render(
      <Wrapper>
        <Composer
          session={mkSession()}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </Wrapper>
    )
    const error = jest.spyOn(toast, "error")
    const ta = document.querySelector("textarea") as HTMLTextAreaElement
    const mixed = "/probe\n/best-of-n 2 fix bug\ninclude tests"
    fireEvent.change(ta, { target: { value: mixed } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        "/best-of-n must be the whole message. Send it on its own, without other commands."
      )
    )
    expect(probe).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(startPreparedBestOfN).not.toHaveBeenCalled()
    expect(ta).toHaveValue(mixed)
    error.mockRestore()
    unregisterSlashCommand("test.probe")
  })
})

describe("Composer — next-prompt predictions", () => {
  it("places predictions inside the shared context region above the input", async () => {
    const { ta } = renderPredictions()
    const suggestion = await screen.findByText("Explain the next step")
    const region = screen.getByRole("region", { name: "Composer context and notices" })
    expect(region.parentElement).toHaveStyle({
      "--composer-notice-inset": "18px",
      "--composer-notice-radius": "8px",
    })
    expect(region).toContainElement(suggestion)
    expect(region).not.toContainElement(ta)
    expect(region.compareDocumentPosition(ta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  function renderPredictions(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
    const Wrapper = withAdapter(makeAdapter())
    const onSend = jest.fn(async (_content: unknown) => undefined)
    const session = mkSession({ id: "pane-b" })
    jest.mocked(useFollowUpSuggestions).mockReturnValue({
      suggestions: ["Explain the next step", "Show an example"],
      loading: false,
      dismiss: jest.fn(),
      status: "ready",
      retry: jest.fn(),
    })
    const view = render(
      <Wrapper>
        <Composer
          session={session}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
          {...props}
        />
      </Wrapper>
    )
    const ta = view.container.querySelector("textarea")!
    return { ...view, ta, onSend }
  }

  it("accepts into the bound pane's editable draft and sends only after explicit Enter", async () => {
    useChatStore.setState({ activeSessionId: "pane-a" })
    const { ta, onSend } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    fireEvent.click(screen.getByText("Explain the next step"))
    expect(ta).toHaveValue("Explain the next step")
    expect(onSend).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeSessionId).toBe("pane-a")
    fireEvent.change(ta, { target: { value: "Explain the next step in Chinese" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(stripPromptPreamble(onSend.mock.calls[0][0] as unknown as string)).toBe(
      "Explain the next step in Chinese"
    )
  })

  it.each(["Tab", "ArrowRight"])("accepts %s without sending", async (key) => {
    const { ta, onSend } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    fireEvent.keyDown(ta, { key })
    expect(ta).toHaveValue("Explain the next step")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("keeps another pane's existing draft when accepting in the unfocused pane", async () => {
    const Wrapper = withAdapter(makeAdapter())
    useChatStore.setState({ activeSessionId: "pane-a" })
    jest.mocked(useFollowUpSuggestions).mockImplementation((session) => ({
      suggestions: session?.id === "pane-b" ? ["Only for B"] : [],
      loading: false,
      dismiss: jest.fn(),
      status: "ready",
      retry: jest.fn(),
    }))
    const onSendA = jest.fn()
    const onSendB = jest.fn()
    const { container } = render(
      <Wrapper>
        <Composer
          session={mkSession({ id: "pane-a" })}
          onSend={onSendA}
          onStop={jest.fn()}
          onStartNewSession={jest.fn()}
          onOpenSettings={jest.fn()}
        />
        <Composer
          session={mkSession({ id: "pane-b" })}
          onSend={onSendB}
          onStop={jest.fn()}
          onStartNewSession={jest.fn()}
          onOpenSettings={jest.fn()}
        />
      </Wrapper>
    )
    const [inputA, inputB] = container.querySelectorAll("textarea")
    fireEvent.change(inputA, { target: { value: "A's draft" } })
    await waitFor(() => expect(screen.getByText("Only for B")).toBeVisible())
    fireEvent.click(screen.getByText("Only for B"))
    expect(inputA).toHaveValue("A's draft")
    expect(inputB).toHaveValue("Only for B")
    expect(onSendA).not.toHaveBeenCalled()
    expect(onSendB).not.toHaveBeenCalled()
    fireEvent.keyDown(inputB, { key: "Enter" })
    await waitFor(() => expect(onSendB).toHaveBeenCalledTimes(1))
    expect(onSendA).not.toHaveBeenCalled()
  })

  it("does not accept a prediction during composition or with keyboard modifiers", async () => {
    const { ta, onSend } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    fireEvent.keyDown(ta, { key: "ArrowRight", ctrlKey: true })
    expect(ta).toHaveValue("")
    fireEvent.compositionStart(ta)
    fireEvent.keyDown(ta, { key: "Tab", isComposing: true })
    expect(ta).toHaveValue("")
    fireEvent.compositionEnd(ta)
    fireEvent.keyDown(ta, { key: "Tab" })
    expect(ta).toHaveValue("Explain the next step")
    fireEvent.keyDown(ta, { key: "ArrowRight" })
    expect(onSend).not.toHaveBeenCalled()
  })

  it("Enter before acceptance does not send a prediction", async () => {
    const { ta, onSend } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    fireEvent.keyDown(ta, { key: "Enter" })
    expect(ta).toHaveValue("")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("honours direct-send mode through the bound composer callback", async () => {
    useSettingsStore.setState({
      settings: { composerAssistance: { suggestions: { acceptance: "send" } } } as never,
    })
    useChatStore.setState({ activeSessionId: "pane-a" })
    const { onSend } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    fireEvent.click(screen.getByText("Explain the next step"))
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(useChatStore.getState().activeSessionId).toBe("pane-a")
  })

  it.each(["send", "draft"] as const)(
    "keeps generated command text literal in %s mode",
    async (acceptance) => {
      useSettingsStore.setState({
        settings: { composerAssistance: { suggestions: { acceptance } } } as never,
      })
      const { ta, onSend } = renderPredictions()
      jest.mocked(useFollowUpSuggestions).mockReturnValue({
        suggestions: ["!echo predicted"],
        loading: false,
        dismiss: jest.fn(),
        status: "ready",
        retry: jest.fn(),
      })
      act(() =>
        useSettingsStore.setState({
          settings: {
            composerAssistance: {
              suggestions: { acceptance: acceptance === "send" ? "draft" : "send" },
            },
          } as never,
        })
      )
      act(() =>
        useSettingsStore.setState({
          settings: { composerAssistance: { suggestions: { acceptance } } } as never,
        })
      )
      await waitFor(() => expect(screen.getByText("!echo predicted")).toBeVisible())
      const shellCalls = jest.mocked(execTerminalCommand).mock.calls.length
      fireEvent.click(screen.getByText("!echo predicted"))
      if (acceptance === "draft") {
        expect(onSend).not.toHaveBeenCalled()
        fireEvent.keyDown(ta, { key: "Enter" })
      }
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
      expect(stripPromptPreamble(onSend.mock.calls[0][0] as string)).toBe("!echo predicted")
      expect(execTerminalCommand).toHaveBeenCalledTimes(shellCalls)
    }
  )

  it("suppresses predictions over a typed draft and during IME composition", async () => {
    const { ta, onSend } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    fireEvent.change(ta, { target: { value: "my draft" } })
    expect(screen.queryByText("Explain the next step")).not.toBeInTheDocument()
    fireEvent.keyDown(ta, { key: "Tab" })
    expect(ta).toHaveValue("my draft")
    fireEvent.change(ta, { target: { value: "" } })
    fireEvent.compositionStart(ta)
    fireEvent.keyDown(ta, { key: "ArrowRight", isComposing: true })
    expect(ta).toHaveValue("")
    expect(onSend).not.toHaveBeenCalled()
  })

  it.each([{ disabled: true }, { status: "streaming" as const }])(
    "suppresses predictions while blocked: %j",
    async (props) => {
      const { ta } = renderPredictions(props)
      await act(async () => undefined)
      expect(screen.queryByText("Explain the next step")).not.toBeInTheDocument()
      fireEvent.keyDown(ta, { key: "Tab" })
      expect(ta).toHaveValue("")
    }
  )

  it("suppresses predictions when an attachment is staged", async () => {
    URL.createObjectURL = jest.fn(() => "blob:prediction-attachment")
    URL.revokeObjectURL = jest.fn()
    const { ta, container } = renderPredictions()
    await waitFor(() => expect(screen.getByText("Explain the next step")).toBeVisible())
    const input = container.querySelector('input[type="file"]')!
    fireEvent.change(input, {
      target: { files: [new File(["hello"], "notes.txt", { type: "text/plain" })] },
    })
    await waitFor(() => expect(screen.queryByText("Explain the next step")).not.toBeInTheDocument())
    fireEvent.keyDown(ta, { key: "ArrowRight" })
    expect(ta).toHaveValue("")
  })
})
