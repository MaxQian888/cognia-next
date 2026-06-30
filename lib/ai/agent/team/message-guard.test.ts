import {
  canSendMessage,
  describeSuppressedMessage,
  looksLikeIdleAckOnlyText,
  DEFAULT_MESSAGE_GUARD_LIMITS,
  type RecentMessage,
} from "@/lib/ai/agent/team/message-guard"

describe("looksLikeIdleAckOnlyText", () => {
  it("matches English ack-only phrases (exact set)", () => {
    for (const s of ["ok", "Okay!", "  understood ", "Got it.", "no problem", "ready"]) {
      expect(looksLikeIdleAckOnlyText(s)).toBe(true)
    }
  })

  it("matches 简体中文 ack-only phrases", () => {
    for (const s of ["好的", "收到", "明白了", "没有任务", "等待任务", "准备好了"]) {
      expect(looksLikeIdleAckOnlyText(s)).toBe(true)
    }
  })

  it("matches phrase heuristics inside a slightly longer ack", () => {
    expect(looksLikeIdleAckOnlyText("I am currently idle and waiting for tasks")).toBe(true)
    expect(looksLikeIdleAckOnlyText("目前没有任务，我先等着")).toBe(true)
  })

  it("does NOT match substantive content", () => {
    expect(
      looksLikeIdleAckOnlyText("Found 3 bugs in the auth flow; fixing the JWT refresh now")
    ).toBe(false)
    expect(looksLikeIdleAckOnlyText("我发现登录接口在并发时会丢失会话，建议加锁")).toBe(false)
    expect(looksLikeIdleAckOnlyText("")).toBe(false)
  })

  it("never suppresses long text even if it starts with an ack", () => {
    const long = "ok — " + "x".repeat(DEFAULT_MESSAGE_GUARD_LIMITS.idleAckMaxChars)
    expect(looksLikeIdleAckOnlyText(long)).toBe(false)
  })
})

describe("canSendMessage", () => {
  const base = (over: Partial<Parameters<typeof canSendMessage>[0]> = {}) => ({
    senderId: "a",
    content: "Investigated the cache layer — found a stale-key bug, opening a fix.",
    now: 1_000_000,
    recentMessages: [] as RecentMessage[],
    ...over,
  })

  it("allows a fresh substantive broadcast", () => {
    expect(canSendMessage(base())).toEqual({ allow: true, reason: "ok" })
  })

  it("blocks idle/ack-only content", () => {
    expect(canSendMessage(base({ content: "ok" }))).toEqual({ allow: false, reason: "idle_ack" })
  })

  it("blocks an exact duplicate within the dedupe window", () => {
    const recent: RecentMessage[] = [
      { senderId: "a", recipientId: "b", content: "Status: deploy is green.", createdAt: 999_000 },
    ]
    const d = canSendMessage(
      base({ recipientId: "b", content: "status:  Deploy is GREEN. ", recentMessages: recent })
    )
    expect(d).toEqual({ allow: false, reason: "duplicate" })
  })

  it("does not treat a different recipient as a duplicate", () => {
    const recent: RecentMessage[] = [
      { senderId: "a", recipientId: "b", content: "Status: deploy is green.", createdAt: 999_000 },
    ]
    const d = canSendMessage(
      base({ recipientId: "c", content: "Status: deploy is green.", recentMessages: recent })
    )
    expect(d.allow).toBe(true)
  })

  it("blocks a too-fast repeat to the same teammate (pair cooldown)", () => {
    const recent: RecentMessage[] = [
      { senderId: "a", recipientId: "b", content: "first ping", createdAt: 999_000 },
    ]
    const d = canSendMessage(
      base({
        recipientId: "b",
        content: "different follow-up content here",
        now: 1_000_500,
        recentMessages: recent,
      })
    )
    expect(d).toEqual({ allow: false, reason: "pair_cooldown" })
  })

  it("allows a direct message once the pair cooldown elapses", () => {
    const recent: RecentMessage[] = [
      { senderId: "a", recipientId: "b", content: "first ping", createdAt: 990_000 },
    ]
    const d = canSendMessage(
      base({
        recipientId: "b",
        content: "a substantive follow-up after some time",
        recentMessages: recent,
      })
    )
    expect(d.allow).toBe(true)
  })

  it("does not apply pair cooldown to broadcasts", () => {
    const recent: RecentMessage[] = [
      { senderId: "a", content: "broadcast one with content", createdAt: 1_000_500 - 100 },
    ]
    const d = canSendMessage(
      base({ content: "broadcast two distinct content", now: 1_000_500, recentMessages: recent })
    )
    expect(d.allow).toBe(true)
  })

  it("blocks once the per-sender rate cap is hit", () => {
    const recent: RecentMessage[] = Array.from({ length: 10 }, (_, i) => ({
      senderId: "a",
      content: `msg ${i} unique content`,
      createdAt: 1_000_000 - i * 100,
    }))
    const d = canSendMessage(base({ content: "one more distinct message", recentMessages: recent }))
    expect(d).toEqual({ allow: false, reason: "rate_limited" })
  })

  it("ignores stale messages outside the rate window", () => {
    const recent: RecentMessage[] = Array.from({ length: 10 }, (_, i) => ({
      senderId: "a",
      content: `old ${i}`,
      createdAt: 1_000_000 - DEFAULT_MESSAGE_GUARD_LIMITS.rateWindowMs - i,
    }))
    const d = canSendMessage(base({ content: "fresh distinct message", recentMessages: recent }))
    expect(d.allow).toBe(true)
  })

  it("scopes counters to the sender", () => {
    const recent: RecentMessage[] = Array.from({ length: 20 }, (_, i) => ({
      senderId: "other",
      content: `other ${i}`,
      createdAt: 1_000_000 - i,
    }))
    expect(
      canSendMessage(base({ content: "my distinct message", recentMessages: recent })).allow
    ).toBe(true)
  })

  it("honours overridden limits", () => {
    const recent: RecentMessage[] = [
      { senderId: "a", content: "m1 distinct", createdAt: 1_000_000 - 1 },
    ]
    const d = canSendMessage(
      base({ content: "m2 distinct", recentMessages: recent, limits: { maxPerWindow: 1 } })
    )
    expect(d.reason).toBe("rate_limited")
  })
})

describe("describeSuppressedMessage", () => {
  it("returns a distinct hint per reason", () => {
    const reasons = ["idle_ack", "duplicate", "pair_cooldown", "rate_limited"] as const
    const texts = reasons.map(describeSuppressedMessage)
    expect(new Set(texts).size).toBe(reasons.length)
    for (const t of texts) expect(t).toMatch(/^Suppressed:/)
  })
})
