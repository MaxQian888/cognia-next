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
  formatSearchResultsForLLM: jest.fn(() => "Search result body"),
}))
jest.mock("@/lib/search/configured-search", () => ({
  searchWithAppSettings: jest.fn(),
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

import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { stripPromptPreamble } from "@/lib/chat/prompt-preamble"
import type { ReactNode } from "react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { dispatchComposerAppend } from "@/lib/chat/composer-append"
import { dispatchSideChat } from "@/lib/slash-commands/actions/side-chat"
import type { ComponentProps } from "react"

jest.mock("@/lib/slash-commands/actions/side-chat", () => ({
  dispatchSideChat: jest.fn(async () => {}),
  openSideChat: jest.fn(async () => {}),
}))
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { selectComposerWebSearchOn, useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { setDraft } from "@/lib/db/chat-drafts"
import { recordInput } from "@/lib/db/chat-input-history"
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import { searchWithAppSettings } from "@/lib/search/configured-search"

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

function renderComposer(
  session: ChatSession,
  onSend = jest.fn(async () => undefined),
  props: Partial<ComponentProps<typeof Composer>> = {}
) {
  const Wrapper = withAdapter(makeAdapter())
  render(
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

describe("composer web pre-search", () => {
  it("uses the configured executor, frames results as untrusted, and stages clickable sources", async () => {
    const session = mkSession({ id: "ses_web" })
    // `preSearch` is the whole verdict, not just the master switch: it also
    // needs web tools on and a configured provider.
    useSettingsStore.setState({
      settings: {
        searchEnabled: true,
        webTools: { enabled: true },
        defaultSearchProvider: "tavily",
        searchProviders: { tavily: { providerId: "tavily", enabled: true, apiKey: "tvly" } },
      } as never,
    })
    jest.mocked(searchWithAppSettings).mockResolvedValue({
      query: "latest Cognia",
      provider: "tavily",
      results: [
        {
          title: "Cognia docs",
          url: "https://example.com/docs",
          content: "A useful result",
          score: 0.8,
        },
      ],
      responseTime: 10,
    })
    useChatStore.getState().setWebSearchOnForNextSend(true, session.id)
    const onSend = jest.fn(async () => undefined)
    const { ta } = renderComposer(session, onSend)

    fireEvent.change(ta, { target: { value: "latest Cognia" } })
    fireEvent.keyDown(ta, { key: "Enter" })

    await waitFor(() => expect(searchWithAppSettings).toHaveBeenCalledWith("latest Cognia"))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith(
        expect.stringContaining("[Untrusted web content below"),
        [],
        null,
        {
          webSearchContext: {
            provider: "tavily",
            results: [
              {
                title: "Cognia docs",
                url: "https://example.com/docs",
                content: "A useful result",
                score: 0.8,
              },
            ],
          },
          // The results ride in the context envelope, which the bubble folds
          // away and every "what did the user type" reader strips.
          promptPreamble: { sections: ["webSearch"], references: [] },
        }
      )
    )
    const sent = (onSend.mock.calls[0] as unknown as [string])[0]
    expect(stripPromptPreamble(sent)).toBe("latest Cognia")
  })

  it("does not run a previously armed pre-search after web tools are turned off", async () => {
    // The master switch is still on and a provider is still configured — only
    // the `webTools` kill switch flipped. Re-deriving just `searchEnabled` let
    // an armed toggle reach the network after the user said no.
    const session = mkSession({ id: "ses_web_killswitch" })
    useSettingsStore.setState({
      settings: {
        searchEnabled: true,
        webTools: { enabled: false },
        defaultSearchProvider: "tavily",
        searchProviders: { tavily: { providerId: "tavily", enabled: true, apiKey: "tvly" } },
      } as never,
    })
    useChatStore.getState().setWebSearchOnForNextSend(true, session.id)
    const onSend = jest.fn(async () => undefined)
    const { ta } = renderComposer(session, onSend)

    fireEvent.change(ta, { target: { value: "latest Cognia" } })
    fireEvent.keyDown(ta, { key: "Enter" })

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(searchWithAppSettings).not.toHaveBeenCalled()
  })

  it("does not run a previously armed pre-search with no configured provider", async () => {
    const session = mkSession({ id: "ses_web_noprovider" })
    useSettingsStore.setState({
      settings: { searchEnabled: true, webTools: { enabled: true } } as never,
    })
    useChatStore.getState().setWebSearchOnForNextSend(true, session.id)
    const onSend = jest.fn(async () => undefined)
    const { ta } = renderComposer(session, onSend)

    fireEvent.change(ta, { target: { value: "latest Cognia" } })
    fireEvent.keyDown(ta, { key: "Enter" })

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(searchWithAppSettings).not.toHaveBeenCalled()
  })

  it("does not run a previously armed pre-search after the setting is disabled", async () => {
    const session = mkSession({ id: "ses_web_disabled" })
    useSettingsStore.setState({ settings: { searchEnabled: false } as never })
    useChatStore.getState().setWebSearchOnForNextSend(true, session.id)
    const onSend = jest.fn(async () => undefined)
    const { ta } = renderComposer(session, onSend)

    fireEvent.change(ta, { target: { value: "latest Cognia" } })
    fireEvent.keyDown(ta, { key: "Enter" })

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(searchWithAppSettings).not.toHaveBeenCalled()
    expect(selectComposerWebSearchOn(useChatStore.getState(), session.id)).toBe(false)
  })
})

describe("side chat local entry and return path", () => {
  beforeEach(() => {
    jest.mocked(dispatchSideChat).mockClear()
    setBehavior({ persistDrafts: false })
  })

  it("withholds nested side chat commands and their hints inside an aside", async () => {
    const { ta, onSend } = renderComposer(mkSession({ kind: "resource-workbench" }))
    fireEvent.change(ta, { target: { value: "/btw nested question" } })
    fireEvent.keyDown(ta, { key: "Enter", code: "Enter" })
    await act(async () => {})
    expect(dispatchSideChat).not.toHaveBeenCalled()
    expect(onSend).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain(
      "Ask a question in the conversation's side chat"
    )
  })

  it.each(["streaming", "awaiting_approval"] as const)(
    "runs btw locally during %s",
    async (status) => {
      const session = mkSession()
      const stop = jest.fn()
      const { ta, onSend } = renderComposer(session, undefined, { status, onStop: stop })
      fireEvent.change(ta, { target: { value: "/btw explain this" } })
      fireEvent.keyDown(ta, { key: "Enter", code: "Enter" })
      await waitFor(() =>
        expect(dispatchSideChat).toHaveBeenCalledWith(
          expect.objectContaining({ args: "explain this", activeSessionId: session.id })
        )
      )
      expect(onSend).not.toHaveBeenCalled()
      expect(stop).not.toHaveBeenCalled()
      await waitFor(() => expect(ta.value).toBe(""))
      expect(useChatStore.getState().sessions[session.id]?.messages ?? []).toHaveLength(0)
    }
  )

  it("handles side locally even while the main send promise is unresolved", async () => {
    let resolveSend!: () => void
    const pending = jest.fn(
      () =>
        new Promise<undefined>((resolve) => {
          resolveSend = () => resolve(undefined)
        })
    )
    const { ta } = renderComposer(mkSession(), pending)
    fireEvent.change(ta, { target: { value: "main task" } })
    fireEvent.keyDown(ta, { key: "Enter", code: "Enter" })
    await waitFor(() => expect(pending).toHaveBeenCalledTimes(1))
    fireEvent.change(ta, { target: { value: "/side separate question" } })
    fireEvent.keyDown(ta, { key: "Enter", code: "Enter" })
    await waitFor(() =>
      expect(dispatchSideChat).toHaveBeenCalledWith(
        expect.objectContaining({ args: "separate question" })
      )
    )
    expect(pending).toHaveBeenCalledTimes(1)
    await act(async () => resolveSend())
  })

  it.each(["idle", "streaming", "awaiting_approval"] as const)(
    "submits an appended quote through onSend during %s",
    async (status) => {
      const session = mkSession()
      const { ta, onSend } = renderComposer(session, undefined, { status })
      const onSubmitted = jest.fn()
      fireEvent.change(ta, { target: { value: "existing draft" } })
      act(() => {
        expect(
          dispatchComposerAppend({
            sessionId: session.id,
            text: "> aside reply",
            submit: true,
            onSubmitted,
          })
        ).toBe(true)
      })
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
      expect(stripPromptPreamble((onSend.mock.calls[0] as unknown as [string])[0])).toBe(
        "existing draft > aside reply"
      )
      await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(true))
    }
  )

  it("keeps a submitted quote as a draft when the composer is disabled", async () => {
    const session = mkSession()
    const { ta, onSend } = renderComposer(session, undefined, { disabled: true })
    const onSubmitted = jest.fn()
    act(() => {
      expect(
        dispatchComposerAppend({
          sessionId: session.id,
          text: "> keep this",
          submit: true,
          onSubmitted,
        })
      ).toBe(true)
    })
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith(false))
    expect(ta.value).toBe("> keep this")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("Bring back appends without sending", async () => {
    const session = mkSession()
    const { ta, onSend } = renderComposer(session)
    act(() => {
      dispatchComposerAppend({ sessionId: session.id, text: "> draft only" })
    })
    await waitFor(() => expect(ta.value).toBe("> draft only"))
    expect(onSend).not.toHaveBeenCalled()
  })
})
