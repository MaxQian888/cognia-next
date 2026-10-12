import { groupReviewThreads, isBotUser } from "./review-threads"

describe("groupReviewThreads", () => {
  it("groups replies under their root and flags bot-only threads", () => {
    const threads = groupReviewThreads([
      { id: 1, path: "a.ts", line: 3, body: "root", user: { login: "human" } },
      { id: 2, in_reply_to_id: 1, body: "reply", user: { login: "human" } },
      { id: 5, path: "b.ts", original_line: 9, body: "bot note", user: { login: "cov[bot]" } },
    ])
    expect(threads).toHaveLength(2)
    expect(threads[0]).toMatchObject({
      id: "1",
      path: "a.ts",
      line: 3,
      isBot: false,
      resolved: false,
    })
    expect(threads[0].comments).toHaveLength(2)
    expect(threads[1]).toMatchObject({ id: "5", path: "b.ts", line: 9, isBot: true })
  })

  it("treats a reply to a missing root as its own thread and survives a reply cycle", () => {
    const threads = groupReviewThreads([
      { id: 10, in_reply_to_id: 999, body: "orphan", user: { login: "h" } },
      { id: 20, in_reply_to_id: 21, body: "cyclic-a", user: { login: "h" } },
      { id: 21, in_reply_to_id: 20, body: "cyclic-b", user: { login: "h" } },
    ])
    // Orphan is its own root; the cycle resolves without hanging.
    expect(threads.map((t) => t.id)).toContain("10")
    expect(threads.length).toBeGreaterThanOrEqual(2)
  })

  it("skips comments without an id", () => {
    expect(groupReviewThreads([{ body: "no id", user: { login: "h" } }])).toHaveLength(0)
  })

  it("tolerates a comment with no path/line/body/user", () => {
    const threads = groupReviewThreads([{ id: 1 }])
    expect(threads[0]).toMatchObject({ path: "", line: 0, isBot: false })
    expect(threads[0].comments[0]).toMatchObject({ author: "", body: "" })
  })
})

describe("isBotUser", () => {
  it("recognizes App accounts by type or login suffix, and nothing else", () => {
    expect(isBotUser({ login: "cognia[bot]" })).toBe(true)
    expect(isBotUser({ login: "renovate", type: "Bot" })).toBe(true)
    expect(isBotUser({ login: "octocat", type: "User" })).toBe(false)
    expect(isBotUser({ login: "bot-fan" })).toBe(false)
    expect(isBotUser(null)).toBe(false)
    expect(isBotUser(undefined)).toBe(false)
  })
})
