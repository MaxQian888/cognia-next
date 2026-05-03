/**
 * @jest-environment jsdom
 */
import { readImageDimensions } from "./image-utils"

beforeAll(() => {
  if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", { value: () => "blob:mock", writable: true })
  }
  if (!URL.revokeObjectURL) {
    Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, writable: true })
  }
})

const installImageMock = (opts: { fail?: boolean } = {}) => {
  const original = (globalThis as unknown as { Image: typeof Image }).Image
  class FakeImage {
    public naturalWidth = 1280
    public naturalHeight = 720
    public onload: (() => void) | null = null
    public onerror: (() => void) | null = null
    set src(_v: string) {
      Promise.resolve().then(() => {
        if (opts.fail) this.onerror?.()
        else this.onload?.()
      })
    }
  }
  ;(globalThis as unknown as { Image: typeof Image }).Image = FakeImage as unknown as typeof Image
  return () => {
    ;(globalThis as unknown as { Image: typeof Image }).Image = original
  }
}

describe("readImageDimensions", () => {
  it("resolves with naturalWidth/naturalHeight when the image loads", async () => {
    const restore = installImageMock()
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" })
    const dims = await readImageDimensions(file)
    expect(dims).toEqual({ width: 1280, height: 720 })
    restore()
  })

  it("rejects when the image fails to decode", async () => {
    const restore = installImageMock({ fail: true })
    const file = new File([new Uint8Array([1])], "x.png", { type: "image/png" })
    await expect(readImageDimensions(file)).rejects.toThrow(/could not decode image/)
    restore()
  })
})
