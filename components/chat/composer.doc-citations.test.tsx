/**
 * @jest-environment jsdom
 *
 * A remote document picked with `@lark:` (ADR-0134) is cited on the sent turn
 * only while its attachment is part of that turn. Driven through the REAL
 * <Composer>: the pick handler, the staging hook, the attachment gate, the
 * vendored provider's id minting, the chip's remove button and the send path
 * all run for real. Only the network edges (document search, document fetch,
 * the blob read) and the attachment dispatch are stubbed.
 *
 * The citation used to be recorded as a side effect of the pick, so a failed
 * fetch and a removed chip both still produced a `doc` citation in
 * `metadata.mentions`: a backlink to a document the model never received.
 */

import "fake-indexeddb/auto"

jest.setTimeout(30_000)

jest.mock("@/lib/slash-commands/custom", () => ({
  loadCustomSlashCommands: jest.fn(async () => []),
}))
jest.mock("@/lib/search/search-service", () => ({
  search: jest.fn(),
  formatSearchResultsForLLM: jest.fn(),
}))
jest.mock("@/lib/shell/exec", () => ({ executeShell: jest.fn(), formatShellResult: jest.fn() }))
jest.mock("@/lib/files/memory", () => ({ appendMemory: jest.fn() }))
// Stubbed for cost, not correctness: see composer.attachments.test.tsx.
jest.mock("./composer/attach-menu", () => ({ ComposerAttachMenu: () => null }))
jest.mock("./composer/voice-controls", () => ({ VoiceControls: () => null }))
jest.mock("@/hooks/use-platform", () => ({ usePlatform: jest.fn(() => "web") }))
jest.mock("@/lib/chat/link-context", () => ({
  ...jest.requireActual("@/lib/chat/link-context"),
  buildLinkContextBlocks: jest.fn(async () => ({ blocks: [], rejected: [], tokens: 0 })),
}))
jest.mock("@/lib/db/chat-drafts", () => ({
  clearDraft: jest.fn(async () => undefined),
  getDraft: jest.fn(async () => null),
  setDraftDebounced: jest.fn(),
}))
// The document extracts at staging time like any dropped file; the parser
// itself is the dispatch suite's business.
jest.mock("@/lib/chat/attachments/dispatch", () => ({
  ...jest.requireActual("@/lib/chat/attachments/dispatch"),
  extractAttachment: jest.fn(async () => ({
    kind: "document",
    block: { type: "text", text: "Release plan body" },
    tokens: 4,
    text: "Release plan body",
  })),
  buildSendContent: jest.fn(async (text: string) => ({
    content: text,
    rejected: [],
    tokens: 0,
    manifest: [],
  })),
}))

const searchState = {
  provider: null as unknown,
  hostSupported: true,
  reach: { available: true },
  accounts: [{ id: "cai_1", label: "Acme" }],
  accountId: "cai_1",
  setAccountId: () => undefined,
  items: [
    {
      providerId: "lark",
      kind: "doc",
      id: "doc_1",
      title: "Release plan",
      url: "https://x.feishu.cn/docx/doc_1",
    },
  ],
  loading: false,
  error: null,
  linkOnly: false,
}
jest.mock("@/hooks/chat/use-remote-doc-search", () => ({
  useRemoteDocSearch: () => searchState,
}))

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Composer } from "./composer"
import { DataAdapterProvider } from "@/lib/data-hooks/context"
import type { DataAdapter } from "@/lib/data-hooks/types"
import { useChatStore } from "@/stores/chat"
import { DocsProviderError, larkDocsProvider } from "@/lib/docs-providers"
import type { ChatSession } from "@cognia/agent-config-types"

searchState.provider = larkDocsProvider

function makeAdapter(): DataAdapter {
  return {
    useCharacters: () => undefined,
    useCharacter: () => undefined,
    useSkillsByIds: () => undefined,
    usePresets: () => undefined,
    clearMessages: jest.fn(async () => undefined),
    updateSession: jest.fn(async () => undefined),
    recordPresetUsage: jest.fn(async () => undefined),
    trustWorkspace: jest.fn(async () => undefined),
  }
}

const session: ChatSession = {
  id: "ses_doc_cite",
  title: "Doc citations",
  kind: "direct",
  permissionMode: undefined,
  createdAt: 0,
  updatedAt: 0,
}

