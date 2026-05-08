/**
 * @jest-environment jsdom
 */
import { close, onClose, open } from "./browser"

function makeBrowser() {
  const remove = jest.fn()
  const handlers: Record<string, () => void> = {}
  return {
    open: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn(async (event: string, handler: () => void) => {
      handlers[event] = handler
      return { remove }
    }),
    handlers,
    remove,
  }
}

describe("browser.open", () => {
  it("forwards url + toolbar color", async () => {
    const b = makeBrowser()
    await open({
      url: "https://example.com",
      toolbarColor: "#000000",
      presentationStyle: "fullscreen",
      loader: async () => b,
    })
    expect(b.open).toHaveBeenCalledWith({
      url: "https://example.com",
      toolbarColor: "#000000",
      presentationStyle: "fullscreen",
    })
  })

  it("returns unsupported when plugin missing", async () => {
    const out = await open({
      url: "x",
      loader: async () => {
        throw new Error("nope")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })
})

describe("browser.close + onClose", () => {
  it("close calls plugin.close", async () => {
    const b = makeBrowser()
    await close(async () => b)
    expect(b.close).toHaveBeenCalled()
  })

  it("onClose subscribes and unsubscribes", async () => {
    const b = makeBrowser()
    const handler = jest.fn()
    const unsub = await onClose(handler, async () => b)
    b.handlers.browserFinished()
    expect(handler).toHaveBeenCalled()
    unsub()
    expect(b.remove).toHaveBeenCalled()
  })

  it("onClose returns no-op unsub when plugin missing", async () => {
    const unsub = await onClose(jest.fn(), async () => {
      throw new Error("nope")
    })
    expect(typeof unsub).toBe("function")
    expect(() => unsub()).not.toThrow()
  })
})
