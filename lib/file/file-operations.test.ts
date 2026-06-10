jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))

const fsMock = {
  readTextFile: jest.fn(),
  writeTextFile: jest.fn(),
  exists: jest.fn(),
  readDir: jest.fn(),
  readFile: jest.fn(),
  writeFile: jest.fn(),
  remove: jest.fn(),
  copyFile: jest.fn(),
  rename: jest.fn(),
  mkdir: jest.fn(),
  stat: jest.fn(),
}
jest.mock("@tauri-apps/plugin-fs", () => fsMock, { virtual: true })

import { isTauri } from "@/lib/tauri"
import {
  readTextFile,
  writeTextFile,
  exists,
  readDir,
  readBinaryFile,
  writeBinaryFile,
  removeFile,
  copyFile,
  renameFile,
  createDir,
  statFile,
} from "./file-operations"

const mockIsTauri = isTauri as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
})

describe("file-operations in Tauri", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(true))

  it("readTextFile delegates to plugin-fs", async () => {
    fsMock.readTextFile.mockResolvedValue("body")
    await expect(readTextFile("/p")).resolves.toBe("body")
    expect(fsMock.readTextFile).toHaveBeenCalledWith("/p")
  })

  it("writeTextFile delegates to plugin-fs", async () => {
    fsMock.writeTextFile.mockResolvedValue(undefined)
    await writeTextFile("/p", "data")
    expect(fsMock.writeTextFile).toHaveBeenCalledWith("/p", "data")
  })

  it("exists delegates to plugin-fs", async () => {
    fsMock.exists.mockResolvedValue(true)
    await expect(exists("/p")).resolves.toBe(true)
  })

  it("readDir returns only string names", async () => {
    fsMock.readDir.mockResolvedValue([{ name: "a" }, { name: undefined }, { name: "b" }])
    await expect(readDir("/d")).resolves.toEqual(["a", "b"])
  })

  it("readBinaryFile returns bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    fsMock.readFile.mockResolvedValue(bytes)
    await expect(readBinaryFile("/p")).resolves.toBe(bytes)
  })

  it("writeBinaryFile delegates to plugin-fs", async () => {
    const bytes = new Uint8Array([9])
    fsMock.writeFile.mockResolvedValue(undefined)
    await writeBinaryFile("/p", bytes)
    expect(fsMock.writeFile).toHaveBeenCalledWith("/p", bytes)
  })

  it("removeFile passes the recursive flag", async () => {
    fsMock.remove.mockResolvedValue(undefined)
    await removeFile("/d", { recursive: true })
    expect(fsMock.remove).toHaveBeenCalledWith("/d", { recursive: true })
  })

  it("removeFile defaults recursive to false", async () => {
    fsMock.remove.mockResolvedValue(undefined)
    await removeFile("/f")
    expect(fsMock.remove).toHaveBeenCalledWith("/f", { recursive: false })
  })

  it("copyFile delegates to plugin-fs", async () => {
    fsMock.copyFile.mockResolvedValue(undefined)
    await copyFile("/a", "/b")
    expect(fsMock.copyFile).toHaveBeenCalledWith("/a", "/b")
  })

  it("renameFile delegates to plugin-fs", async () => {
    fsMock.rename.mockResolvedValue(undefined)
    await renameFile("/a", "/b")
    expect(fsMock.rename).toHaveBeenCalledWith("/a", "/b")
  })

  it("createDir defaults recursive to true", async () => {
    fsMock.mkdir.mockResolvedValue(undefined)
    await createDir("/d")
    expect(fsMock.mkdir).toHaveBeenCalledWith("/d", { recursive: true })
  })

  it("statFile maps the FileInfo shape", async () => {
    const mtime = new Date(1000)
    const birthtime = new Date(2000)
    fsMock.stat.mockResolvedValue({
      isFile: true,
      isDirectory: false,
      isSymlink: false,
      size: 42,
      mtime,
      birthtime,
      readonly: true,
    })
    const s = await statFile("/p")
    expect(s).toEqual({
      path: "/p",
      size: 42,
      isFile: true,
      isDir: false,
      isSymlink: false,
      modifiedMs: 1000,
      createdMs: 2000,
      readonly: true,
    })
  })

  it("statFile leaves timestamps undefined when null", async () => {
    fsMock.stat.mockResolvedValue({
      isFile: false,
      isDirectory: true,
      isSymlink: false,
      size: 0,
      mtime: null,
      birthtime: null,
      readonly: false,
    })
    const s = await statFile("/d")
    expect(s.modifiedMs).toBeUndefined()
    expect(s.createdMs).toBeUndefined()
    expect(s.isDir).toBe(true)
  })
})

describe("file-operations in the browser", () => {
  beforeEach(() => mockIsTauri.mockReturnValue(false))

  it("readTextFile fetches the path", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("web") })
    ;(global as { fetch?: unknown }).fetch = fetchMock
    await expect(readTextFile("/asset.txt")).resolves.toBe("web")
  })

  it("readTextFile throws on a non-ok fetch", async () => {
    ;(global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(readTextFile("/missing")).rejects.toThrow("HTTP 404")
  })

  it("writeTextFile rejects in web mode", async () => {
    await expect(writeTextFile("/p", "x")).rejects.toThrow("not supported in web mode")
  })

  it("exists uses a HEAD request", async () => {
    ;(global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: true })
    await expect(exists("/p")).resolves.toBe(true)
  })

  it("exists returns false when the HEAD throws", async () => {
    ;(global as { fetch?: unknown }).fetch = jest.fn().mockRejectedValue(new Error("net"))
    await expect(exists("/p")).resolves.toBe(false)
  })

  it("readDir returns an empty list", async () => {
    await expect(readDir("/d")).resolves.toEqual([])
  })

  it("readBinaryFile fetches bytes", async () => {
    const buf = new Uint8Array([1, 2]).buffer
    ;(global as { fetch?: unknown }).fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, arrayBuffer: () => Promise.resolve(buf) })
    await expect(readBinaryFile("/a.bin")).resolves.toEqual(new Uint8Array([1, 2]))
  })

  it("readBinaryFile throws on a non-ok fetch", async () => {
    ;(global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 })
    await expect(readBinaryFile("/a.bin")).rejects.toThrow("HTTP 500")
  })

  it("mutating ops reject in web mode", async () => {
    await expect(writeBinaryFile("/p", new Uint8Array())).rejects.toThrow("web mode")
    await expect(removeFile("/p")).rejects.toThrow("web mode")
    await expect(copyFile("/a", "/b")).rejects.toThrow("web mode")
    await expect(renameFile("/a", "/b")).rejects.toThrow("web mode")
    await expect(createDir("/d")).rejects.toThrow("web mode")
  })

  it("statFile derives size from content-length", async () => {
    ;(global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => "123" },
    })
    const s = await statFile("/a.txt")
    expect(s).toEqual({ path: "/a.txt", size: 123, isFile: true, isDir: false })
  })

  it("statFile throws on a non-ok HEAD", async () => {
    ;(global as { fetch?: unknown }).fetch = jest.fn().mockResolvedValue({ ok: false, status: 404 })
    await expect(statFile("/a.txt")).rejects.toThrow("HTTP 404")
  })
})
