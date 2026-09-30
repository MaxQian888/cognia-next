jest.mock("@tauri-apps/plugin-fs", () => ({
  BaseDirectory: { AppData: 14 },
  mkdir: jest.fn(async () => {}),
  remove: jest.fn(async () => {}),
  writeFile: jest.fn(async () => {}),
  rename: jest.fn(async () => {}),
  exists: jest.fn(async () => true),
  readFile: jest.fn(async () => new Uint8Array([4, 2])),
}))
jest.mock("@tauri-apps/api/path", () => ({
  appDataDir: jest.fn(async () => "/data/cognia"),
  join: jest.fn(async (...parts: string[]) => parts.join("/")),
}))

import * as fs from "@tauri-apps/plugin-fs"

import {
  APP_DATA_WRITE_CHUNK_BYTES,
  appDataFileExists,
  appDataPath,
  readAppDataFile,
  removeAppDataFile,
  writeBlobToAppData,
} from "./app-data-files"

const writeFile = fs.writeFile as jest.Mock
const remove = fs.remove as jest.Mock
const exists = fs.exists as jest.Mock
const rename = fs.rename as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  writeFile.mockResolvedValue(undefined)
  remove.mockResolvedValue(undefined)
  rename.mockResolvedValue(undefined)
  exists.mockResolvedValue(true)
})

describe("writeBlobToAppData", () => {
  it("appends chunks to a part file, renames it into place and returns the absolute path", async () => {
    const size = APP_DATA_WRITE_CHUNK_BYTES + 3
    const path = await writeBlobToAppData("videos/a.mp4", new Blob([new Uint8Array(size)]))
    expect(fs.mkdir).toHaveBeenCalledWith("videos", { baseDir: 14, recursive: true })
    const part = writeFile.mock.calls[0][0] as string
    expect(part).toMatch(/^videos\/a\.mp4\..+\.part$/)
    expect(writeFile.mock.calls.map((call) => [call[0], call[1].byteLength, call[2]])).toEqual([
      [part, APP_DATA_WRITE_CHUNK_BYTES, { baseDir: 14, append: false }],
      [part, 3, { baseDir: 14, append: true }],
    ])
    expect(rename).toHaveBeenCalledWith(part, "videos/a.mp4", {
      oldPathBaseDir: 14,
      newPathBaseDir: 14,
    })
    expect(path).toBe("/data/cognia/videos/a.mp4")
  })

  it("writes an empty file once, and needs no directory at the root", async () => {
    await writeBlobToAppData("empty.bin", new Blob([]))
    expect(fs.mkdir).not.toHaveBeenCalled()
    expect(writeFile).toHaveBeenCalledTimes(1)
  })

  it("removes the part file and leaves the path alone when a chunk fails", async () => {
    writeFile.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"))
    await expect(
      writeBlobToAppData("videos/b.mp4", new Blob([new Uint8Array(APP_DATA_WRITE_CHUNK_BYTES + 1)]))
    ).rejects.toThrow("disk full")
    const part = writeFile.mock.calls[0][0] as string
    expect(remove).toHaveBeenCalledWith(part, { baseDir: 14 })
    expect(rename).not.toHaveBeenCalled()
  })

  it("refuses a path that is absolute or climbs out of AppData", async () => {
    for (const bad of ["/etc/passwd", "../x", "a/../../x", "a//b", "", "a\\b", "./a"]) {
      await expect(writeBlobToAppData(bad, new Blob([]))).rejects.toThrow("relative AppData")
    }
    expect(writeFile).not.toHaveBeenCalled()
  })
})

describe("the other AppData helpers", () => {
  it("removes a file, skips one already gone, and reports any other failure", async () => {
    await expect(removeAppDataFile("videos/a.mp4")).resolves.toBeUndefined()
    expect(remove).toHaveBeenCalledWith("videos/a.mp4", { baseDir: 14 })
    exists.mockResolvedValueOnce(false)
    remove.mockClear()
    await expect(removeAppDataFile("videos/gone.mp4")).resolves.toBeUndefined()
    expect(remove).not.toHaveBeenCalled()
    remove.mockRejectedValueOnce(new Error("file in use"))
    await expect(removeAppDataFile("videos/a.mp4")).rejects.toThrow("file in use")
  })

  it("test, read and resolve under AppData", async () => {
    await expect(appDataFileExists("videos/a.mp4")).resolves.toBe(true)
    exists.mockRejectedValueOnce(new Error("forbidden"))
    await expect(appDataFileExists("videos/a.mp4")).resolves.toBe(false)

    await expect(readAppDataFile("videos/a.mp4")).resolves.toEqual(new Uint8Array([4, 2]))
    await expect(appDataPath("videos/a.mp4")).resolves.toBe("/data/cognia/videos/a.mp4")
    await expect(readAppDataFile("../a")).rejects.toThrow("relative AppData")
  })
})
