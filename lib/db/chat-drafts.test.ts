import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "./schema"
import { clearDraft, getDraft, setDraft, setDraftDebounced } from "./chat-drafts"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("chat-drafts", () => {
  it("getDraft returns null when no row exists", async () => {
    expect(await getDraft("ses_missing")).toBeNull()
  })

  it("setDraft writes a row and getDraft retrieves it", async () => {
    await setDraft("ses_a", "hello")
    const row = await getDraft("ses_a")
    expect(row).not.toBeNull()
    expect(row?.text).toBe("hello")
    expect(row?.sessionId).toBe("ses_a")
    expect(typeof row?.updatedAt).toBe("number")
    expect(row!.updatedAt).toBeGreaterThan(0)
  })

  it("setDraft overwrites an existing row (upsert by sessionId)", async () => {
    await setDraft("ses_a", "first")
    await setDraft("ses_a", "second")
    const row = await getDraft("ses_a")
    expect(row?.text).toBe("second")
    const all = await getDb().chatDrafts.toArray()
    expect(all).toHaveLength(1)
  })

  it("setDraft keeps drafts isolated per sessionId", async () => {
    await setDraft("ses_a", "alpha")
    await setDraft("ses_b", "beta")
    expect((await getDraft("ses_a"))?.text).toBe("alpha")
    expect((await getDraft("ses_b"))?.text).toBe("beta")
  })

  it("setDraft with empty string clears the row", async () => {
    await setDraft("ses_a", "hello")
    expect(await getDraft("ses_a")).not.toBeNull()
    await setDraft("ses_a", "")
    expect(await getDraft("ses_a")).toBeNull()
  })

  it("clearDraft removes the row", async () => {
    await setDraft("ses_a", "hello")
    await clearDraft("ses_a")
    expect(await getDraft("ses_a")).toBeNull()
  })

  it("clearDraft is a no-op for missing rows", async () => {
    await expect(clearDraft("ses_missing")).resolves.toBeUndefined()
  })

  it("setDraftDebounced delays the write until flush", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "typing", 500)
      expect(await getDraft("ses_a")).toBeNull()
      jest.advanceTimersByTime(499)
      await Promise.resolve()
      expect(await getDraft("ses_a")).toBeNull()
      jest.advanceTimersByTime(1)
      // flush microtasks queued by the debounced timer callback
      await Promise.resolve()
      await Promise.resolve()
      const row = await getDraft("ses_a")
      expect(row?.text).toBe("typing")
    } finally {
      jest.useRealTimers()
    }
  })

  it("setDraftDebounced coalesces rapid calls into the latest value", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "v1", 500)
      jest.advanceTimersByTime(100)
      setDraftDebounced("ses_a", "v2", 500)
      jest.advanceTimersByTime(100)
      setDraftDebounced("ses_a", "v3", 500)
      jest.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
      const row = await getDraft("ses_a")
      expect(row?.text).toBe("v3")
    } finally {
      jest.useRealTimers()
    }
  })

  it("setDraftDebounced uses a per-session timer (separate sessions don't cross-cancel)", async () => {
    jest.useFakeTimers()
    try {
      setDraftDebounced("ses_a", "alpha", 500)
      setDraftDebounced("ses_b", "beta", 500)
      jest.advanceTimersByTime(500)
      await Promise.resolve()
      await Promise.resolve()
      expect((await getDraft("ses_a"))?.text).toBe("alpha")
      expect((await getDraft("ses_b"))?.text).toBe("beta")
    } finally {
      jest.useRealTimers()
    }
  })
})
