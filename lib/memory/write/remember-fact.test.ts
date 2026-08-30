const mockGetSettings = jest.fn()
const mockGetSession = jest.fn()
const mockResolvePolicy = jest.fn()
const mockResolveTarget = jest.fn()
const mockAuditRefusal = jest.fn()
const mockStore = jest.fn()
const mockResolveCharacter = jest.fn()

jest.mock("@/lib/db/settings", () => ({ getSettings: (...a: unknown[]) => mockGetSettings(...a) }))
jest.mock("@/lib/db/sessions", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }))
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: (...a: unknown[]) => mockResolveCharacter(...a),
}))
jest.mock("@/lib/memory/agent-policy", () => ({
  resolvePersistedAgentMemoryPolicy: (...a: unknown[]) => mockResolvePolicy(...a),
}))
jest.mock("@/lib/memory/scope/resolve-write-target", () => ({
  resolveMemoryWriteTarget: (...a: unknown[]) => mockResolveTarget(...a),
  auditMemoryScopeRefusal: (...a: unknown[]) => mockAuditRefusal(...a),
}))
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeMemoryCore: (...a: unknown[]) => mockStore(...a),
}))

import { rememberFact, EXPLICIT_MEMORY_IMPORTANCE } from "./remember-fact"

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockGetSession.mockResolvedValue({ id: "ses_1", characterId: "char_1" })
  mockResolvePolicy.mockResolvedValue({ canCreate: true, writableScopes: ["global", "workspace"] })
  mockResolveTarget.mockResolvedValue({
    ok: true,
    scope: "global",
    scopeRationale: "global_fallback",
  })
  mockStore.mockResolvedValue({ ok: true, stored: true, consolidated: true, applied: ["ADD"] })
  mockAuditRefusal.mockResolvedValue(undefined)
  mockResolveCharacter.mockResolvedValue({ id: "char_1" })
})

describe("rememberFact", () => {
  it("stores an explicit fact through the canonical core", async () => {
    const res = await rememberFact({ text: "I always use pnpm", sessionId: "ses_1" })
    expect(res).toEqual({ ok: true, scope: "global" })
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I always use pnpm",
        type: "semantic",
        importance: EXPLICIT_MEMORY_IMPORTANCE,
        provenance: "explicit",
        piiGate: "block",
        source: { sessionId: "ses_1" },
        scopeRationale: "global_fallback",
      })
    )
  })

  it("trims the text before storing", async () => {
    await rememberFact({ text: "   spaced   " })
    expect(mockStore).toHaveBeenCalledWith(expect.objectContaining({ text: "spaced" }))
  })

  it("rejects empty text without touching the store", async () => {
    expect(await rememberFact({ text: "   " })).toEqual({ ok: false, reason: "empty" })
    expect(mockStore).not.toHaveBeenCalled()
    expect(mockResolveTarget).not.toHaveBeenCalled()
  })

  // The bug this rewrite exists for: a workspace capture used to persist with
  // `projectId: undefined`, which no reader can ever match.
  it("always forwards a projectId for a workspace target", async () => {
    mockResolveTarget.mockResolvedValue({
      ok: true,
      scope: "workspace",
      projectId: "proj_1",
      scopeRationale: "caller_explicit",
    })
    const res = await rememberFact({ text: "fact", scope: "workspace", sessionId: "ses_1" })
    expect(res).toEqual({ ok: true, scope: "workspace" })
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", projectId: "proj_1" })
    )
  })

  it("passes the explicit pick and the configured default to the resolver", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, scopeDefault: "global" } })
    await rememberFact({ text: "fact", scope: "workspace" })
    expect(mockResolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ requested: "workspace", configured: "global" })
    )
  })

  it("refuses when memory is disabled, before resolving a target", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "disabled" })
    expect(mockResolveTarget).not.toHaveBeenCalled()
  })

  it("refuses while temporary mode is on", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "temporary" })
    expect(mockResolveTarget).not.toHaveBeenCalled()
  })

  it("reports a denied scope and writes one refusal audit row", async () => {
    mockResolveTarget.mockResolvedValue({
      ok: false,
      reason: "scope_denied",
      attempted: ["workspace"],
    })
    expect(await rememberFact({ text: "fact", scope: "workspace", sessionId: "ses_1" })).toEqual({
      ok: false,
      reason: "denied",
    })
    expect(mockAuditRefusal).toHaveBeenCalledWith({
      sessionId: "ses_1",
      attempted: ["workspace"],
      surface: "remember",
    })
    expect(mockStore).not.toHaveBeenCalled()
  })

  it.each([
    ["pii_blocked", "pii"],
    ["policy_denied", "denied"],
    ["scope_denied", "denied"],
    ["disabled", "disabled"],
    ["temporary", "temporary"],
  ])("maps the core's %s result onto %s", async (coreReason, expected) => {
    mockStore.mockResolvedValue({ ok: false, reason: coreReason })
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: expected })
  })

  it("treats a consolidator NOOP as success", async () => {
    mockStore.mockResolvedValue({ ok: true, stored: false, consolidated: true, applied: ["NOOP"] })
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: true, scope: "global" })
  })

  it("never throws, a core failure becomes a typed result", async () => {
    mockStore.mockRejectedValueOnce(new Error("boom"))
    expect(await rememberFact({ text: "fact" })).toEqual({ ok: false, reason: "failed" })
  })

  it("survives a session lookup failure", async () => {
    mockGetSession.mockRejectedValue(new Error("no session"))
    expect((await rememberFact({ text: "fact", sessionId: "ses_missing" })).ok).toBe(true)
  })

  it("resolves the agent namespace from the session's character", async () => {
    mockResolveCharacter.mockResolvedValue({ id: "char_1", twinId: "twin_9" })
    await rememberFact({ text: "fact", sessionId: "ses_1" })
    expect(mockResolveTarget).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "twin:twin_9" })
    )
  })
})
