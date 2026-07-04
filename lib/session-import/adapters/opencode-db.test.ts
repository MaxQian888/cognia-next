import { __setOpencodeReaderForTesting, readOpencodeSessions } from "./opencode-db"

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
