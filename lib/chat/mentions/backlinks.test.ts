/** @jest-environment jsdom */

import {
  EMPTY_BACKLINKS,
  entityBacklinkTarget,
  loadBacklinks,
  sessionBacklinkTarget,
} from "./backlinks"
import { putMentionLinks, type MentionLinkRow } from "@/lib/db/mention-links"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

jest.setTimeout(30_000)

describe("backlink targets", () => {
  // A `@memory:` pick records `{ kind: "entity", id: "memory:mem_1" }` — this
  // is the only place that composition is spelled.
  it("addresses a record the way its ContextRef does", () => {
    expect(entityBacklinkTarget("memory", "mem_1")).toEqual({
      refKind: "entity",
      refId: "memory:mem_1",
    })
  })

  it("addresses a conversation as the session entity", () => {
    expect(sessionBacklinkTarget("s_1")).toEqual({ refKind: "entity", refId: "session:s_1" })
  })
})

describe("loadBacklinks", () => {
  const dbFixture = createDbTestFixture()
  beforeAll(dbFixture.initialize)
  beforeEach(async () => {
    await dbFixture.restore()
    await getDb().mentionLinks.clear()
    await getDb().sessions.clear()
  })
  afterAll(dbFixture.dispose)

  const link = (over: Partial<MentionLinkRow> = {}): MentionLinkRow =>
    ({
      linkId: `${over.messageId ?? "m1"}|${over.sessionId ?? "s1"}`,
      refKind: "entity",
      refId: "memory:mem_1",
      messageId: "m1",
      sessionId: "s1",
      projectId: "p",
      createdAt: 1_000,
      ...over,
    }) as MentionLinkRow

  const target = entityBacklinkTarget("memory", "mem_1")

  it("is empty for a record nothing referenced", async () => {
    expect(await loadBacklinks(target)).toEqual(EMPTY_BACKLINKS)
  })

  it("groups by conversation and counts the turns", async () => {
    await getDb().sessions.put({ id: "s1", title: "Indexing work", updatedAt: 1 } as never)
    await putMentionLinks([
      link({ messageId: "a", createdAt: 1 }),
      link({ messageId: "b", createdAt: 2 }),
    ])
    const summary = await loadBacklinks(target)
    expect(summary.total).toBe(2)
    expect(summary.groups).toHaveLength(1)
    expect(summary.groups[0]).toMatchObject({
      sessionId: "s1",
      sessionTitle: "Indexing work",
      count: 2,
    })
  })

  // Rows arrive newest-first, so the first per session is both the newest
  // citation and the one a jump should land on.
  it("points each group at its newest citing turn", async () => {
    await putMentionLinks([
      link({ messageId: "old", createdAt: 1 }),
      link({ messageId: "new", createdAt: 5 }),
    ])
    expect((await loadBacklinks(target)).groups[0].messageId).toBe("new")
  })

  it("orders conversations by their newest citation", async () => {
    await putMentionLinks([
      link({ messageId: "a", sessionId: "s1", createdAt: 1 }),
      link({ messageId: "b", sessionId: "s2", createdAt: 9 }),
    ])
    expect((await loadBacklinks(target)).groups.map((g) => g.sessionId)).toEqual(["s2", "s1"])
  })

  // A turn citing an earlier turn of its own chat is a real citation but not a
  // backlink in the sense the badge means: "who ELSE reached for this".
  it("can leave out the conversation being displayed", async () => {
    await putMentionLinks([
      link({ messageId: "a", sessionId: "s1" }),
      link({ messageId: "b", sessionId: "s2" }),
    ])
    const summary = await loadBacklinks(target, { excludeSessionId: "s1" })
    expect(summary.groups.map((g) => g.sessionId)).toEqual(["s2"])
    expect(summary.total).toBe(1)
  })

  // The count is still true; dropping the row would silently under-report.
  it("keeps a citing conversation that no longer exists", async () => {
    await putMentionLinks([link({ messageId: "a", sessionId: "vanished" })])
    const summary = await loadBacklinks(target)
    expect(summary.groups[0]).toMatchObject({ sessionId: "vanished", sessionTitle: "vanished" })
  })

  it("falls back to the id for an untitled conversation", async () => {
    await getDb().sessions.put({ id: "s1", title: "", updatedAt: 1 } as never)
    await putMentionLinks([link({ messageId: "a" })])
    expect((await loadBacklinks(target)).groups[0].sessionTitle).toBe("s1")
  })

  it("does not mix up two records", async () => {
    await putMentionLinks([
      link({ messageId: "a", refId: "memory:mem_1" }),
      link({ messageId: "b", refId: "memory:other", linkId: "other" }),
    ])
    expect((await loadBacklinks(target)).total).toBe(1)
  })
})
