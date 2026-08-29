/** @jest-environment jsdom */

import type { StoredMessage } from "@cognia/agent-config-types"

import {
  RESULT_PREVIEW_MAX_CHARS,
  countChatResults,
  deleteChatResultsForMessages,
  deleteChatResultsForSession,
  getChatResultIndexState,
  loadNewestChatResults,
  projectMessageResults,
  putChatResultRows,
  reconcileSessionResults,
  searchChatResults,
  setChatResultIndexState,
} from "./chat-result-index"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

jest.setTimeout(30_000)

function message(over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    sessionId: "s1",
    projectId: "p",
    role: "assistant",
    createdAt: 1_000,
    parts: [],
    ...over,
  } as StoredMessage
}

const tool = (name: string, input: unknown, output: unknown) => ({
  type: `tool-${name}`,
  state: "output-available",
  input,
  output,
})

describe("projectMessageResults", () => {
  it("indexes a tool output", () => {
    const rows = projectMessageResults(
      message({ parts: [tool("Read", { file_path: "/tmp/a.txt" }, "body")] as never })
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "tool",
      toolName: "Read",
      title: "/tmp/a.txt",
      preview: "body",
      bytes: 4,
    })
  })

  // A session holds dozens of `Read` results and one `Read /etc/hosts`; the
  // tool name alone cannot tell them apart.
  it("names a result by what it was ABOUT, not by the tool", () => {
    expect(
      projectMessageResults(
        message({ parts: [tool("Bash", { command: "ls -la" }, "a")] as never })
      )[0].title
    ).toBe("ls -la")
  })

  it("falls back to the tool name when the input has nothing name-like", () => {
    expect(
      projectMessageResults(message({ parts: [tool("Weird", { flag: true }, "a")] as never }))[0]
        .title
    ).toBe("Weird")
  })

  // A result you cannot read is not a result you can reuse.
  it("skips a tool call that has not returned", () => {
    expect(
      projectMessageResults(
        message({ parts: [{ type: "tool-Read", state: "input-available" }] as never })
      )
    ).toEqual([])
  })

  // Both parts are POINTERS — an `artifactId` plus a title snapshot — whose
  // bodies live in their own stores, where `@artifact:` reads them live.
  // Indexing them would put one document behind two doors with two bodies.
  it("does not index an artifact or a canvas pointer", () => {
    expect(
      projectMessageResults(
        message({
          parts: [
            { type: "artifact", artifactId: "a1", title: "parser.ts", kind: "code" },
            { type: "canvas", canvasId: "c1", title: "Notes" },
          ] as never,
        })
      )
    ).toEqual([])
  })

  // Indexed by position, so re-projecting one message overwrites its own rows
  // rather than accumulating them.
  it("keys a row by message and part index", () => {
    const rows = projectMessageResults(
      message({
        parts: [{ type: "text", text: "hi" }, tool("Read", { path: "/a" }, "b")] as never,
      })
    )
    expect(rows[0].resultId).toBe("m1:1")
  })

  it("clamps the preview and still records the true size", () => {
    const rows = projectMessageResults(
      message({ parts: [tool("Read", { path: "/a" }, "x".repeat(5_000))] as never })
    )
    expect(rows[0].preview.length).toBeLessThanOrEqual(RESULT_PREVIEW_MAX_CHARS + 1)
    expect(rows[0].bytes).toBe(5_000)
  })

  it("builds a lowercased haystack over name, title and preview", () => {
    const rows = projectMessageResults(
      message({ parts: [tool("Grep", { pattern: "TODO" }, "MATCHED")] as never })
    )
    expect(rows[0].searchText).toBe("grep todo matched")
  })

  it("leaves projectId empty rather than undefined for a pre-isolation row", () => {
    const rows = projectMessageResults(
      message({ projectId: undefined, parts: [tool("Read", { path: "/a" }, "b")] as never })
    )
    expect(rows[0].projectId).toBe("")
  })

  it("is empty for parts that are not an array", () => {
    expect(projectMessageResults(message({ parts: undefined as never }))).toEqual([])
  })
})

