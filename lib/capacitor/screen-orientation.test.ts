/**
 * @jest-environment jsdom
 */
import { getOrientation, lock, unlock } from "./screen-orientation"

function makeSo() {
  return {
    orientation: jest.fn().mockResolvedValue({ type: "portrait-primary" }),
    lock: jest.fn().mockResolvedValue(undefined),
    unlock: jest.fn().mockResolvedValue(undefined),
  }
}

describe("screen-orientation", () => {
  it("getOrientation returns the type as value", async () => {
    const so = makeSo()
    const out = await getOrientation(async () => so)
    expect(out).toEqual({ kind: "ok", value: "portrait-primary" })
  })

  it("lock forwards orientation argument", async () => {
    const so = makeSo()
    await lock("landscape", async () => so)
    expect(so.lock).toHaveBeenCalledWith({ orientation: "landscape" })
  })

  it("unlock calls plugin.unlock", async () => {
    const so = makeSo()
    await unlock(async () => so)
    expect(so.unlock).toHaveBeenCalled()
  })

  it("returns unsupported when not loadable", async () => {
    const out = await lock("portrait", async () => {
      throw new Error("nope")
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})
