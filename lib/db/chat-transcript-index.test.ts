import type { TranscriptTimelineItem } from "@cognia/agent-config-types"

import { clearTranscriptIndex, commitTranscriptIndexPage } from "./chat-transcript-index"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function completed(turnKey: string, revision: number, startedAt: number): TranscriptTimelineItem {
  return {
    kind: "completed-turn",
    itemKey: turnKey,
    turnKey,
    revision,
    detailRevision: revision,
    status: "completed",
    userMessages: [],
    collapsed: { exists: false, messageCount: 1, trailingCount: 0, mediaCount: 0 },
    startedAt,
  }
}

describe("chat transcript index", () => {
  it("persists bounded pages and advances the resumable watermark", async () => {
    await commitTranscriptIndexPage({
      sessionId: "s1",
      revision: 1,
      items: [completed("new", 1, 20), completed("old", 1, 10)],
      complete: false,
      now: 30,
    })

    expect(await getDb().chatTurnSummaries.where("sessionId").equals("s1").count()).toBe(2)
    expect(await getDb().chatTranscriptIndexState.get("s1")).toMatchObject({
      revision: 1,
      indexedBeforeCreatedAt: 10,
      complete: false,
    })
  })

  it("clears stale summaries before committing a new session revision", async () => {
    await commitTranscriptIndexPage({
      sessionId: "s1",
      revision: 1,
      items: [completed("stale", 1, 10)],
      complete: true,
    })

    await commitTranscriptIndexPage({
      sessionId: "s1",
      revision: 2,
      items: [completed("fresh", 2, 20)],
      complete: true,
    })

    const rows = await getDb().chatTurnSummaries.where("sessionId").equals("s1").toArray()
    expect(rows.map((row) => row.turnKey)).toEqual(["fresh"])
  })

  it("clears only the requested session", async () => {
    await commitTranscriptIndexPage({ sessionId: "s1", revision: 1, items: [], complete: true })
    await commitTranscriptIndexPage({ sessionId: "s2", revision: 1, items: [], complete: true })

    await clearTranscriptIndex("s1")

    expect(await getDb().chatTranscriptIndexState.get("s1")).toBeUndefined()
    expect(await getDb().chatTranscriptIndexState.get("s2")).toBeDefined()
  })
})
