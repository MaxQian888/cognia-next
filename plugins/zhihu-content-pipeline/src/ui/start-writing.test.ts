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
  const sessionTitle = (title: string) => `Zhihu writing: ${title}`

  it("opens a Writer-character session seeded with the topic, then marks it selected", async () => {
    const startSeededSession = jest.fn(async () => ({ sessionId: "sess_1" }))
    const markTopicStatus = jest.fn(async () => undefined)

    const id = await startWritingForTopic(topic, {
      startSeededSession,
      markTopicStatus,
      sessionTitle,
    })

    expect(id).toBe("sess_1")
    expect(startSeededSession).toHaveBeenCalledWith({
      title: `Zhihu writing: ${topic.title}`,
      characterId: zhihuRoleCharacterId("writer"),
      seedUserMessage: buildWritingSeed(topic),
    })
    // The session id is recorded so a later draft can reopen it.
    expect(markTopicStatus).toHaveBeenCalledWith("topic_1", "selected", "sess_1")
  })

  it("marks the topic selected only AFTER the session has started", async () => {
    const order: string[] = []
    await startWritingForTopic(topic, {
      startSeededSession: jest.fn(async () => {
        order.push("session")
        return { sessionId: "sess_1" }
      }),
      markTopicStatus: jest.fn(async () => {
        order.push("status")
      }),
      sessionTitle,
    })
    expect(order).toEqual(["session", "status"])
  })

  it("leaves the topic a candidate when the session fails to start", async () => {
    const markTopicStatus = jest.fn(async () => undefined)
    await expect(
      startWritingForTopic(topic, {
        startSeededSession: jest.fn(async () => {
          throw new Error("no chat runtime")
        }),
        markTopicStatus,
        sessionTitle,
      })
    ).rejects.toThrow("no chat runtime")
    expect(markTopicStatus).not.toHaveBeenCalled()
  })
})
