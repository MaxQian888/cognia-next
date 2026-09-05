jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/claude/ipc", () => ({ readTextFile: jest.fn() }))

import { readProjectLspFile, PROJECT_LSP_CONFIG_RELPATH } from "./project-file-reader"
import { isTauri } from "@/lib/tauri"
import { readTextFile } from "@/lib/claude/ipc"

const mockIsTauri = isTauri as jest.Mock
const mockRead = readTextFile as jest.Mock

describe("readProjectLspFile", () => {
  beforeEach(() => {
    mockIsTauri.mockReset().mockReturnValue(true)
    mockRead.mockReset()
  })

  it("returns null and skips the read when not running under Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    expect(await readProjectLspFile("/proj")).toBeNull()
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("reads the file under .cognia/lsp.json", async () => {
    mockRead.mockResolvedValue(JSON.stringify({ servers: [] }))
    await readProjectLspFile("/proj")
    expect(mockRead).toHaveBeenCalledWith(
      expect.stringContaining(PROJECT_LSP_CONFIG_RELPATH.split("/")[1])
    )
    expect(mockRead.mock.calls[0][0]).toContain("/proj")
  })

  it("parses a valid object file", async () => {
    mockRead.mockResolvedValue(
      JSON.stringify({ servers: [{ id: "x", name: "x", languages: ["x"], command: "x" }] })
    )
    const out = await readProjectLspFile("/proj")
    expect(out?.servers?.[0].id).toBe("x")
  })

  it("returns null when the read fails (missing file)", async () => {
    mockRead.mockRejectedValue(new Error("ENOENT"))
    expect(await readProjectLspFile("/proj")).toBeNull()
  })

  it("returns null for malformed JSON", async () => {
    mockRead.mockResolvedValue("{ not json")
    expect(await readProjectLspFile("/proj")).toBeNull()
  })

  it("returns null when the JSON root is an array", async () => {
    mockRead.mockResolvedValue(JSON.stringify([1, 2, 3]))
    expect(await readProjectLspFile("/proj")).toBeNull()
  })

  it("handles a Windows-style root path", async () => {
    mockRead.mockResolvedValue(JSON.stringify({ servers: [] }))
    await readProjectLspFile("C:\\code\\proj")
    expect(mockRead.mock.calls[0][0]).toBe("C:\\code\\proj\\.cognia\\lsp.json")
  })
})

it("reads a Node-host project through an injected reader without Tauri", async () => {
  mockRead.mockReset()
  mockIsTauri.mockReturnValue(false)
  const read = jest.fn().mockResolvedValue('{"servers":[]}')
  expect(await readProjectLspFile("/proj", read)).toEqual({ servers: [] })
  expect(read).toHaveBeenCalledWith("/proj/.cognia/lsp.json")
  expect(mockRead).not.toHaveBeenCalled()
})
