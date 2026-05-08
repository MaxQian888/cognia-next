/**
 * @jest-environment jsdom
 */
import { showToast } from "./toast"

describe("showToast", () => {
  it("forwards text/duration/position to the plugin", async () => {
    const show = jest.fn().mockResolvedValue(undefined)
    const out = await showToast({
      text: "saved",
      duration: "long",
      position: "top",
      loader: async () => ({ show }),
    })
    expect(show).toHaveBeenCalledWith({ text: "saved", duration: "long", position: "top" })
    expect(out).toEqual({ kind: "ok" })
  })

  it("uses defaults for duration and position", async () => {
    const show = jest.fn().mockResolvedValue(undefined)
    await showToast({
      text: "ok",
      loader: async () => ({ show }),
    })
    expect(show).toHaveBeenCalledWith({ text: "ok", duration: "short", position: "bottom" })
  })

  it("returns unsupported when the plugin is not loadable", async () => {
    const out = await showToast({
      text: "hi",
      loader: async () => {
        throw new Error("not native")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error when the plugin throws", async () => {
    const out = await showToast({
      text: "hi",
      loader: async () => ({
        show: async () => {
          throw new Error("native error")
        },
      }),
    })
    expect(out).toEqual({ kind: "error", message: "native error" })
  })
})
