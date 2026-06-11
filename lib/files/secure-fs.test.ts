jest.mock("@/lib/file/file-operations", () => ({
  readTextFile: jest.fn(),
  writeTextFile: jest.fn(),
  readBinaryFile: jest.fn(),
  writeBinaryFile: jest.fn(),
  removeFile: jest.fn(),
  copyFile: jest.fn(),
  renameFile: jest.fn(),
  statFile: jest.fn(),
  readDir: jest.fn(),
  createDir: jest.fn(),
  exists: jest.fn(),
}))

jest.mock("@/lib/logging", () => ({
  loggers: { files: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } },
}))

import { SecureFileSystem, createSecureFs, FileAccessError } from "./secure-fs"
import { getFileAudit, resetFileAuditForTest } from "./audit"
import { loggers } from "@/lib/logging"
import * as fileOps from "@/lib/file/file-operations"
import type { FileAccessPolicy } from "@/types/files"

const opsMock = fileOps as jest.Mocked<typeof fileOps>
const filesLogger = loggers.files as unknown as {
  info: jest.Mock
  warn: jest.Mock
  error: jest.Mock
  debug: jest.Mock
}

const policy: FileAccessPolicy = { allowedRoots: ["/w"] }

// Fake confined backend so writes/mkdir don't reach the (Tauri-only) real one.
const confinedMock = { writeText: jest.fn(), mkdir: jest.fn() }

beforeEach(() => {
  jest.clearAllMocks()
  confinedMock.writeText.mockResolvedValue(undefined)
  confinedMock.mkdir.mockResolvedValue(undefined)
  resetFileAuditForTest()
})

describe("SecureFileSystem — allowed operations", () => {
  const fs = new SecureFileSystem(policy, { confined: confinedMock })

  it("readText delegates, logs, and audits with byte count", async () => {
    opsMock.readTextFile.mockResolvedValue("hello")
    await expect(fs.readText("/w/a.txt")).resolves.toBe("hello")
    expect(opsMock.readTextFile).toHaveBeenCalledWith("/w/a.txt")
    expect(filesLogger.info).toHaveBeenCalledWith(
      "file op",
      expect.objectContaining({ op: "read", path: "/w/a.txt", bytes: 5 })
    )
    const audit = getFileAudit()
    expect(audit[0]).toMatchObject({ op: "read", path: "/w/a.txt", allowed: true, bytes: 5 })
    expect(typeof audit[0].durationMs).toBe("number")
  })

  it("writeText routes through the confined backend with the policy roots", async () => {
    await fs.writeText("/w/a.txt", "data")
    expect(confinedMock.writeText).toHaveBeenCalledWith("/w/a.txt", "data", ["/w"])
    expect(opsMock.writeTextFile).not.toHaveBeenCalled()
    expect(getFileAudit()[0]).toMatchObject({ op: "write", bytes: 4, allowed: true })
  })

  it("writeBinary records data length", async () => {
    opsMock.writeBinaryFile.mockResolvedValue(undefined)
    await fs.writeBinary("/w/a.bin", new Uint8Array([1, 2, 3]))
    expect(getFileAudit()[0]).toMatchObject({ op: "write", bytes: 3 })
  })

  it("readBinary resolves bytes from the result", async () => {
    opsMock.readBinaryFile.mockResolvedValue(new Uint8Array([1, 2]))
    await fs.readBinary("/w/a.bin")
    expect(getFileAudit()[0]).toMatchObject({ op: "read", bytes: 2 })
  })

  it("copy passes a destination and gates both paths", async () => {
    opsMock.copyFile.mockResolvedValue(undefined)
    await fs.copy("/w/a.txt", "/w/b.txt")
    expect(opsMock.copyFile).toHaveBeenCalledWith("/w/a.txt", "/w/b.txt")
    expect(getFileAudit()[0]).toMatchObject({ op: "copy", path: "/w/a.txt", destPath: "/w/b.txt" })
  })

  it("move delegates to renameFile", async () => {
    opsMock.renameFile.mockResolvedValue(undefined)
    await fs.move("/w/a.txt", "/w/b.txt")
    expect(opsMock.renameFile).toHaveBeenCalledWith("/w/a.txt", "/w/b.txt")
  })

  it("remove, stat, list, mkdir, exists delegate", async () => {
    opsMock.removeFile.mockResolvedValue(undefined)
    opsMock.statFile.mockResolvedValue({ path: "/w/a", size: 0, isFile: true, isDir: false })
    opsMock.readDir.mockResolvedValue(["a", "b"])
    opsMock.createDir.mockResolvedValue(undefined)
    opsMock.exists.mockResolvedValue(true)

    await fs.remove("/w/a", { recursive: true })
    expect(opsMock.removeFile).toHaveBeenCalledWith("/w/a", { recursive: true })
    await expect(fs.stat("/w/a")).resolves.toMatchObject({ path: "/w/a" })
    await expect(fs.list("/w")).resolves.toEqual(["a", "b"])
    await fs.mkdir("/w/new")
    expect(confinedMock.mkdir).toHaveBeenCalledWith("/w/new", ["/w"])
    expect(opsMock.createDir).not.toHaveBeenCalled()
    await expect(fs.exists("/w/a")).resolves.toBe(true)
  })

  it("falls back to the raw primitive for an allowAnyPath policy (gesture flow)", async () => {
    opsMock.writeTextFile.mockResolvedValue(undefined)
    const anyFs = new SecureFileSystem(
      { allowedRoots: [], allowAnyPath: true },
      { confined: confinedMock }
    )
    await anyFs.writeText("/tmp/x.txt", "data")
    expect(opsMock.writeTextFile).toHaveBeenCalledWith("/tmp/x.txt", "data")
    expect(confinedMock.writeText).not.toHaveBeenCalled()
  })
})

