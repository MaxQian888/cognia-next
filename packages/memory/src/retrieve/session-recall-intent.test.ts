import { isSessionRecallQuery, SESSION_RECALL_EPISODIC_BOOST } from "./session-recall-intent"

describe("isSessionRecallQuery", () => {
  it("exports the multiplicative episodic boost", () => {
    expect(SESSION_RECALL_EPISODIC_BOOST).toBe(0.25)
  })

  it.each([
    "上次我们讨论的缓存方案是什么",
    "之前说过的那个配置",
    "昨天定下的结论",
    "上周的会议纪要",
    "在历史会话里提过",
    "那次会话中我们聊了什么",
    "我们当时怎么决定的",
  ])("matches CJK marker in %p", (query) => {
    expect(isSessionRecallQuery(query)).toBe(true)
  })

  it.each([
    "What did we decide last time about the cache?",
    "yesterday's plan",
    "In the previous session you suggested pnpm",
    "How did we fix the build?",
    "LAST WEEK we talked about deploys",
    "remind me what we did, previously",
    "the other day, you mentioned a bug",
    "When we paired on the parser…",
    "Back-then decision",
  ])("matches English marker in %p", (query) => {
    expect(isSessionRecallQuery(query)).toBe(true)
  })

  it.each([
    "subsequently configure the cache",
    "set a lasting timer for the job",
    "What is the capital of France?",
    "how do I install pnpm",
    "weddings and weekdays",
    "sessionless tokens",
    "",
    "缓存怎么配置",
  ])("does not match %p", (query) => {
    expect(isSessionRecallQuery(query)).toBe(false)
  })
})
