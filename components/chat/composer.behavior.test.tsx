/**
 * @jest-environment jsdom
 *
 * Coverage for AppSettings.composerBehavior wiring in the composer:
 *   - sendOnEnter      (Enter vs ⌘/Ctrl+Enter to submit)
 *   - clearAfterSend   (keep vs clear the composer after a send)
 *   - inputHistoryRecall (↑/↓ recall of previously sent messages)
 *   - persistDrafts    (Dexie draft hydrate)
 *
 * Each flag defaults ON, so absent settings preserve the historical behavior.
 */

import "fake-indexeddb/auto"

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
jest.mock("./composer/voice-controls", () => ({
  VoiceControls: () => null,
}))
// Make the send pipeline deterministic: plain text in → that text as content.
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  ...jest.requireActual("@/lib/chat/attachments/dispatch"),
  buildSendContent: jest.fn(async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 1,
    manifest: [],
  })),
}))

import { fireEvent, render, waitFor } from "@testing-library/react"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { setDraft } from "@/lib/db/chat-drafts"
import { recordInput } from "@/lib/db/chat-input-history"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"

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
  Wrapper.displayName = "ComposerBehaviorWrapper"
  return Wrapper
}

const mkSession = (overrides: Partial<ChatSession> = {}): ChatSession => ({
  id: "ses_behavior",
  title: "Behavior",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

function setBehavior(behavior: NonNullable<AppSettings["composerBehavior"]>): void {
  useSettingsStore.setState({ settings: { composerBehavior: behavior } as never })
}

function renderComposer(session: ChatSession, onSend = jest.fn(async () => undefined)) {
  const Wrapper = withAdapter(makeAdapter())
  render(
    <Wrapper>
      <Composer
        session={session}
        onStartNewSession={async () => undefined}
        onOpenSettings={() => undefined}
        onSend={onSend}
        onStop={async () => undefined}
      />
    </Wrapper>
  )
  const ta = document.querySelector("textarea") as HTMLTextAreaElement
  return { ta, onSend }
}

// The first full Composer mount in the test body costs as much as the cold-open
// hook below and overruns the 5s default the same way under parallel workers,
// so the file gets the same 30s budget.
jest.setTimeout(30_000)

// Cold-open Dexie (delete + reopen + migrate the full schema) can exceed the
// default 5s hook budget on the first test of the file — repo convention is a
// 30s hook timeout for suites that reset the DB per test.
beforeEach(async () => {
  useChatStore.getState().clear()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
}, 30_000)

afterEach(() => {
  useSettingsStore.setState({ settings: undefined as never })
})

describe("composerBehavior — sendOnEnter", () => {
  it("default: plain Enter submits (prevented) and clears the composer", async () => {
    setBehavior({})
    const { ta, onSend } = renderComposer(mkSession())
    fireEvent.change(ta, { target: { value: "hello" } })
    const notPrevented = fireEvent.keyDown(ta, { key: "Enter" })
    expect(notPrevented).toBe(false) // preventDefault was called
    // Third argument is the template run this turn was written from — `null`
    // for a hand-typed turn with no parameterized template behind it.
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", [], null))
    await waitFor(() => expect(ta.value).toBe(""))
  })

  it("off: plain Enter inserts a newline (not prevented, no send); ⌘/Ctrl+Enter submits", async () => {
    setBehavior({ sendOnEnter: false })
    const { ta, onSend } = renderComposer(mkSession())
    fireEvent.change(ta, { target: { value: "hello" } })

    const plainEnter = fireEvent.keyDown(ta, { key: "Enter" })
    expect(plainEnter).toBe(true) // not prevented → newline falls through
    await new Promise((r) => setTimeout(r, 20))
    expect(onSend).not.toHaveBeenCalled()

    const metaEnter = fireEvent.keyDown(ta, { key: "Enter", metaKey: true })
    expect(metaEnter).toBe(false) // prevented → submit
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("hello", [], null))
  })
})

describe("composerBehavior — clearAfterSend", () => {
  it("off: the composer keeps its text after a successful send", async () => {
    setBehavior({ clearAfterSend: false })
    const { ta, onSend } = renderComposer(mkSession())
    fireEvent.change(ta, { target: { value: "keep me" } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await waitFor(() => expect(onSend).toHaveBeenCalledWith("keep me", [], null))
    // Give the post-send clear path a chance to (not) run.
    await new Promise((r) => setTimeout(r, 20))
    expect(ta.value).toBe("keep me")
  })
})

describe("composerBehavior — inputHistoryRecall", () => {
  it("default: ↑ from the start recalls the previously sent message", async () => {
    await recordInput("ses_hist", "earlier message")
    setBehavior({})
    const { ta } = renderComposer(mkSession({ id: "ses_hist" }))
    // Wait until the hook has loaded the seeded history.
    await new Promise((r) => setTimeout(r, 20))
    const prevented = fireEvent.keyDown(ta, { key: "ArrowUp" })
    expect(prevented).toBe(false)
    await waitFor(() => expect(ta.value).toBe("earlier message"))
  })

  it("off: ↑ does not recall — the arrow falls through to native caret movement", async () => {
    await recordInput("ses_hist2", "earlier message")
    setBehavior({ inputHistoryRecall: false })
    const { ta } = renderComposer(mkSession({ id: "ses_hist2" }))
    await new Promise((r) => setTimeout(r, 20))
    const prevented = fireEvent.keyDown(ta, { key: "ArrowUp" })
    expect(prevented).toBe(true) // not prevented
    expect(ta.value).toBe("")
  })
})

describe("composerBehavior — persistDrafts", () => {
  it("off: a saved draft is NOT hydrated into the composer", async () => {
    await setDraft("ses_draft_off", "saved draft text")
    setBehavior({ persistDrafts: false })
    const { ta } = renderComposer(mkSession({ id: "ses_draft_off" }))
    await new Promise((r) => setTimeout(r, 50))
    expect(ta.value).toBe("")
  })

  it("default: a saved draft IS hydrated into the composer", async () => {
    await setDraft("ses_draft_on", "saved draft text")
    setBehavior({})
    const { ta } = renderComposer(mkSession({ id: "ses_draft_on" }))
    await waitFor(() => expect(ta.value).toBe("saved draft text"))
  })
})
