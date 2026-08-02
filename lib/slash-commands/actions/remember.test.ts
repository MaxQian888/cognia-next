import type { SlashContext } from "../builtin"

const mockGetSettings = jest.fn()
const mockGetSession = jest.fn()
const mockBuildDeps = jest.fn()
const mockConsolidate = jest.fn(async () => ({ applied: [] }))

jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockGetSettings() }) },
}))
jest.mock("@/lib/db/sessions", () => ({
  getSession: (...a: unknown[]) => mockGetSession(...a),
}))
jest.mock("@/lib/memory/write/run-memory-extraction", () => ({
  buildAutoExtractionDeps: (...a: unknown[]) => mockBuildDeps(...a),
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
  mockGetSettings.mockReturnValue({ memory: { enabled: true } })
  mockGetSession.mockResolvedValue({ id: "ses_1", characterId: "char_1" })
  mockBuildDeps.mockResolvedValue({ consolidate: mockConsolidate })
})

describe("dispatchRememberCommand", () => {
  it("shows usage when no text is given", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "  " }))
    expect(res?.system).toMatch(/Usage/)
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("refuses when memory is disabled", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: false } })
    const res = await dispatchRememberCommand(ctx({ args: "I use pnpm" }))
    expect(res?.system).toMatch(/turned off/)
    expect(res?.openMemory).toBe(true)
  })

  it("refuses in temporary mode", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: true, temporary: true } })
    const res = await dispatchRememberCommand(ctx({ args: "I use pnpm" }))
    expect(res?.system).toMatch(/Temporary mode/)
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("refuses to store PII-leaking text", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "email me at bob@example.com" }))
    expect(res?.system).toMatch(/sensitive data/)
    expect(mockBuildDeps).not.toHaveBeenCalled()
  })

  it("consolidates an explicit semantic memory and confirms", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "I always use pnpm" }))
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({
        candidates: [{ type: "semantic", text: "I always use pnpm", importance: 7 }],
        provenance: "explicit",
        scope: "global",
      })
    )
    // A successful capture is a one-line confirmation, so it returns the chip
    // block INSTEAD of prose — pushing both would post two system messages.
    expect(res?.system).toBeUndefined()
    expect(res?.block).toMatchObject({
      kind: "slash-result",
      commandId: "remember",
      args: "I always use pnpm",
    })
    expect(res?.block?.summary).toContain("global")
  })

  it("passes characterId only for character scope", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: true, scopeDefault: "character" } })
    await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(mockConsolidate).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "character", characterId: "char_1" })
    )
  })

  it("handles a missing deps builder gracefully", async () => {
    mockBuildDeps.mockResolvedValue(null)
    const res = await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(res?.system).toMatch(/Couldn't reach/)
  })

  it("works without an active session (global capture)", async () => {
    const res = await dispatchRememberCommand(ctx({ args: "fact", activeSessionId: null }))
    expect(mockGetSession).not.toHaveBeenCalled()
    expect(mockConsolidate).toHaveBeenCalled()
    expect(res?.block).toMatchObject({ kind: "slash-result", commandId: "remember" })
  })

  it("swallows consolidation errors", async () => {
    mockConsolidate.mockRejectedValueOnce(new Error("db down"))
    const res = await dispatchRememberCommand(ctx({ args: "fact" }))
    expect(res?.system).toMatch(/went wrong/)
  })
})
