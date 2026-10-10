jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/files/workspace-fs", () => ({ readWorkspaceFile: jest.fn() }))

import { readProjectLspFile, PROJECT_LSP_CONFIG_RELPATH } from "./project-file-reader"
import { isTauri } from "@/lib/tauri"
import { readWorkspaceFile } from "@/lib/files/workspace-fs"

const mockIsTauri = isTauri as jest.Mock
const mockRead = readWorkspaceFile as jest.Mock

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

  it("reads .cognia/lsp.json confined to the root, not by absolute path", async () => {
    mockRead.mockResolvedValue(JSON.stringify({ servers: [] }))
    await readProjectLspFile("/proj")
    expect(mockRead).toHaveBeenCalledWith("/proj", PROJECT_LSP_CONFIG_RELPATH)
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

  it("passes a Windows-style root through unchanged", async () => {
    mockRead.mockResolvedValue(JSON.stringify({ servers: [] }))
    await readProjectLspFile("C:\\code\\proj")
    expect(mockRead).toHaveBeenCalledWith("C:\\code\\proj", ".cognia/lsp.json")
  })

  it("uses an injected reader outside Tauri", async () => {
    mockIsTauri.mockReturnValue(false)
    const read = jest.fn(async () => JSON.stringify({ servers: [] }))
    expect(await readProjectLspFile("/proj", read)).toEqual({ servers: [] })
    expect(read).toHaveBeenCalledWith("/proj", PROJECT_LSP_CONFIG_RELPATH)
    expect(mockRead).not.toHaveBeenCalled()
  })
})
