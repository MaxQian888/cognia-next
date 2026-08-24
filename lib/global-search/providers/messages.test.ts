import type { ChatSearchOutcome, ChatSearchResult } from "@/lib/chat/search/engine"

import { makeProviderInput, makeTestContext, TEST_NOW } from "../testing"
import {
  MIN_MESSAGE_QUERY_LENGTH,
  coverageOf,
  createMessagesProvider,
  messageHitAction,
  messageResultToItem,
  toChatSearchQuery,
} from "./messages"

const result = (over: Partial<ChatSearchResult> = {}): ChatSearchResult => ({
  messageId: "m1",
  sessionId: "s1",
  sessionTitle: "Deploy",
  projectId: "p1",
  role: "user",
  createdAt: TEST_NOW - 1,
  count: 2,
  at: 0,
  snippet: { text: "the needle here", positions: [4, 5, 6, 7, 8, 9] },
  score: 1.8,
  archived: false,
  otherBranchCount: 1,
  ...over,
})

const outcome = (over: Partial<ChatSearchOutcome> = {}): ChatSearchOutcome => ({
  results: [result()],
  moreOlderHistory: false,
  indexIncomplete: false,
  ...over,
})

describe("toChatSearchQuery", () => {
  it("maps filters and collapses per session only in the chats scope", () => {
    const input = makeProviderInput(
      "from:me is:archived after:2026-08-01 workspace:current needle",
      {
        ctx: makeTestContext({ scope: "chats", activeProjectId: "p9" }),
        limit: 7,
      }
    )
    expect(toChatSearchQuery(input.query, input.ctx, input.limit)).toEqual({
      query: "needle",
      limit: 7,
      includeArchived: true,
      projectId: "p9",
      collapseBySession: true,
      roles: ["user"],
      after: new Date(2026, 7, 1).getTime(),
      before: undefined,
    })
    const plain = makeProviderInput("needle", { ctx: makeTestContext({ scope: "messages" }) })
    const q = toChatSearchQuery(plain.query, plain.ctx, 5)
    expect(q.collapseBySession).toBe(false)
    // Scoped to the active workspace even with no `workspace:` token — the
    // default changed from `all`, which used to leak every other workspace's
    // messages into a plain search.
    expect(q.projectId).toBe("p1")
    expect(q.roles).toBeUndefined()
    expect(q.includeArchived).toBe(false)

    const widened = makeProviderInput("needle workspace:all", {
      ctx: makeTestContext({ scope: "messages" }),
    })
    expect(toChatSearchQuery(widened.query, widened.ctx, 5).projectId).toBeUndefined()
  })
})

describe("messageResultToItem", () => {
  it("projects the engine row into an item with role meta and snippet", () => {
    const item = messageResultToItem(result(), makeTestContext())
    expect(item).toMatchObject({
      id: "message:m1",
      kind: "message",
      title: "Deploy",
      subtitle: "the needle here",
      subtitlePositions: [4, 5, 6, 7, 8, 9],
      meta: "globalSearch.roles.user",
      timestamp: TEST_NOW - 1,
      extra: { role: "user", archived: false, otherBranchCount: 1, occurrenceCount: 2 },
      action: { type: "open-session", sessionId: "s1", messageId: "m1" },
    })
    expect(item.score).toBeCloseTo(0.5)
    expect(
      messageResultToItem(result({ role: "tool", sessionTitle: " " }), makeTestContext())
    ).toMatchObject({
      meta: "globalSearch.roles.other",
      title: "globalSearch.untitledConversation",
    })
    expect(messageResultToItem(result({ role: "system" }), makeTestContext()).meta).toBe(
      "globalSearch.roles.system"
    )
    expect(messageResultToItem(result({ role: "assistant" }), makeTestContext()).meta).toBe(
      "globalSearch.roles.assistant"
    )
  })

  it("sends hits in a platform-bound session to the Inbox route with the message id", () => {
    const ctx = makeTestContext({
      sessions: [
        {
          id: "s1",
          title: "Ops",
          platformBinding: { platform: "lark", adapterId: "a1", conversationKey: "lark:a1:oc" },
        },
        { id: "s2", title: "Plain" },
      ] as never,
    })
    expect(messageHitAction({ sessionId: "s1", messageId: "m1" }, ctx)).toEqual({
      type: "open-inbox-conversation",
      conversationKey: "lark:a1:oc",
      messageId: "m1",
    })
    expect(messageHitAction({ sessionId: "s2", messageId: "m2" }, ctx)).toEqual({
      type: "open-session",
      sessionId: "s2",
      messageId: "m2",
    })
    // Unknown session (not in the dialog's list) → the plain chat action.
    expect(messageHitAction({ sessionId: "ghost", messageId: "m3" }, ctx).type).toBe("open-session")
    expect(messageResultToItem(result(), ctx).action).toEqual({
      type: "open-inbox-conversation",
      conversationKey: "lark:a1:oc",
      messageId: "m1",
    })
  })
})

describe("messages provider", () => {
  it("skips short queries and title-only queries without hitting the engine", async () => {
    const search = jest.fn(async () => outcome())
    const provider = createMessagesProvider({ search })
    expect(await provider.search(makeProviderInput("a"))).toEqual({ items: [] })
    expect(await provider.search(makeProviderInput("title:needle"))).toEqual({ items: [] })
    expect(search).not.toHaveBeenCalled()
    expect("ab".length).toBe(MIN_MESSAGE_QUERY_LENGTH)
  })

  it("maps results, coverage and truncation, passing pending rows through", async () => {
    const pendingRows = jest.fn(() => [])
    const search = jest.fn(async () => outcome({ moreOlderHistory: true }))
    const provider = createMessagesProvider({ search, pendingRows })
    const out = await provider.search(makeProviderInput("needle", { limit: 4 }))
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "needle", limit: 4 }), {
      pendingRows,
    })
    expect(out.items).toHaveLength(1)
    expect(out.truncated).toBe(true)
    expect(out.coverage).toBe("partial")
    const indexing = createMessagesProvider({
      search: async () => outcome({ indexIncomplete: true, moreOlderHistory: true }),
    })
    expect((await indexing.search(makeProviderInput("needle"))).coverage).toBe("indexing")
    const complete = createMessagesProvider({ search: async () => outcome() })
    const done = await complete.search(makeProviderInput("needle"))
    expect(done.coverage).toBe("complete")
    expect(done.truncated).toBe(false)
  })

  it("returns nothing when aborted mid-flight", async () => {
    const controller = new AbortController()
    const provider = createMessagesProvider({
      search: async () => {
        controller.abort()
        return outcome()
      },
    })
    const out = await provider.search(makeProviderInput("needle", { signal: controller.signal }))
    expect(out.items).toEqual([])
  })

  it("coverageOf prefers indexing over partial", () => {
    expect(coverageOf(outcome({ indexIncomplete: true }))).toBe("indexing")
    expect(coverageOf(outcome({ moreOlderHistory: true }))).toBe("partial")
    expect(coverageOf(outcome())).toBe("complete")
  })
})
