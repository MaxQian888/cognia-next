import { decodeNativeVideoFrame } from "./native-video-frame"

function packed(width: number, height: number, fill = 7): Uint8Array {
  const out = new Uint8Array(8 + width * height * 4).fill(fill)
  const view = new DataView(out.buffer)
  view.setUint32(0, width, true)
  view.setUint32(4, height, true)
  return out
}

describe("decodeNativeVideoFrame", () => {
  it("reads the dimension header and copies the pixels", () => {
    const response = packed(2, 3)
    const frame = decodeNativeVideoFrame(response)
    expect(frame).toMatchObject({ width: 2, height: 3 })
    expect(frame.data).toHaveLength(24)
    expect(frame.data[0]).toBe(7)
    // A copy, not a view: mutating the response must not reach the frame.
    response[8] = 0
    expect(frame.data[0]).toBe(7)
  })

  it("accepts the ArrayBuffer and number[] forms IPC can hand back", () => {
    expect(decodeNativeVideoFrame(packed(1, 1).buffer as ArrayBuffer)).toMatchObject({
      width: 1,
      height: 1,
    })
    expect(decodeNativeVideoFrame(Array.from(packed(1, 1)))).toMatchObject({ width: 1, height: 1 })
  })

  it("rejects a truncated header, zero dimensions and a length mismatch", () => {
    expect(() => decodeNativeVideoFrame(new Uint8Array(4))).toThrow(/header/)
    expect(() => decodeNativeVideoFrame(packed(0, 2))).toThrow(/dimensions/)
    expect(() => decodeNativeVideoFrame(packed(2, 2).slice(0, 20))).toThrow(/expected 16/)
  })

  it("reads a header that does not start at the buffer's first byte", () => {
    const backing = new Uint8Array(3 + 8 + 4)
    backing.set(packed(1, 1, 9), 3)
    const frame = decodeNativeVideoFrame(backing.subarray(3))
    expect(frame).toMatchObject({ width: 1, height: 1 })
    expect(Array.from(frame.data)).toEqual([9, 9, 9, 9])
  })
})
