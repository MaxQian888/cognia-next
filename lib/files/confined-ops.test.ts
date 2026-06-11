jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/claude/ipc", () => ({
  writeTextFileConfined: jest.fn(),
  ensureDirConfined: jest.fn(),
}))

import { isTauri } from "@/lib/tauri"
import { writeTextFileConfined, ensureDirConfined } from "@/lib/claude/ipc"
import { confinedOps } from "./confined-ops"

const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedWrite = writeTextFileConfined as unknown as jest.Mock
const mockedMkdir = ensureDirConfined as unknown as jest.Mock

beforeEach(() => {
  mockedIsTauri.mockReset()
  mockedWrite.mockReset()
  mockedMkdir.mockReset()
})

describe("confinedOps (desktop)", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(true))

  it("writeText forwards path/content/roots to the confined command", async () => {
    mockedWrite.mockResolvedValue(undefined)
    await confinedOps.writeText("/w/a.txt", "data", ["/w"])
    expect(mockedWrite).toHaveBeenCalledWith("/w/a.txt", "data", ["/w"])
  })

  it("mkdir forwards path/roots to the confined command", async () => {
    mockedMkdir.mockResolvedValue(undefined)
    await confinedOps.mkdir("/w/sub", ["/w"])
    expect(mockedMkdir).toHaveBeenCalledWith("/w/sub", ["/w"])
  })
})

describe("confinedOps (web mode rejects)", () => {
  beforeEach(() => mockedIsTauri.mockReturnValue(false))

  it("writeText throws and never calls the command", async () => {
    await expect(confinedOps.writeText("/w/a", "x", ["/w"])).rejects.toThrow(/desktop app/i)
    expect(mockedWrite).not.toHaveBeenCalled()
  })

  it("mkdir throws and never calls the command", async () => {
    await expect(confinedOps.mkdir("/w/a", ["/w"])).rejects.toThrow(/desktop app/i)
    expect(mockedMkdir).not.toHaveBeenCalled()
  })
})
