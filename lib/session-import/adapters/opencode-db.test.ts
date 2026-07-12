import {
  __setOpencodeReaderForTesting,
  opencodeDataDirs,
  readOpencodeSessions,
} from "./opencode-db"

describe("opencode-db reader", () => {
  afterEach(() => __setOpencodeReaderForTesting(null))

  it("returns [] off-desktop when no reader is injected", async () => {
    // jsdom / node test env is not Tauri, so the invoke path is never reached.
    expect(await readOpencodeSessions("/home/u")).toEqual([])
  })

  it("delegates to an injected reader", async () => {
    __setOpencodeReaderForTesting(async (home) => [
      { id: home, title: "t", createdAt: 0, updatedAt: 0, messages: [] },
    ])
    const out = await readOpencodeSessions("/x")
    expect(out[0].id).toBe("/x")
  })
})

describe("opencodeDataDirs", () => {
  it("returns posix-joined candidate dirs for a posix home", () => {
    expect(opencodeDataDirs("/home/u")).toEqual([
      "/home/u/.local/share/opencode",
      "/home/u/AppData/Roaming/opencode",
    ])
  })

  it("uses backslashes for a Windows home and [] for an empty home", () => {
    expect(opencodeDataDirs("C:\\Users\\u")).toEqual([
      "C:\\Users\\u\\.local\\share\\opencode",
      "C:\\Users\\u\\AppData\\Roaming\\opencode",
    ])
    expect(opencodeDataDirs("")).toEqual([])
  })
})
