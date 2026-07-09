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
jest.mock("./composer/screenshot-button", () => ({
  ScreenshotButton: () => null,
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
// Platform is the gate for the mobile (Capacitor) Claude-style layout. Default
// to "web" so the existing tests keep the desktop/web responsive layout.
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { act } from "react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { usePlatform } from "@/hooks/use-platform"
import { executeShell } from "@/lib/shell/exec"
import type { ChatSession } from "@/lib/claude/types"
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
  useProjectStore.setState({ projects: [], activeProjectId: null, loaded: false })
  mockUsePlatform.mockReturnValue("web")
})

describe("Composer — data-hooks integration", () => {
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
    // and route the mutation through the adapter.
    await act(async () => {
      useChatStore.getState().setPermissionMode("acceptEdits")
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
})

describe("Composer — send protection", () => {
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

  it("wraps into the two-row stack below @sm and restores the row layout via container queries on web/desktop", () => {
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
    // single-row [attach | textarea (flex-1) | send] layout.
    const taWrapper = document.querySelector("textarea")?.parentElement
    expect(taWrapper?.className ?? "").toContain("@sm/composer:flex-1")
    expect(taWrapper?.className ?? "").toContain("@sm/composer:w-auto")
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

  it("flags the bottom bar as a glass tonality surface", () => {
    renderComposer()
    const bar = document.querySelector("[class*='@container/composer']")
    expect(bar).toHaveAttribute("data-tonality", "glass")
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

  it("shows the active workspace root in the cwd chip when the session has no workingDir", () => {
    seedActiveWorkspace("/ws/root")
    renderComposer()
    expect(screen.getByTitle("/ws/root")).toBeInTheDocument()
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

  it("still prefers a per-session workingDir over the workspace root", () => {
    seedActiveWorkspace("/ws/root")
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
    expect(screen.getByTitle("/session/dir")).toBeInTheDocument()
    expect(screen.queryByTitle("/ws/root")).not.toBeInTheDocument()
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
