jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

import { invoke } from "@tauri-apps/api/core"

import { isTauri } from "@/lib/tauri"

import { beginCodeAdoptionTurn, endCodeAdoptionTurn } from "./client"
import type { CodeAdoptionTurnRow } from "./types"

const mockInvoke = invoke as jest.Mock
const mockIsTauri = isTauri as jest.Mock

const META = { sessionId: "s1", runId: 7, model: "m", agentKind: "in-app" }

beforeEach(() => jest.clearAllMocks())

describe("beginCodeAdoptionTurn", () => {
  it("no-ops off Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    await beginCodeAdoptionTurn("/repo", META)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("no-ops when there is no cwd", async () => {
    mockIsTauri.mockReturnValue(true)
    await beginCodeAdoptionTurn(undefined, META)
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("invokes with camelCase args wrapped in { args }", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue({ status: "started" })
    await beginCodeAdoptionTurn("/repo", META)
    expect(mockInvoke).toHaveBeenCalledWith("code_adoption_turn_begin", {
      args: { cwd: "/repo", sessionId: "s1", runId: 7, model: "m", agentKind: "in-app" },
    })
  })

  it("swallows invoke errors", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockRejectedValue(new Error("boom"))
    await expect(beginCodeAdoptionTurn("/repo", META)).resolves.toBeUndefined()
  })
})

describe("endCodeAdoptionTurn", () => {
  it("returns null off Tauri without invoking", async () => {
    mockIsTauri.mockReturnValue(false)
    expect(await endCodeAdoptionTurn("s1:7")).toBeNull()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it("returns the row and passes turnKey", async () => {
    mockIsTauri.mockReturnValue(true)
    const row = { id: "s1:7" } as CodeAdoptionTurnRow
    mockInvoke.mockResolvedValue(row)
    expect(await endCodeAdoptionTurn("s1:7")).toBe(row)
    expect(mockInvoke).toHaveBeenCalledWith("code_adoption_turn_end", { turnKey: "s1:7" })
  })

  it("returns null when invoke yields null", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue(null)
    expect(await endCodeAdoptionTurn("s1:7")).toBeNull()
  })

  it("returns null on error", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockRejectedValue(new Error("x"))
    expect(await endCodeAdoptionTurn("s1:7")).toBeNull()
  })
})
