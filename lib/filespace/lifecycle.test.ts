import { announceFileSpaceSessionsChanged, registerFileSpaceLifecycleSink } from "./lifecycle"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("file-space lifecycle announcements", () => {
  it("does nothing while no host sync runs", async () => {
    expect(() => announceFileSpaceSessionsChanged(["s1"])).not.toThrow()
  })

  it("hands each change to the installed sink, deduplicated", async () => {
    const sink = jest.fn(async (_ids: readonly string[]) => {})
    const remove = registerFileSpaceLifecycleSink(sink)
    announceFileSpaceSessionsChanged(["s1", "s2", "s1"])
    announceFileSpaceSessionsChanged([])
    await flush()
    expect(sink).toHaveBeenCalledTimes(1)
    expect(sink).toHaveBeenCalledWith(["s1", "s2"])
    remove()
    announceFileSpaceSessionsChanged(["s3"])
    await flush()
    expect(sink).toHaveBeenCalledTimes(1)
  })

  it("never lets a failing sink reach the writer", async () => {
    const remove = registerFileSpaceLifecycleSink(async () => {
      throw new Error("host down")
    })
    expect(() => announceFileSpaceSessionsChanged(["s1"])).not.toThrow()
    await flush()
    remove()
  })

  it("removing a replaced sink leaves the newer one in place", async () => {
    const first = jest.fn(async (_ids: readonly string[]) => {})
    const second = jest.fn(async (_ids: readonly string[]) => {})
    const removeFirst = registerFileSpaceLifecycleSink(first)
    const removeSecond = registerFileSpaceLifecycleSink(second)
    removeFirst()
    announceFileSpaceSessionsChanged(["s1"])
    await flush()
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith(["s1"])
    removeSecond()
  })
})
