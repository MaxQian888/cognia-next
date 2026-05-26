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
jest.mock("./composer/screenshot-button", () => ({
  ScreenshotButton: () => null,
}))
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
// Platform is the gate for the mobile (Capacitor) Claude-style layout. Default
// to "web" so the existing tests keep the desktop/web responsive layout.
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))

import { fireEvent, render, waitFor } from "@testing-library/react"
import { act } from "react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { usePlatform } from "@/hooks/use-platform"
import type { ChatSession } from "@/lib/claude/types"

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
  })

  it("keeps the container-query responsive layout on web/desktop", () => {
    mockUsePlatform.mockReturnValue("web")
    renderComposer()
    const cls = pillClass()
    expect(cls).toContain("flex-col")
    expect(cls).toContain("@sm/composer:flex-row")
    expect(cls).not.toContain("flex-wrap")
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
