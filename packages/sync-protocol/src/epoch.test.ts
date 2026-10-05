import { toBase64Url } from "./bytes"
import {
  deviceNamePadding,
  fitDeviceName,
  keyCommitment,
  matchesKeyCommitment,
  newEpochKey,
  openDeviceName,
  sealDeviceName,
  unwrapPreviousKey,
  wrapPreviousKey,
} from "./epoch"

const SPACE = "s".repeat(43)

describe("epoch keys", () => {
  it("commits to a key per space and epoch", async () => {
    const key = newEpochKey()
    const commit = await keyCommitment(key, SPACE, 3)
    expect(await matchesKeyCommitment(key, SPACE, 3, commit)).toBe(true)
    expect(await matchesKeyCommitment(key, SPACE, 4, commit)).toBe(false)
    expect(await matchesKeyCommitment(key, "t".repeat(43), 3, commit)).toBe(false)
    expect(await matchesKeyCommitment(newEpochKey(), SPACE, 3, commit)).toBe(false)
  })

  it("wraps the previous key under the new one, bound to the epoch", async () => {
    const previous = newEpochKey()
    const current = newEpochKey()
    const wrap = await wrapPreviousKey(current, previous, SPACE, 5)
    expect(await unwrapPreviousKey(current, wrap, SPACE, 5)).toEqual(previous)
    await expect(unwrapPreviousKey(current, wrap, SPACE, 6)).rejects.toThrow()
    await expect(unwrapPreviousKey(newEpochKey(), wrap, SPACE, 5)).rejects.toThrow()
  })

  it("seals device names to a fixed size, bound to the device", async () => {
    const key = newEpochKey()
    const sealed = await sealDeviceName(key, SPACE, "dev_A", 2, "MacBook 工作")
    expect(sealed.epoch).toBe(2)
    expect(await openDeviceName(key, SPACE, "dev_A", sealed)).toBe("MacBook 工作")
    await expect(openDeviceName(key, SPACE, "dev_B", sealed)).rejects.toThrow()
    const short = await sealDeviceName(key, SPACE, "dev_A", 2, "a")
    expect(short.ct.length).toBe(sealed.ct.length)
    expect(toBase64Url(new Uint8Array(80)).length).toBe(sealed.ct.length)
  })

  it("fits a long name without splitting a character", () => {
    const fitted = fitDeviceName("名".repeat(40))
    expect(new TextEncoder().encode(fitted).length).toBeLessThanOrEqual(63)
    expect(fitted).toBe("名".repeat(21))
    expect(() => deviceNamePadding.pad("x".repeat(64))).toThrow("too long")
    expect(deviceNamePadding.unpad(deviceNamePadding.pad("  hi"))).toBe("  hi")
  })
})
