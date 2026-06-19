import { pushHistoryToCli } from "./push-history"
import { parseHistory } from "./history-format"

const writeCliHomeFile = jest.fn(async (_f: string, _c: string, _s: boolean) => {})
jest.mock("./home", () => ({
  writeCliHomeFile: (f: string, c: string, s: boolean) => writeCliHomeFile(f, c, s),
}))

const listRecentInputHistory = jest.fn(async (_limit: number): Promise<string[]> => [])
jest.mock("@/lib/db/chat-input-history", () => ({
  listRecentInputHistory: (limit: number) => listRecentInputHistory(limit),
}))

describe("pushHistoryToCli", () => {
  it("writes recent inputs oldest-first and returns the count", async () => {
    const write = jest.fn(async (_fileName: string, _content: string, _secret: boolean) => {})
    // Dexie reader returns newest-first.
    const list = jest.fn(async () => ["newest", "middle", "oldest"])
    const count = await pushHistoryToCli({ list, write })
    expect(count).toBe(3)
    expect(write).toHaveBeenCalledTimes(1)
    const [fileName, content, secret] = write.mock.calls[0]
    expect(fileName).toBe("history.json")
    expect(secret).toBe(false)
    // File body is oldest → newest.
    expect(parseHistory(content)).toEqual(["oldest", "middle", "newest"])
  })

  it("no-ops (count 0, no write) when there is no history", async () => {
    const write = jest.fn(async () => {})
    const count = await pushHistoryToCli({ list: async () => [], write })
    expect(count).toBe(0)
    expect(write).not.toHaveBeenCalled()
  })

  it("passes the history cap to the reader", async () => {
    const list = jest.fn(async () => [])
    await pushHistoryToCli({ list, write: async () => {} })
    expect(list).toHaveBeenCalledWith(100)
  })

  it("uses the default Dexie reader when no list dep is given", async () => {
    // No injected list → exercises the `?? listRecentInputHistory` default.
    listRecentInputHistory.mockResolvedValueOnce([])
    expect(await pushHistoryToCli()).toBe(0)
    expect(listRecentInputHistory).toHaveBeenCalledWith(100)
  })

  it("falls back to the real writeCliHomeFile when no write dep is given", async () => {
    // Inject only the reader → exercises the `?? writeCliHomeFile` default.
    const count = await pushHistoryToCli({ list: async () => ["hello"] })
    expect(count).toBe(1)
    expect(writeCliHomeFile).toHaveBeenCalledWith("history.json", expect.any(String), false)
  })
})
