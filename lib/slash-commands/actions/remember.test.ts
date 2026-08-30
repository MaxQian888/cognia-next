import type { SlashContext } from "../builtin"

const mockGetSettings = jest.fn()
const mockGetSession = jest.fn()
const mockResolveCharacter = jest.fn()
const mockStore = jest.fn()
const mockAudit = jest.fn()

// Mocked at the `storeMemoryCore` boundary rather than at `rememberFact`, so
// this suite still exercises the real adapter AND the real scope resolver.
jest.mock("@/lib/db/settings", () => ({ getSettings: (...a: unknown[]) => mockGetSettings(...a) }))
jest.mock("@/lib/db/sessions", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }))
jest.mock("@/lib/db/characters", () => ({
  resolveCharacterById: (...a: unknown[]) => mockResolveCharacter(...a),
}))
jest.mock("@/lib/db/project-scope", () => ({
  resolveSessionProjectId: jest.fn(async () => "proj_session"),
  resolveScopeProjectId: jest.fn(async () => "proj_active"),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  appendMemoryAuditEvent: (...a: unknown[]) => mockAudit(...a),
}))
jest.mock("@/lib/memory/api/store-memory", () => ({
  storeMemoryCore: (...a: unknown[]) => mockStore(...a),
}))

import { dispatchRememberCommand } from "./remember"

function ctx(over: Partial<SlashContext> = {}): SlashContext {
  return {
    args: "",
    activeSessionId: "ses_1",
    chatStatus: "idle" as never,
    currentPermissionMode: null,
    startNewSession: jest.fn(),
    openSettings: jest.fn(),
    setPermissionMode: jest.fn(),
    pushSystemMessage: jest.fn(),
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockResolvedValue({ memory: { enabled: true } })
  mockGetSession.mockResolvedValue({ id: "ses_1", characterId: "char_1" })
  mockResolveCharacter.mockResolvedValue({ id: "char_1" })
  mockStore.mockResolvedValue({ ok: true, stored: true, consolidated: true, applied: ["ADD"] })
  mockAudit.mockResolvedValue(undefined)
})

describe("dispatchRememberCommand", () => {
  it("shows usage when no text is given", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "  " }))
    expect(res?.system).toMatch(/Usage/)
    expect(mockStore).not.toHaveBeenCalled()
  })

  it("refuses when memory is disabled", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: false } })
    const res = await dispatchRememberCommand(ctx({ args: "I use pnpm" }))
    expect(res?.system).toMatch(/turned off/)
    expect(res?.openMemory).toBe(true)
  })

  it("refuses in temporary mode", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, temporary: true } })
    const res = await dispatchRememberCommand(ctx({ args: "I use pnpm" }))
    expect(res?.system).toMatch(/Temporary mode/)
    expect(mockStore).not.toHaveBeenCalled()
  })

  it("surfaces the core's PII refusal", async () => {
    mockStore.mockResolvedValue({ ok: false, reason: "pii_blocked" })
    const res = await dispatchRememberCommand(ctx({ args: "email me at bob@example.com" }))
    expect(res?.system).toMatch(/sensitive data/)
  })

  it("stores an explicit semantic memory and confirms", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "I always use pnpm" }))
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "I always use pnpm",
        type: "semantic",
        importance: 7,
        provenance: "explicit",
        scope: "global",
      })
    )
    // A successful capture is a one-line confirmation, so it returns the chip
    // block INSTEAD of a system message. Returning both would post two.
    expect(res?.system).toBeUndefined()
    expect(res?.block).toMatchObject({
      kind: "slash-result",
      commandId: "remember",
      args: "I always use pnpm",
    })
    expect(res?.block?.summary).toContain("global")
  })

  it("passes characterId only for character scope", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, scopeDefault: "character" } })
    await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "character", characterId: "char_1" })
    )
  })

  // The regression this rewrite exists for: a workspace default used to persist
  // a row with no projectId, which no reader can ever match.
  it("carries a projectId when the configured default is workspace", async () => {
    mockGetSettings.mockResolvedValue({ memory: { enabled: true, scopeDefault: "workspace" } })
    const res = await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(mockStore).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "workspace", projectId: "proj_session" })
    )
    expect(res?.block?.summary).toContain("workspace")
  })

  it("reports a policy refusal instead of claiming success", async () => {
    mockStore.mockResolvedValue({ ok: false, reason: "policy_denied" })
    const res = await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(res?.system).toMatch(/isn't allowed/)
    expect(res?.openMemory).toBe(true)
  })

  it("works without an active session (global capture)", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "fact", activeSessionId: null }))
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockStore).toHaveBeenCalled()
    expect(res?.block).toMatchObject({ kind: "slash-result", commandId: "remember" })
  })

  it("swallows store errors", async () => {
    mockStore.mockRejectedValueOnce(new Error("db down"))
    const res = await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(res?.system).toMatch(/went wrong/)
  })
})
