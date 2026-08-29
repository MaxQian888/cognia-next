/** @jest-environment jsdom */

import type { StoredMessage } from "@cognia/agent-config-types"

import {
  countMentionLinksFor,
  deleteMentionLinksForMessages,
  deleteMentionLinksForSession,
  getMentionLinkState,
  listMentionLinksFor,
  mentionLinkId,
  projectMessageMentionLinks,
  putMentionLinks,
  reconcileSessionMentionLinks,
  setMentionLinkState,
} from "./mention-links"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

jest.setTimeout(30_000)

function message(over: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: "m1",
    sessionId: "s1",
    projectId: "p",
    role: "user",
    createdAt: 1_000,
    parts: [{ type: "text", text: "hello" }],
    ...over,
  } as StoredMessage
}

const mention = (kind: string, id: string, label?: string) => ({
  kind,
  id,
  ...(label ? { label } : {}),
})

describe("projectMessageMentionLinks", () => {
  it("is empty for a message that cited nothing", () => {
    expect(projectMessageMentionLinks(message())).toEqual([])
  })

  it("records one row per citation, carrying the label the turn used", () => {
    const rows = projectMessageMentionLinks(
      message({
        metadata: { mentions: [mention("entity", "memory:mem_1", "Prefers pnpm")] },
      })
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      refKind: "entity",
      refId: "memory:mem_1",
      refLabel: "Prefers pnpm",
      messageId: "m1",
      sessionId: "s1",
      createdAt: 1_000,
    })
  })

  // A turn that mentions the same file twice cited it once; two rows would
  // double it in every count this table exists to produce.
  it("deduplicates a repeated citation", () => {
    const rows = projectMessageMentionLinks(
      message({
        metadata: { mentions: [mention("file", "src/a.ts"), mention("file", "src/a.ts")] },
      })
    )
    expect(rows).toHaveLength(1)
  })

  it("keeps two different kinds that share an id apart", () => {
    const rows = projectMessageMentionLinks(
      message({ metadata: { mentions: [mention("file", "x"), mention("agent", "x")] } })
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((r) => r.linkId)).size).toBe(2)
  })

  it("leaves projectId empty rather than undefined for a pre-isolation row", () => {
    const rows = projectMessageMentionLinks(
      message({ projectId: undefined, metadata: { mentions: [mention("file", "a")] } })
    )
    expect(rows[0].projectId).toBe("")
  })

  // Deliberately NOT the legacy text fallback. `resolveMentions` types every
  // token it cannot resolve as a FILE, so re-parsing prose would fill the file
  // backlinks with things that were never files — while recovering none of the
  // entity citations the panels query, because a chip-style pick leaves no
  // token in the text to recover.
  it("gives a pre-ContextRef message no backlinks rather than guessed ones", () => {
    const rows = projectMessageMentionLinks(
      message({
        metadata: undefined,
        parts: [{ type: "text", text: "look at @src/a.ts" }] as never,
      })
    )
    expect(rows).toEqual([])
  })
})

describe("the backlink table", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().mentionLinks.clear()
  })
  afterAll(dbFixture.dispose)

  const row = (over: Record<string, unknown> = {}) => ({
    linkId: mentionLinkId("m1", "entity", "memory:mem_1"),
    refKind: "entity" as const,
    refId: "memory:mem_1",
    messageId: "m1",
    sessionId: "s1",
    projectId: "p",
    createdAt: 1_000,
    ...over,
  })

  it("finds the turns citing one record", async () => {
    await putMentionLinks([row(), row({ linkId: "other", refId: "memory:other" })])
    const found = await listMentionLinksFor("entity", "memory:mem_1")
    expect(found.map((r) => r.messageId)).toEqual(["m1"])
    expect(await countMentionLinksFor("entity", "memory:mem_1")).toBe(1)
  })

  it("orders citations newest first", async () => {
    await putMentionLinks([
      row({ linkId: "a", messageId: "a", createdAt: 1 }),
      row({ linkId: "b", messageId: "b", createdAt: 3 }),
      row({ linkId: "c", messageId: "c", createdAt: 2 }),
    ])
    expect((await listMentionLinksFor("entity", "memory:mem_1")).map((r) => r.messageId)).toEqual([
      "b",
      "c",
      "a",
    ])
  })

  it("is empty for a record nothing referenced", async () => {
    expect(await listMentionLinksFor("entity", "memory:nope")).toEqual([])
    expect(await countMentionLinksFor("entity", "memory:nope")).toBe(0)
  })

  it("returns nothing for a non-positive limit", async () => {
    await putMentionLinks([row()])
    expect(await listMentionLinksFor("entity", "memory:mem_1", 0)).toEqual([])
  })

  it("upserts by link id rather than duplicating", async () => {
    await putMentionLinks([row()])
    await putMentionLinks([row({ refLabel: "renamed" })])
    expect(await countMentionLinksFor("entity", "memory:mem_1")).toBe(1)
  })

  it("drops a message's links", async () => {
    await putMentionLinks([row(), row({ linkId: "x", messageId: "m2" })])
    await deleteMentionLinksForMessages(["m1"])
    expect((await listMentionLinksFor("entity", "memory:mem_1")).map((r) => r.messageId)).toEqual([
      "m2",
    ])
  })

  it("drops a session's links", async () => {
    await putMentionLinks([row(), row({ linkId: "x", sessionId: "s2" })])
    await deleteMentionLinksForSession("s1")
    expect((await listMentionLinksFor("entity", "memory:mem_1")).map((r) => r.sessionId)).toEqual([
      "s2",
    ])
  })

  // An edited turn REMOVES citations; an append-only index would keep claiming
  // a record is referenced by a message that no longer mentions it.
  it("reconciles a session against a fresh message list", async () => {
    await putMentionLinks([row({ linkId: "stale", messageId: "gone" })])
    const { written, removed } = await reconcileSessionMentionLinks("s1", [
      message({ metadata: { mentions: [mention("entity", "memory:mem_1")] } }),
    ])
    expect(written).toHaveLength(1)
    expect(removed).toEqual(["stale"])
    expect(await countMentionLinksFor("entity", "memory:mem_1")).toBe(1)
  })

  it("carries its own backfill watermark", async () => {
    expect(await getMentionLinkState()).toMatchObject({ complete: false })
    await setMentionLinkState({ oldestProjectedAt: 9, oldestProjectedId: "m", complete: true })
    expect(await getMentionLinkState()).toMatchObject({ oldestProjectedAt: 9, complete: true })
  })
})
