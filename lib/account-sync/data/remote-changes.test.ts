import { publishRemoteChanges, subscribeRemoteChanges } from "./remote-changes"

describe("remote changes", () => {
  it("hands each subscriber the changed tables until it unsubscribes", () => {
    const heard: string[][] = []
    const stop = subscribeRemoteChanges((tables) => heard.push([...tables]))
    publishRemoteChanges(new Set(["messages", "sessions"]))
    stop()
    publishRemoteChanges(new Set(["memories"]))
    expect(heard).toEqual([["messages", "sessions"]])
  })

  it("says nothing for an empty batch", () => {
    const listener = jest.fn()
    const stop = subscribeRemoteChanges(listener)
    publishRemoteChanges(new Set())
    stop()
    expect(listener).not.toHaveBeenCalled()
  })

  it("keeps telling the others when one listener throws", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const second = jest.fn()
    const stopFirst = subscribeRemoteChanges(() => {
      throw new Error("boom")
    })
    const stopSecond = subscribeRemoteChanges(second)
    publishRemoteChanges(new Set(["characters"]))
    stopFirst()
    stopSecond()
    expect(second).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
