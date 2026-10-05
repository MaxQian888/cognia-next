import {
  HLC_MAX_DRIFT_MS,
  compareHlc,
  encodeHlc,
  isEncodedHlc,
  maxHlc,
  parseHlc,
  receiveHlc,
  sendHlc,
} from "./hlc"

const A = "dev_" + "A".repeat(26)
const B = "dev_" + "B".repeat(26)

describe("HLC encoding", () => {
  it("round-trips and orders as strings in clock order", () => {
    const early = encodeHlc({ ms: 1000, c: 5, deviceId: B })
    const later = encodeHlc({ ms: 1001, c: 0, deviceId: A })
    const tie = encodeHlc({ ms: 1000, c: 5, deviceId: A })
    expect(parseHlc(early)).toEqual({ ms: 1000, c: 5, deviceId: B })
    expect(compareHlc(early, later)).toBeLessThan(0)
    // Equal times fall back to the device id.
    expect(compareHlc(tie, early)).toBeLessThan(0)
    expect(compareHlc(tie, tie)).toBe(0)
    expect(maxHlc([early, later, tie])).toBe(later)
    expect(maxHlc([])).toBeNull()
  })

  it.each([
    ["a negative time", { ms: -1, c: 0, deviceId: A }],
    ["a time past 48 bits", { ms: 2 ** 48, c: 0, deviceId: A }],
    ["a counter past 16 bits", { ms: 1, c: 0x10000, deviceId: A }],
    ["a bad device id", { ms: 1, c: 0, deviceId: "dev_x" }],
  ])("refuses %s", (_label, hlc) => {
    expect(() => encodeHlc(hlc)).toThrow(RangeError)
  })

  it.each([42, "", "zz", "000000000001" + "0000" + "dev_bad", "00000000000G0000" + A])(
    "does not parse %p",
    (value) => {
      expect(parseHlc(value)).toBeNull()
      expect(isEncodedHlc(value)).toBe(false)
    }
  )
})

describe("sendHlc", () => {
  it("follows the wall clock and counts within one millisecond", () => {
    expect(sendHlc(null, 500, A)).toEqual({ ms: 500, c: 0, deviceId: A })
    expect(sendHlc({ ms: 500, c: 0 }, 500, A)).toEqual({ ms: 500, c: 1, deviceId: A })
    expect(sendHlc({ ms: 500, c: 3 }, 900, A)).toEqual({ ms: 900, c: 0, deviceId: A })
  })

  it("stays ahead of a clock that has seen the future", () => {
    expect(sendHlc({ ms: 2000, c: 7 }, 500, A)).toEqual({ ms: 2000, c: 8, deviceId: A })
    expect(sendHlc({ ms: 2000, c: 0xffff }, 500, A)).toEqual({ ms: 2001, c: 0, deviceId: A })
  })
})

describe("receiveHlc", () => {
  it("moves up to a later remote clock and ignores an earlier one", () => {
    expect(receiveHlc({ ms: 100, c: 0 }, { ms: 200, c: 3 }, 150)).toEqual({ ms: 200, c: 3 })
    expect(receiveHlc({ ms: 300, c: 0 }, { ms: 200, c: 3 }, 150)).toEqual({ ms: 300, c: 0 })
    expect(receiveHlc(null, { ms: 200, c: 3 }, 150)).toEqual({ ms: 200, c: 3 })
  })

  it("does not adopt a clock more than five minutes ahead of the wall clock", () => {
    const now = 1_000_000
    const far = { ms: now + HLC_MAX_DRIFT_MS + 1, c: 0 }
    expect(receiveHlc({ ms: now, c: 1 }, far, now)).toEqual({ ms: now, c: 1 })
    expect(receiveHlc(null, far, now)).toBeNull()
    const near = { ms: now + HLC_MAX_DRIFT_MS, c: 0 }
    expect(receiveHlc({ ms: now, c: 1 }, near, now)).toEqual(near)
  })
})
