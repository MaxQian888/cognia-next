import { withSpaceLock } from "./lock"

describe("withSpaceLock", () => {
  it("runs one change at a time per space", async () => {
    const order: string[] = []
    let release!: () => void
    const first = withSpaceLock("space-a", async () => {
      order.push("first:start")
      await new Promise<void>((resolve) => (release = resolve))
      order.push("first:end")
    })
    const second = withSpaceLock("space-a", async () => {
      order.push("second")
      return 2
    })
    const other = withSpaceLock("space-b", async () => {
      order.push("other")
    })
    await other
    await Promise.resolve()
    release()
    expect(await second).toBe(2)
    await first
    expect(order).toEqual(["first:start", "other", "first:end", "second"])
  })

  it("keeps going after a failed change", async () => {
    await expect(
      withSpaceLock("space-c", async () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom")
    expect(await withSpaceLock("space-c", async () => "ok")).toBe("ok")
  })

  it("uses the Web Locks API when the shell has it", async () => {
    const request = jest.fn((_name: string, callback: () => Promise<unknown>) => callback())
    Object.defineProperty(
      globalThis.navigator ?? (globalThis.navigator = {} as Navigator),
      "locks",
      {
        value: { request },
        configurable: true,
      }
    )
    try {
      expect(await withSpaceLock("space-d", async () => 7)).toBe(7)
      expect(request).toHaveBeenCalledWith("cognia-account-sync:space-d", expect.any(Function))
    } finally {
      delete (globalThis.navigator as unknown as { locks?: unknown }).locks
    }
  })
})
