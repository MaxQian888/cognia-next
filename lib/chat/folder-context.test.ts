jest.mock("@/lib/files/file-bridge", () => ({ pickDirectory: jest.fn() }))
jest.mock("@/lib/files/workspace-search", () => ({ searchWorkspace: jest.fn() }))

import { pickDirectory } from "@/lib/files/file-bridge"
import { searchWorkspace } from "@/lib/files/workspace-search"
import {
  folderBasename,
  pickFolder,
  summarizeFolder,
  folderReference,
  FOLDER_CONFIRM_FILE_THRESHOLD,
} from "./folder-context"
import type { WorkspaceEntry } from "@/lib/files/types"

const pickMock = pickDirectory as jest.Mock
const searchMock = searchWorkspace as jest.Mock

function entry(relPath: string, isDir = false): WorkspaceEntry {
  return { relPath, absolutePath: `/repo/${relPath}`, isDir, size: 0 }
}

beforeEach(() => {
  pickMock.mockReset()
  searchMock.mockReset()
})

describe("folderBasename", () => {
  it("returns the last segment for posix, windows, and trailing slashes", () => {
    expect(folderBasename("/repo/src")).toBe("src")
    expect(folderBasename("/repo/src/")).toBe("src")
    expect(folderBasename("C:\\work\\pkg\\")).toBe("pkg")
    expect(folderBasename("solo")).toBe("solo")
  })
})

describe("summarizeFolder", () => {
  it("counts files (excluding directories) and flags neither when small", async () => {
    searchMock.mockResolvedValue([entry("a.ts"), entry("b.ts"), entry("sub", true)])
    const s = await summarizeFolder("/repo/pkg", 200)
    expect(s).toMatchObject({
      absolute: "/repo/pkg",
      relative: "pkg",
      fileCount: 2,
      truncated: false,
      needsConfirm: false,
    })
    expect(searchMock).toHaveBeenCalledWith("/repo/pkg", "", 200)
  })

  it("flags needsConfirm when the file count reaches the threshold", async () => {
    searchMock.mockResolvedValue(
      Array.from({ length: FOLDER_CONFIRM_FILE_THRESHOLD }, (_, i) => entry(`f${i}.ts`))
    )
    const s = await summarizeFolder("/repo/big", 200)
    expect(s.needsConfirm).toBe(true)
    expect(s.truncated).toBe(false)
  })

  it("flags truncated + needsConfirm when the walk hits the limit", async () => {
    searchMock.mockResolvedValue(Array.from({ length: 5 }, (_, i) => entry(`f${i}.ts`)))
    const s = await summarizeFolder("/repo/capped", 5)
    expect(s.truncated).toBe(true)
    expect(s.needsConfirm).toBe(true)
  })
})

describe("folderReference / pickFolder", () => {
  it("projects a summary into a directory reference", () => {
    const ref = folderReference({
      absolute: "/repo/pkg",
      relative: "pkg",
      fileCount: 3,
      truncated: false,
      needsConfirm: false,
    })
    expect(ref).toEqual({ absolute: "/repo/pkg", relative: "pkg", isDir: true })
  })

  it("delegates folder picking to the platform dialog", async () => {
    pickMock.mockResolvedValue("/repo/picked")
    await expect(pickFolder()).resolves.toBe("/repo/picked")
    pickMock.mockResolvedValue(null)
    await expect(pickFolder()).resolves.toBeNull()
  })
})