const DOC_CITATION = {
  kind: "doc",
  id: "lark:doc_1",
  label: "Release plan",
  raw: "https://x.feishu.cn/docx/doc_1",
}

function renderComposer() {
  const onSend = jest.fn(async () => undefined)
  render(
    <DataAdapterProvider adapter={makeAdapter()}>
      <TooltipProvider>
        <Composer
          session={session}
          onStartNewSession={async () => undefined}
          onOpenSettings={() => undefined}
          onSend={onSend}
          onStop={async () => undefined}
        />
      </TooltipProvider>
    </DataAdapterProvider>
  )
  return { ta: document.querySelector("textarea") as HTMLTextAreaElement, onSend }
}

async function settle(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms))
  })
}

async function pickReleasePlan(ta: HTMLTextAreaElement) {
  await act(async () => {
    fireEvent.change(ta, { target: { value: "@lark:release" } })
    await new Promise((r) => setTimeout(r, 0))
  })
  await waitFor(() => expect(screen.queryAllByRole("listitem").length).toBeGreaterThan(0))
  await act(async () => {
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 30))
  })
}

async function send(ta: HTMLTextAreaElement, text: string) {
  await act(async () => {
    fireEvent.change(ta, { target: { value: text } })
    fireEvent.keyDown(ta, { key: "Enter" })
    await new Promise((r) => setTimeout(r, 50))
  })
}

/** The citations handed to `onSend` for its `index`-th call. */
function sentCitations(onSend: jest.Mock, index = 0): unknown[] {
  const turnMetadata = onSend.mock.calls[index]?.[3] as { citations?: unknown[] } | undefined
  return turnMetadata?.citations ?? []
}

let fetchSpy: jest.SpyInstance
let blobUrls = 0

beforeEach(() => {
  useChatStore.getState().clear()
  blobUrls = 0
  global.URL.createObjectURL = jest.fn(() => `blob:mock-${++blobUrls}`)
  global.URL.revokeObjectURL = jest.fn()
  // The staging store reads each staged blob back for extraction.
  global.fetch = jest.fn(async () => ({
    blob: async () => new Blob(["Release plan body"], { type: "text/markdown" }),
  })) as unknown as typeof fetch
  fetchSpy = jest.spyOn(larkDocsProvider, "fetch").mockResolvedValue({
    ref: searchState.items[0] as never,
    title: "Release plan",
    text: "Release plan body",
    format: "markdown",
  })
})

afterEach(() => {
  fetchSpy.mockRestore()
})

describe("Composer — a picked document is cited only while it is attached", () => {
  it("cites the document when its attachment is sent", async () => {
    const { ta, onSend } = renderComposer()
    await pickReleasePlan(ta)
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Remove Release plan.md" })).toBeInTheDocument()
    )
    await settle()

    await send(ta, "Summarize it")

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(sentCitations(onSend)).toEqual([DOC_CITATION])
  })

  it("does not cite a document whose chip was removed before sending", async () => {
    const { ta, onSend } = renderComposer()
    await pickReleasePlan(ta)
    const remove = await screen.findByRole("button", { name: "Remove Release plan.md" })
    await settle()
    await act(async () => {
      fireEvent.click(remove)
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(screen.queryByRole("button", { name: "Remove Release plan.md" })).toBeNull()

    await send(ta, "Summarize it")

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(sentCitations(onSend)).toEqual([])
  })

  it("does not cite a document whose fetch failed", async () => {
    fetchSpy.mockRejectedValue(new DocsProviderError("noPermission"))
    const { ta, onSend } = renderComposer()
    await pickReleasePlan(ta)
    await settle()
    expect(screen.queryByRole("button", { name: "Remove Release plan.md" })).toBeNull()

    await send(ta, "Summarize it")

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(sentCitations(onSend)).toEqual([])
  })

  // The citation belongs to exactly one turn, like the attachment it rides.
  it("does not carry a sent document's citation into the next turn", async () => {
    const { ta, onSend } = renderComposer()
    await pickReleasePlan(ta)
    await screen.findByRole("button", { name: "Remove Release plan.md" })
    await settle()
    await send(ta, "Summarize it")
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    await settle()

    await send(ta, "Thanks")

    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(2))
    expect(sentCitations(onSend, 0)).toEqual([DOC_CITATION])
    expect(sentCitations(onSend, 1)).toEqual([])
  })
})
