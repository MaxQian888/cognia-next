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
// Interactive `!command` routing: control the desktop gate and stub the dock
// spawn so a routed command doesn't hit the real terminal orchestrator.
jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
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
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
jest.mock("./use-resolved-connector-mode", () => ({
  useResolvedConnectorMode: () => "auto",
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
// Capacitor wrappers consumed by the mobile send path (haptic on send,
// keyboard dismiss after send). Mocked so the mobile tests can assert calls;
// `subscribeKeyboard` is included because use-keyboard-insets (via
// MentionPopover) imports from the same module.
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
  subscribeKeyboard: jest.fn(() => null),
}))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { act } from "react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { composerReadSlice, useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSettingsStore } from "@/stores/settings"
import { useProjectStore } from "@/stores/project/project-store"
import { usePlatform } from "@/hooks/use-platform"
import { executeShell } from "@/lib/shell/exec"
import { isTauri } from "@/lib/tauri"
import { runInTerminalDock } from "@/lib/terminal/run-in-dock"
import type { ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"

const mockUsePlatform = usePlatform as jest.Mock

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
  useChatStore.getState().clear()
  useComposerIntentStore.setState({ pendingBySession: {} })
  useSettingsStore.setState({ settings: undefined as never })
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  mockUsePlatform.mockReturnValue("web")
  // Default to non-desktop so `!command` uses the capture path unless a test
  // opts into desktop.
  ;(isTauri as jest.Mock).mockReturnValue(false)
})

describe("Composer — data-hooks integration", () => {
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

  it("keeps IM actions and status controls in one footer row", () => {
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
    expect(footer).toContainElement(screen.getByTestId("canned-response-trigger"))
    // The wide footer holds the execution controls inline — there is no "⋯" to
    // fold them into at this width.
    expect(footer).toContainElement(screen.getByTestId("composer-execution-controls"))
    expect(screen.queryByTestId("composer-toolbar-more")).toBeNull()
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
    const pill = ta?.closest("[class*='rounded-2xl']")
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

    expect(screen.getByRole("button", { name: "Toggle web search" })).toBeInTheDocument()
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
    seedActiveWorkspace("/ws/root")
    const executeShellMock = executeShell as jest.Mock
    executeShellMock.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 })
    const ta = renderComposer()
    await act(async () => {
      fireEvent.change(ta, { target: { value: "!echo hi" } })
    })
    await act(async () => {
      fireEvent.click(document.querySelector('button[aria-label="Send"]') as HTMLButtonElement)
      await Promise.resolve()
    })
    await waitFor(() => expect(executeShellMock).toHaveBeenCalledWith("echo hi", "/ws/root"))
  })

  it("routes an interactive ! command to the integrated terminal (not capture) on desktop", async () => {
    seedActiveWorkspace("/ws/root")
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const executeShellMock = executeShell as jest.Mock
    executeShellMock.mockClear()
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
    expect(executeShellMock).not.toHaveBeenCalled()
  })

  it("keeps a non-interactive ! command on the capture path even on desktop", async () => {
    seedActiveWorkspace("/ws/root")
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const executeShellMock = executeShell as jest.Mock
    executeShellMock.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 })
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
    await waitFor(() => expect(executeShellMock).toHaveBeenCalledWith("echo hi", "/ws/root"))
    expect(routeMock).not.toHaveBeenCalled()
  })

  it("surfaces a failure system message when interactive routing throws", async () => {
    seedActiveWorkspace("/ws/root")
    ;(isTauri as jest.Mock).mockReturnValue(true)
    const routeMock = runInTerminalDock as jest.Mock
    routeMock.mockClear()
    routeMock.mockRejectedValueOnce(new Error("dock boom"))
    const executeShellMock = executeShell as jest.Mock
    executeShellMock.mockClear()
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
    expect(executeShellMock).not.toHaveBeenCalled()
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

  it("still prefers a per-session workingDir over the workspace root", async () => {
    seedActiveWorkspace("/ws/root")
    const executeShellMock = executeShell as jest.Mock
    executeShellMock.mockResolvedValue({ stdout: "ok", stderr: "", code: 0 })
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
    await waitFor(() => expect(executeShellMock).toHaveBeenCalledWith("echo hi", "/session/dir"))
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
