const mockGetSettings = jest.fn()
const mockGetSession = jest.fn()
const mockBuildDeps = jest.fn()
const mockConsolidate = jest.fn(async () => ({ applied: [] }))
// Typed at creation: a zero-arg `jest.fn()` called with spread args trips
// TS2556 under strict mode.
const mockHasNoLeakingPii = jest.fn((..._args: unknown[]) => true)

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockGetSettings() }) },
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}))
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  buildAutoExtractionDeps: (...a: unknown[]) => mockBuildDeps(...a),
}))
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (...a: unknown[]) => mockHasNoLeakingPii(...a),
}))

import { rememberFact, EXPLICIT_MEMORY_IMPORTANCE } from "./remember-fact"

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockReturnValue({ memory: { enabled: true } })
  mockGetSession.mockResolvedValue({ id: "ses_1", characterId: "char_1" })
  mockBuildDeps.mockResolvedValue({ consolidate: mockConsolidate })
  mockHasNoLeakingPii.mockReturnValue(true)
})

describe("rememberFact", () => {
  it("stores an explicit fact through the consolidator", async () => {
    const res = await rememberFact({ text: "I always use pnpm", sessionId: "ses_1" })
    expect(res.ok).toBe(true)
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [
          { type: "semantic", text: "I always use pnpm", importance: EXPLICIT_MEMORY_IMPORTANCE },
        ],
        provenance: "explicit",
        source: { sessionId: "ses_1" },
      })
    )
  })

  it("trims the text before storing", async () => {
    await rememberFact({ text: "   spaced   " })
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: [expect.objectContaining({ text: "spaced" })] })
    )
  })

  it("rejects empty text without touching the store", async () => {
    const res = await rememberFact({ text: "   " })
    expect(res).toEqual({ ok: false, reason: "empty" })
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("honours an explicit scope over the configured default", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: true, scopeDefault: "global" } })
    const res = await rememberFact({ text: "fact", scope: "workspace" })
    expect(res).toEqual({ ok: true, scope: "workspace" })
    expect(mockConsolidate).toHaveBeenCalledWith(expect.objectContaining({ scope: "workspace" }))
  })

  it("falls back to the configured default scope", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: true, scopeDefault: "global" } })
    const res = await rememberFact({ text: "fact" })
    expect(res).toEqual({ ok: true, scope: "global" })
  })

  it("passes characterId only for a character-scoped write", async () => {
    await rememberFact({ text: "fact", scope: "global", sessionId: "ses_1" })
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({ characterId: undefined })
    )
  })

  it("refuses when memory is disabled", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: false } })
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "disabled" })
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("refuses while temporary mode is on", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: true, temporary: true } })
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "temporary" })
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  // The PII gate is mandatory on this path — both `/remember` and `#` rely on
  // it being enforced here rather than at each call site.
  it("refuses text that trips the PII gate, before any store call", async () => {
    mockHasNoLeakingPii.mockReturnValue(false)
    expect(await rememberFact({ text: "email me at a@b.com" })).toEqual({
      ok: false,
      reason: "pii",
    })
    expect(mockBuildDeps).not.toHaveBeenCalled()
    expect(mockConsolidate).not.toHaveBeenCalled()
  })

  it("reports unavailable when no memory deps can be built", async () => {
    mockBuildDeps.mockResolvedValue(null)
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "unavailable" })
  })

  it("never throws — a consolidator failure becomes a typed result", async () => {
    mockConsolidate.mockRejectedValueOnce(new Error("boom"))
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "failed" })
  })

  it("survives a session lookup failure", async () => {
    mockGetSession.mockRejectedValue(new Error("no session"))
    const res = await rememberFact({ text: "fact", sessionId: "ses_missing" })
    expect(res.ok).toBe(true)
  })
})