describe("SecureFileSystem — denied operations", () => {
  const fs = new SecureFileSystem(policy)

  it("throws FileAccessError, warns, and audits a denial without touching the fs", async () => {
    await expect(fs.readText("/etc/passwd")).rejects.toBeInstanceOf(FileAccessError)
    expect(opsMock.readTextFile).not.toHaveBeenCalled()
    expect(filesLogger.warn).toHaveBeenCalledWith(
      "file access denied",
      expect.objectContaining({ op: "read", reason: "outside_roots" })
    )
    expect(getFileAudit()[0]).toMatchObject({ op: "read", allowed: false })
  })

  it("denies a write under a read-only policy", async () => {
    const ro = new SecureFileSystem({ allowedRoots: ["/w"], readOnly: true })
    await expect(ro.writeText("/w/a.txt", "x")).rejects.toThrow(FileAccessError)
    expect(opsMock.writeTextFile).not.toHaveBeenCalled()
  })

  it("denies a copy whose destination escapes the roots", async () => {
    await expect(fs.copy("/w/a.txt", "/etc/evil")).rejects.toThrow(FileAccessError)
    expect(opsMock.copyFile).not.toHaveBeenCalled()
  })
})

describe("SecureFileSystem — runtime failures", () => {
  const fs = new SecureFileSystem(policy)

  it("logs + audits then rethrows a runtime error", async () => {
    opsMock.readTextFile.mockRejectedValue(new Error("disk gone"))
    await expect(fs.readText("/w/a.txt")).rejects.toThrow("disk gone")
    expect(filesLogger.error).toHaveBeenCalled()
    expect(getFileAudit()[0]).toMatchObject({ op: "read", allowed: true, error: "disk gone" })
  })
})

describe("SecureFileSystem — config", () => {
  it("withPolicy swaps the policy and keeps the logger", async () => {
    const fs = new SecureFileSystem(policy, { logger: filesLogger })
    const widened = fs.withPolicy({ allowedRoots: ["/other"] })
    opsMock.readTextFile.mockResolvedValue("x")
    await widened.readText("/other/a.txt")
    expect(opsMock.readTextFile).toHaveBeenCalled()
    await expect(widened.readText("/w/a.txt")).rejects.toThrow(FileAccessError)
  })

  it("respects audit:false", async () => {
    const fs = createSecureFs(policy, { audit: false })
    opsMock.readTextFile.mockResolvedValue("x")
    await fs.readText("/w/a.txt")
    expect(getFileAudit()).toHaveLength(0)
  })

  it("createSecureFs returns a SecureFileSystem", () => {
    expect(createSecureFs(policy)).toBeInstanceOf(SecureFileSystem)
  })
})