describe("the result index table", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().chatResultIndex.clear()
  })
  afterAll(dbFixture.dispose)

  const row = (over: Record<string, unknown> = {}) => ({
    resultId: "m1:0",
    messageId: "m1",
    sessionId: "s1",
    projectId: "p",
    createdAt: 1_000,
    kind: "tool" as const,
    toolName: "Read",
    title: "/tmp/a.txt",
    preview: "body",
    bytes: 4,
    searchText: "read /tmp/a.txt body",
    ...over,
  })

  it("upserts by result id rather than duplicating", async () => {
    await putChatResultRows([row()])
    await putChatResultRows([row({ preview: "changed" })])
    expect(await countChatResults()).toBe(1)
    expect((await loadNewestChatResults(1))[0].preview).toBe("changed")
  })

  it("lists newest first", async () => {
    await putChatResultRows([
      row({ resultId: "a", createdAt: 1 }),
      row({ resultId: "b", createdAt: 3 }),
      row({ resultId: "c", createdAt: 2 }),
    ])
    expect((await loadNewestChatResults(3)).map((r) => r.resultId)).toEqual(["b", "c", "a"])
  })

  it("returns nothing for a non-positive limit", async () => {
    await putChatResultRows([row()])
    expect(await loadNewestChatResults(0)).toEqual([])
  })

  it("matches the haystack case-insensitively, newest first", async () => {
    await putChatResultRows([
      row({ resultId: "a", createdAt: 1, searchText: "read /tmp/a.txt body" }),
      row({ resultId: "b", createdAt: 2, searchText: "grep todo matched" }),
      row({ resultId: "c", createdAt: 3, searchText: "read /tmp/c.txt body" }),
    ])
    expect((await searchChatResults("READ", 10)).map((r) => r.resultId)).toEqual(["c", "a"])
  })

  it("falls back to the newest list for an empty needle", async () => {
    await putChatResultRows([row({ resultId: "a", createdAt: 1 })])
    expect(await searchChatResults("", 5)).toHaveLength(1)
  })

  it("stops at the limit instead of reading the rest of history", async () => {
    await putChatResultRows(
      Array.from({ length: 50 }, (_, i) => row({ resultId: `r${i}`, createdAt: i }))
    )
    expect(await searchChatResults("read", 5)).toHaveLength(5)
  })

  // A stale result row is worse than a stale search projection: a stale hit
  // jumps nowhere, but a stale result is INLINED into a prompt.
  it("drops a message's rows by message id", async () => {
    await putChatResultRows([
      row({ resultId: "m1:0" }),
      row({ resultId: "m1:1" }),
      row({ resultId: "m2:0", messageId: "m2" }),
    ])
    await deleteChatResultsForMessages(["m1"])
    expect((await loadNewestChatResults(10)).map((r) => r.resultId)).toEqual(["m2:0"])
  })

  it("drops a session's rows", async () => {
    await putChatResultRows([row(), row({ resultId: "x", sessionId: "s2" })])
    await deleteChatResultsForSession("s1")
    expect((await loadNewestChatResults(10)).map((r) => r.sessionId)).toEqual(["s2"])
  })

  it("is a no-op for an empty delete", async () => {
    await putChatResultRows([row()])
    await deleteChatResultsForMessages([])
    expect(await countChatResults()).toBe(1)
  })

  // Edits and truncation REMOVE messages; an append-only index would keep
  // offering a result whose message no longer renders.
  it("reconciles a session against a fresh message list", async () => {
    await putChatResultRows([row({ resultId: "gone:0" }), row({ resultId: "m1:0" })])
    const { written, removed } = await reconcileSessionResults("s1", [
      message({ parts: [tool("Read", { path: "/new" }, "fresh")] as never }),
    ])
    expect(written.map((r) => r.resultId)).toEqual(["m1:0"])
    expect(removed).toEqual(["gone:0"])
    expect((await loadNewestChatResults(10)).map((r) => r.resultId)).toEqual(["m1:0"])
  })

  it("carries its own backfill watermark", async () => {
    expect(await getChatResultIndexState()).toMatchObject({
      complete: false,
      oldestProjectedAt: null,
    })
    await setChatResultIndexState({ oldestProjectedAt: 7, oldestProjectedId: "m", complete: true })
    expect(await getChatResultIndexState()).toMatchObject({
      oldestProjectedAt: 7,
      oldestProjectedId: "m",
      complete: true,
    })
  })
})
