jest.mock("@/lib/files/workspace-fs", () => ({
  statWorkspaceFile: jest.fn(),
  readWorkspaceFile: jest.fn(),
}))
jest.mock("@/lib/files/workspace-backend", () => ({
  hasWorkspaceFsBackend: jest.fn(() => true),
}))

import { hasWorkspaceFsBackend } from "@/lib/files/workspace-backend"
import { readWorkspaceFile, statWorkspaceFile } from "@/lib/files/workspace-fs"
import { MAX_VIEWER_BYTES } from "@/lib/file-viewer/probe"
import { classifyWorkspaceReadError, loadWorkspaceText } from "./load-workspace-text"

const statMock = statWorkspaceFile as jest.Mock
const readMock = readWorkspaceFile as jest.Mock
const backendMock = hasWorkspaceFsBackend as jest.Mock

const fileStat = (size: number) => ({ exists: true, isDir: false, size })

beforeEach(() => {
  statMock.mockReset()
  readMock.mockReset()
  backendMock.mockReset().mockReturnValue(true)
})

describe("loadWorkspaceText", () => {
  it("stats then reads through the Host transport, bounded one byte past the cap", async () => {
    statMock.mockResolvedValue(fileStat(12))
    readMock.mockResolvedValue("export {}\n")

    await expect(loadWorkspaceText("/host/ws", "src/a.ts")).resolves.toEqual({
      ok: true,
      text: "export {}\n",
    })
    expect(statMock).toHaveBeenCalledWith("/host/ws", "src/a.ts")
    expect(readMock).toHaveBeenCalledWith("/host/ws", "src/a.ts", MAX_VIEWER_BYTES + 1)
  })

  it("refuses without a root or a backend, before touching the transport", async () => {
    await expect(loadWorkspaceText(null, "a.ts")).resolves.toEqual({ ok: false, code: "no-root" })
    backendMock.mockReturnValue(false)
    await expect(loadWorkspaceText("/ws", "a.ts")).resolves.toEqual({
      ok: false,
      code: "no-backend",
    })
    expect(statMock).not.toHaveBeenCalled()
  })

  it("classifies missing, directory and oversized targets without reading them", async () => {
    statMock.mockResolvedValueOnce({ exists: false, isDir: false, size: 0 })
    await expect(loadWorkspaceText("/ws", "gone.ts")).resolves.toEqual({
      ok: false,
      code: "not-found",
    })
    statMock.mockResolvedValueOnce({ exists: true, isDir: true, size: 0 })
    await expect(loadWorkspaceText("/ws", "src")).resolves.toEqual({
      ok: false,
      code: "is-directory",
    })
    statMock.mockResolvedValueOnce(fileStat(MAX_VIEWER_BYTES + 1))
    await expect(loadWorkspaceText("/ws", "big.log")).resolves.toEqual({
      ok: false,
      code: "too-large",
    })
    expect(readMock).not.toHaveBeenCalled()
  })

  it("treats a file that grew past the cap between stat and read as too large", async () => {
    statMock.mockResolvedValue(fileStat(10))
    readMock.mockResolvedValue("x".repeat(MAX_VIEWER_BYTES + 1))
    await expect(loadWorkspaceText("/ws", "grow.txt")).resolves.toEqual({
      ok: false,
      code: "too-large",
    })
  })

  it("maps transport rejections onto read-failed or outside-workspace", async () => {
    statMock.mockRejectedValueOnce(new Error("companion offline"))
    await expect(loadWorkspaceText("/ws", "a.ts")).resolves.toEqual({
      ok: false,
      code: "read-failed",
    })
    statMock.mockResolvedValueOnce(fileStat(1))
    readMock.mockRejectedValueOnce(new Error("path escapes workspace root"))
    await expect(loadWorkspaceText("/ws", "../x")).resolves.toEqual({
      ok: false,
      code: "outside-workspace",
    })
  })
})

describe("classifyWorkspaceReadError", () => {
  it("accepts non-Error rejections", () => {
    expect(classifyWorkspaceReadError("escapes workspace")).toBe("outside-workspace")
    expect(classifyWorkspaceReadError(42)).toBe("read-failed")
  })
})
