import { buildWritingSeed, startWritingForTopic } from "./start-writing"
import { zhihuRoleCharacterId } from "../characters/pack"
import type { TopicRow } from "../db/tables"

jest.mock("@/lib/claude/adapter", () => ({
  makeUserMessage: (text: string) => ({ id: "m1", role: "user", parts: [{ type: "text", text }] }),
}))

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
  it("marks selected, opens a Writer-character session seeded with the topic, activates it", async () => {
    const createSession = jest.fn(async (_p: { title?: string; characterId?: string }) => ({
      id: "sess_1",
    }))
    const persistMessages = jest.fn(async (_sessionId: string, _messages: unknown[]) => undefined)
    const setActiveSession = jest.fn()
    const markTopicStatus = jest.fn(async (_id: string, _status: string) => undefined)

    const id = await startWritingForTopic(topic, {
      createSession,
      persistMessages,
      setActiveSession,
      markTopicStatus,
    })

    expect(id).toBe("sess_1")
    expect(markTopicStatus).toHaveBeenCalledWith("topic_1", "selected")
    expect(createSession).toHaveBeenCalledWith({
      title: `知乎写作：${topic.title}`,
      characterId: zhihuRoleCharacterId("writer"),
    })
    expect(persistMessages).toHaveBeenCalledTimes(1)
    const call = persistMessages.mock.calls[0]
    expect(call[0]).toBe("sess_1")
    const messages = call[1] as Array<{ role: string }>
    expect(messages[0].role).toBe("user")
    expect(setActiveSession).toHaveBeenCalledWith("sess_1")
  })
})
