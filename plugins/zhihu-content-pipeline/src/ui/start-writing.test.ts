import { buildWritingSeed, startWritingForTopic } from "./start-writing"
import { zhihuRoleCharacterId } from "../characters/pack"
import type { TopicRow } from "../db/tables"

const topic: TopicRow = {
  id: "topic_1",
  title: "DeepSeek 永久降价意味着什么",
  url: "https://example.com/q/1",
  source: "zhihu-hot",
  reason: "事件性强、读者关心成本",
  score: 92,
  status: "candidate",
  createdAt: 1,
}

describe("buildWritingSeed", () => {
  it("includes the title, reason, and url, and asks for the 4-step start", () => {
    const seed = buildWritingSeed(topic)
    expect(seed).toContain(topic.title)
    expect(seed).toContain(topic.reason!)
    expect(seed).toContain(topic.url!)
    expect(seed).toContain("问题拆解")
  })

  it("omits reason/url lines when absent", () => {
    const seed = buildWritingSeed({ title: "T" })
    expect(seed).toContain("T")
    expect(seed).not.toContain("相关链接")
    expect(seed).not.toContain("角度/为什么值得写")
  })
})

describe("startWritingForTopic", () => {
  it("marks selected, then opens a Writer-character session seeded with the topic", async () => {
    const startSeededSession = jest.fn(async () => ({ sessionId: "sess_1" }))
    const markTopicStatus = jest.fn(async (_id: string, _status: string) => undefined)

    const id = await startWritingForTopic(topic, { startSeededSession, markTopicStatus })

    expect(id).toBe("sess_1")
    expect(markTopicStatus).toHaveBeenCalledWith("topic_1", "selected")
    expect(startSeededSession).toHaveBeenCalledWith({
      title: `知乎写作：${topic.title}`,
      characterId: zhihuRoleCharacterId("writer"),
      seedUserMessage: buildWritingSeed(topic),
    })
  })

  it("marks the topic selected BEFORE opening the session", async () => {
    // Order matters: a session that opens against a topic still marked
    // `candidate` leaves the review list offering it again.
    const order: string[] = []
    await startWritingForTopic(topic, {
      startSeededSession: jest.fn(async () => {
        order.push("session")
        return { sessionId: "sess_1" }
      }),
      markTopicStatus: jest.fn(async () => {
        order.push("status")
      }),
    })
    expect(order).toEqual(["status", "session"])
  })
})
