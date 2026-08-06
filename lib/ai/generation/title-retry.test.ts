import {
  markTitleFailed,
  clearTitleRetry,
  retryTitleIfNeeded,
  _getRetryState,
  _resetAllRetries,
  MAX_RETRIES,
} from "./title-retry"
import { runTitleTask, isTitleInFlight } from "./run-title-task"
import { getSession } from "@/lib/db/sessions"

jest.mock("./run-title-task", () => ({
  ...jest.requireActual("./run-title-task"),
  runTitleTask: jest.fn(),
  isTitleInFlight: jest.fn(() => false),
}))

jest.mock("@/lib/db/sessions", () => ({
  getSession: jest.fn(),
  updateSession: jest.fn(),
}))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({
      settings: { conversationTitle: { enabled: true }, language: "en" },
    })),
  },
}))

const mockRunTitleTask = runTitleTask as jest.MockedFunction<typeof runTitleTask>
const mockIsTitleInFlight = isTitleInFlight as jest.MockedFunction<typeof isTitleInFlight>
const mockGetSession = getSession as jest.MockedFunction<typeof getSession>

beforeEach(() => {
  _resetAllRetries()
  jest.clearAllMocks()
  mockIsTitleInFlight.mockReturnValue(false)
})

describe("markTitleFailed", () => {
  it("stores an entry with attempts=0 on first failure", () => {
    markTitleFailed("s1", { sourceText: "hello", locale: "en" })
    const state = _getRetryState("s1")
    expect(state).not.toBeNull()
    expect(state!.attempts).toBe(0)
    expect(state!.sourceText).toBe("hello")
    expect(state!.locale).toBe("en")
  })

  it("increments attempts on subsequent failures", () => {
    markTitleFailed("s1", { sourceText: "hello" })
    markTitleFailed("s1", { sourceText: "hello" })
    const state = _getRetryState("s1")
    expect(state!.attempts).toBe(1)
  })
})

describe("clearTitleRetry", () => {
  it("removes the entry", () => {
    markTitleFailed("s1", { sourceText: "hello" })
    clearTitleRetry("s1")
    expect(_getRetryState("s1")).toBeNull()
  })

  it("is a no-op for non-existent entries", () => {
    expect(() => clearTitleRetry("nonexistent")).not.toThrow()
  })
})

describe("retryTitleIfNeeded", () => {
  it("does nothing when no entry exists", async () => {
    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
  })

  it("does nothing when max retries exceeded", async () => {
    markTitleFailed("s1", { sourceText: "hello" })
    // Manually set attempts to MAX_RETRIES.
    const state = _getRetryState("s1")!
    state.attempts = MAX_RETRIES
    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
    // Entry should be cleaned up.
    expect(_getRetryState("s1")).toBeNull()
  })

  it("does nothing when backoff delay not elapsed", async () => {
    markTitleFailed("s1", { sourceText: "hello" })
    // lastAttemptAt was just set to Date.now(), delay hasn't elapsed.
    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
  })

  it("calls runTitleTask when eligible and clears on success", async () => {
    markTitleFailed("s1", { sourceText: "hello world this is a long message for testing" })
    // Set lastAttemptAt far in the past to bypass backoff.
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockGetSession.mockResolvedValue({
      id: "s1",
      title: "hello world this is a long message fo…",
      titleAuto: true,
      createdAt: 1000,
      updatedAt: 2000,
    } as never)
    mockRunTitleTask.mockResolvedValue("Generated Title")

    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).toHaveBeenCalled()
    expect(_getRetryState("s1")).toBeNull() // cleared on success
  })

  it("increments attempts on failure", async () => {
    markTitleFailed("s1", { sourceText: "hello world this is a test message" })
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockGetSession.mockResolvedValue({
      id: "s1",
      title: "hello world this is a test message…",
      titleAuto: true,
      createdAt: 1000,
      updatedAt: 2000,
    } as never)
    mockRunTitleTask.mockResolvedValue(null) // failure

    await retryTitleIfNeeded("s1")
    const updated = _getRetryState("s1")
    expect(updated!.attempts).toBe(1)
  })

  it("aborts when titleAuto is false (user renamed)", async () => {
    markTitleFailed("s1", { sourceText: "hello" })
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockGetSession.mockResolvedValue({
      id: "s1",
      title: "My Custom Title",
      titleAuto: false,
      createdAt: 1000,
      updatedAt: 2000,
    } as never)

    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
    expect(_getRetryState("s1")).toBeNull() // cleaned up
  })

  it("aborts when title no longer looks like placeholder/instant-preview", async () => {
    markTitleFailed("s1", { sourceText: "hello world how are you doing today" })
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockGetSession.mockResolvedValue({
      id: "s1",
      title: "Something Completely Different",
      titleAuto: true,
      createdAt: 1000,
      updatedAt: 2000,
    } as never)

    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
    expect(_getRetryState("s1")).toBeNull()
  })

  it("aborts when another generation is in flight", async () => {
    markTitleFailed("s1", { sourceText: "hello world this is a test message" })
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockIsTitleInFlight.mockReturnValue(true)
    mockGetSession.mockResolvedValue({
      id: "s1",
      title: "hello world this is a test message…",
      titleAuto: true,
      createdAt: 1000,
      updatedAt: 2000,
    } as never)

    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
  })

  it("aborts when session not found", async () => {
    markTitleFailed("s1", { sourceText: "hello" })
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockGetSession.mockResolvedValue(undefined)

    await retryTitleIfNeeded("s1")
    expect(mockRunTitleTask).not.toHaveBeenCalled()
    expect(_getRetryState("s1")).toBeNull()
  })

  it("never throws even if internals throw", async () => {
    markTitleFailed("s1", { sourceText: "hello" })
    const state = _getRetryState("s1")!
    state.lastAttemptAt = 0

    mockGetSession.mockRejectedValue(new Error("DB exploded"))

    await expect(retryTitleIfNeeded("s1")).resolves.toBeUndefined()
  })
})

describe("memory management", () => {
  it("evicts the oldest entry when over capacity", () => {
    // Fill to capacity + 1.
    for (let i = 0; i <= 50; i++) {
      markTitleFailed(`session-${i}`, { sourceText: `text-${i}` })
      // Stagger lastAttemptAt so eviction is deterministic.
      const state = _getRetryState(`session-${i}`)!
      state.lastAttemptAt = i * 1000
    }
    // The first entry (oldest by lastAttemptAt) should be evicted.
    expect(_getRetryState("session-0")).toBeNull()
    // Later entries should survive.
    expect(_getRetryState("session-50")).not.toBeNull()
  })
})
