import { invoke } from "@tauri-apps/api/core"

jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { appendMemory } from "./memory"

const mockedInvoke = invoke as unknown as jest.Mock
const mockedIsTauri = isTauri as unknown as jest.Mock

beforeEach(() => {
  mockedInvoke.mockReset()
  mockedIsTauri.mockReset()
})

describe("appendMemory", () => {
  it("invokes the memory_append command and returns the path", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValue("/path/CLAUDE.md")
    const out = await appendMemory("project", "remember this", "/cwd")
    expect(out).toBe("/path/CLAUDE.md")
    expect(mockedInvoke).toHaveBeenCalledWith("memory_append", {
      scope: "project",
      content: "remember this",
      cwd: "/cwd",
      allowedRoots: null,
    })
  })

  it("normalises null/undefined cwd to null", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValue("/p")
    await appendMemory("user", "x", null)
    expect(mockedInvoke).toHaveBeenLastCalledWith("memory_append", {
      scope: "user",
      content: "x",
      cwd: null,
      allowedRoots: null,
    })
    await appendMemory("user", "x", undefined)
    expect(mockedInvoke).toHaveBeenLastCalledWith("memory_append", {
      scope: "user",
      content: "x",
      cwd: null,
      allowedRoots: null,
    })
  })

  it("forwards the active workspace roots when supplied (project confinement)", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedInvoke.mockResolvedValue("/p/CLAUDE.md")
    await appendMemory("project", "note", "/ws/app", ["/ws/app", "/ws/lib"])
    expect(mockedInvoke).toHaveBeenLastCalledWith("memory_append", {
      scope: "project",
      content: "note",
      cwd: "/ws/app",
      allowedRoots: ["/ws/app", "/ws/lib"],
    })
  })

  it("throws when not running in Tauri", async () => {
    mockedIsTauri.mockReturnValue(false)
    await expect(appendMemory("user", "x", null)).rejects.toThrow(/desktop/i)
    expect(mockedInvoke).not.toHaveBeenCalled()
  })
})
