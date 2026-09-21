/**
 * @jest-environment jsdom
 */
import {
  awaitAskUser,
  getPendingAskUser,
  getPendingAskUserBySurface,
  pendingAskUserCount,
  resolveAskUser,
  toggleAskUserValue,
  __resetAskUserRegistryForTesting,
  DEFAULT_ASK_USER_TTL_MS,
  type PendingAskUserMeta,
} from "./ask-user-registry"
import type { AskUserRequest } from "@/lib/claude/ask-user-tool"

const request: AskUserRequest = {
  question: "Pick one",
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
  multiSelect: false,
  allowText: false,
}

const multiRequest: AskUserRequest = { ...request, multiSelect: true }

function meta(partial: Partial<PendingAskUserMeta> = {}): PendingAskUserMeta {
  return {
    surfaceId: "ask_user:sess-1:use-1",
    request,
    adapterId: "adp-1",
    conversationKey: "lark:adp-1:oc_1",
    conversationRef: { platform: "lark", adapterId: "adp-1", channelId: "oc_1" },
    actorScope: { mode: "conversation" },
    ...partial,
  }
}

beforeEach(() => __resetAskUserRegistryForTesting())

describe("ask-user-registry", () => {
  it("resolves a pending prompt with an answer", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    expect(pendingAskUserCount()).toBe(1)
    expect(resolveAskUser("sess-1", "use-1", { selected: ["a"], text: "", cancelled: false })).toBe(
      true
    )
    await expect(p).resolves.toEqual({
      answer: { selected: ["a"], text: "", cancelled: false },
      reason: "answered",
    })
    expect(pendingAskUserCount()).toBe(0)
  })

  it("returns false when resolving an unknown or already-settled prompt", async () => {
    expect(resolveAskUser("s", "t", { selected: [], text: "", cancelled: false })).toBe(false)
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    resolveAskUser("sess-1", "use-1", { selected: ["a"], text: "", cancelled: false })
    await p
    expect(resolveAskUser("sess-1", "use-1", { selected: ["b"], text: "", cancelled: false })).toBe(
      false
    )
  })

  it("carries the settling message id through to the settlement", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta() })
    resolveAskUser(
      "sess-1",
      "use-1",
      { selected: ["a"], text: "", cancelled: false },
      "answered",
      "om_card_1"
    )
    const settled = await p
    expect(settled.messageId).toBe("om_card_1")
  })

  it("expires a stale prompt on TTL", async () => {
    jest.useFakeTimers()
    try {
      const p = awaitAskUser("sess-1", "use-1", { ttlMs: 5000, meta: meta() })
      jest.advanceTimersByTime(5001)
      await expect(p).resolves.toEqual({
        answer: { selected: [], text: "", cancelled: true },
        reason: "expired",
      })
      expect(pendingAskUserCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it("falls back to the default TTL when a non-positive ttl is passed", async () => {
    jest.useFakeTimers()
    try {
      const p = awaitAskUser("sess-1", "use-1", { ttlMs: 0, meta: meta() })
      jest.advanceTimersByTime(DEFAULT_ASK_USER_TTL_MS + 1)
      await expect(p).resolves.toMatchObject({ reason: "expired" })
    } finally {
      jest.useRealTimers()
    }
  })

  it("aborts with the owning run's signal", async () => {
    const controller = new AbortController()
    const p = awaitAskUser("sess-1", "use-1", { signal: controller.signal, meta: meta() })
    controller.abort()
    await expect(p).resolves.toEqual({
      answer: { selected: [], text: "", cancelled: true },
      reason: "aborted",
    })
    expect(pendingAskUserCount()).toBe(0)
  })

  it("returns immediately cancelled when the signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      awaitAskUser("sess-1", "use-1", { signal: controller.signal, meta: meta() })
    ).resolves.toMatchObject({ reason: "aborted" })
    expect(pendingAskUserCount()).toBe(0)
  })

  it("a duplicate toolUseId supersedes the earlier pending entry", async () => {
    const first = awaitAskUser("sess-1", "use-1", { meta: meta() })
    const second = awaitAskUser("sess-1", "use-1", { meta: meta() })
    await expect(first).resolves.toMatchObject({ reason: "cancelled" })
    resolveAskUser("sess-1", "use-1", { selected: ["b"], text: "", cancelled: false })
    await expect(second).resolves.toMatchObject({
      reason: "answered",
      answer: { selected: ["b"], text: "", cancelled: false },
    })
  })

  it("toggles values for multi-select and replaces for single-select", async () => {
    const p1 = awaitAskUser("sess-1", "use-1", { meta: meta({ request: multiRequest }) })
    expect(toggleAskUserValue("sess-1", "use-1", "a")).toEqual(["a"])
    expect(toggleAskUserValue("sess-1", "use-1", "b")).toEqual(["a", "b"])
    expect(toggleAskUserValue("sess-1", "use-1", "a")).toEqual(["b"])
    resolveAskUser("sess-1", "use-1", { selected: ["b"], text: "", cancelled: false })
    await p1

    const p2 = awaitAskUser("sess-1", "use-2", { meta: meta({ surfaceId: "s2" }) })
    expect(toggleAskUserValue("sess-1", "use-2", "a")).toEqual(["a"])
    expect(toggleAskUserValue("sess-1", "use-2", "b")).toEqual(["b"])
    resolveAskUser("sess-1", "use-2", { selected: ["b"], text: "", cancelled: false })
    await p2

    expect(toggleAskUserValue("sess-1", "gone", "x")).toBeUndefined()
  })

  it("looks up pending entries by surface id", async () => {
    const p = awaitAskUser("sess-1", "use-1", { meta: meta({ surfaceId: "ask_user:s:t" }) })
    expect(getPendingAskUserBySurface("ask_user:s:t")?.toolUseId).toBe("use-1")
    expect(getPendingAskUserBySurface("nope")).toBeUndefined()
    resolveAskUser("sess-1", "use-1", { selected: [], text: "", cancelled: true }, "cancelled")
    await p
    expect(getPendingAskUserBySurface("ask_user:s:t")).toBeUndefined()
  })

  it("exposes pending entries for the dispatcher", async () => {
    const m = meta({ jobId: "job_1" })
    const p = awaitAskUser("sess-1", "use-1", { meta: m })
    const entry = getPendingAskUser("sess-1", "use-1")
    expect(entry?.meta.jobId).toBe("job_1")
    expect(entry?.selected).toEqual([])
    resolveAskUser("sess-1", "use-1", { selected: [], text: "", cancelled: true }, "cancelled")
    await p
    expect(getPendingAskUser("sess-1", "use-1")).toBeUndefined()
  })
})
