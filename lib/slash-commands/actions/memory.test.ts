import type { SlashContext } from "../builtin"

const mockGetSettings = jest.fn()
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockGetSettings() }) },
}))

const mockCountActive = jest.fn()
const mockListMemories = jest.fn()
jest.mock("@/lib/db/memories", () => ({
  countActive: (...a: unknown[]) => mockCountActive(...(a as [])),
  listMemories: (...a: unknown[]) => mockListMemories(...(a as [])),
}))

const mockForget = jest.fn()
jest.mock("@/lib/memory/api/mutate-memory", () => ({
  forgetExternalMemory: (...a: unknown[]) => mockForget(...(a as [])),
}))

import { dispatchMemorySubcommand } from "./memory"

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
  } as SlashContext
}

beforeEach(() => {
  jest.clearAllMocks()
  mockGetSettings.mockReturnValue({ memory: { enabled: true } })
  mockCountActive.mockResolvedValue(3)
  mockListMemories.mockResolvedValue([
    { id: "m1", text: "Uses pnpm", type: "semantic", pinned: false },
    { id: "m2", text: "Ships on Fridays", type: "episodic", pinned: true },
  ])
  mockForget.mockResolvedValue({ ok: true })
})

describe("dispatchMemorySubcommand", () => {
  it("bare /memory opens the memory panel", async () => {
    const res = await dispatchMemorySubcommand(ctx({ args: "  " }))
    expect(res).toEqual({ openMemory: true })
  })

  it("status renders counts and flags temporary mode", async () => {
    const res = await dispatchMemorySubcommand(ctx({ args: "status" }))
    expect(res?.system).toMatch(/3 global, 3 character-scoped/)
    mockGetSettings.mockReturnValue({ memory: { enabled: true, temporary: true } })
    const paused = await dispatchMemorySubcommand(ctx({ args: "status" }))
    expect(paused?.system).toMatch(/temporary mode — paused/)
  })

  it("status / list point to settings when memory is off", async () => {
    mockGetSettings.mockReturnValue({ memory: { enabled: false } })
    for (const args of ["status", "list"]) {
      const res = await dispatchMemorySubcommand(ctx({ args }))
      expect(res?.system).toMatch(/off/)
      expect(res?.openMemory).toBe(true)
    }
    expect(mockListMemories).not.toHaveBeenCalled()
  })

  it("list renders newest actives with ids, honoring the count arg", async () => {
    const res = await dispatchMemorySubcommand(ctx({ args: "list 1" }))
    expect(mockListMemories).toHaveBeenCalledWith({ status: "active" })
    expect(res?.system).toMatch(/Newest 1 memories/)
    expect(res?.system).toMatch(/`m1`/)
    expect(res?.system).not.toMatch(/m2/)
  })

  it("list explains when there is nothing yet", async () => {
    mockListMemories.mockResolvedValue([])
    const res = await dispatchMemorySubcommand(ctx({ args: "list" }))
    expect(res?.system).toMatch(/\/remember/)
  })

  it("forget requires an id, maps not_found, and confirms success", async () => {
    expect((await dispatchMemorySubcommand(ctx({ args: "forget" })))?.system).toMatch(/Usage/)
    mockForget.mockResolvedValue({ ok: false, reason: "not_found" })
    expect((await dispatchMemorySubcommand(ctx({ args: "forget nope" })))?.system).toMatch(
      /No memory with id/
    )
    mockForget.mockResolvedValue({ ok: true })
    const res = await dispatchMemorySubcommand(ctx({ args: "forget m1" }))
    expect(mockForget).toHaveBeenCalledWith("m1")
    expect(res?.system).toMatch(/archived/)
  })

  it("falls through on unknown subcommands", async () => {
    expect(await dispatchMemorySubcommand(ctx({ args: "frobnicate" }))).toBeNull()
  })
})
