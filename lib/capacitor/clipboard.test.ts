/**
 * @jest-environment jsdom
 */
import {
  installNativeClipboardBridge,
  writeText,
  readText,
  type ClipboardLoader,
} from "./clipboard"

function makeLoader(impl: Partial<Record<"write" | "read", unknown>> = {}): ClipboardLoader {
  return async () =>
    ({
      write: async () => {},
      read: async () => ({ value: "from clipboard", type: "text/plain" }),
      ...impl,
    }) as unknown as Awaited<ReturnType<ClipboardLoader>>
}

describe("lib/capacitor/clipboard", () => {
  describe("writeText", () => {
    it("writes the string through the native plugin", async () => {
      const write = jest.fn(async () => {})
      const out = await writeText("hi", makeLoader({ write }))
      expect(out.kind).toBe("ok")
      expect(write).toHaveBeenCalledWith({ string: "hi" })
    })

    it("returns unsupported when the plugin cannot load", async () => {
      const out = await writeText("hi", async () => {
        throw new Error("not on platform")
      })
      expect(out.kind).toBe("unsupported")
    })

    it("returns error when the native write throws", async () => {
      const out = await writeText(
        "hi",
        makeLoader({
          write: async () => {
            throw new Error("denied")
          },
        })
      )
      expect(out.kind).toBe("error")
      if (out.kind !== "error") return
      expect(out.message).toMatch(/denied/)
    })
  })

  describe("readText", () => {
    it("reads the clipboard value", async () => {
      const out = await readText(makeLoader())
      expect(out.kind).toBe("ok")
      if (out.kind !== "ok") return
      expect(out.value).toBe("from clipboard")
    })

    it("coerces a missing value to an empty string", async () => {
      const out = await readText(makeLoader({ read: async () => ({}) }))
      expect(out.kind).toBe("ok")
      if (out.kind !== "ok") return
      expect(out.value).toBe("")
    })

    it("returns unsupported when the plugin cannot load", async () => {
      const out = await readText(async () => {
        throw new Error("not on platform")
      })
      expect(out.kind).toBe("unsupported")
    })
  })
})

describe("installNativeClipboardBridge", () => {
  function fakeNavigator(clipboard?: Partial<Clipboard>): Navigator {
    const nav = {} as Navigator
    if (clipboard) Object.defineProperty(nav, "clipboard", { value: clipboard, configurable: true })
    return nav
  }

  it("routes writeText through the native plugin", async () => {
    const webWrite = jest.fn(async () => {})
    const nav = fakeNavigator({ writeText: webWrite, readText: jest.fn() })
    const write = jest.fn(async () => {})
    expect(installNativeClipboardBridge({ nav, loader: makeLoader({ write }) })).toBe(true)
    await nav.clipboard.writeText("link")
    expect(write).toHaveBeenCalledWith({ string: "link" })
    expect(webWrite).not.toHaveBeenCalled()
  })

  it("falls back to the WebView method when the native write fails", async () => {
    const webWrite = jest.fn(async () => {})
    const nav = fakeNavigator({ writeText: webWrite, readText: jest.fn() })
    installNativeClipboardBridge({
      nav,
      loader: makeLoader({
        write: async () => {
          throw new Error("boom")
        },
      }),
    })
    await nav.clipboard.writeText("x")
    expect(webWrite).toHaveBeenCalledWith("x")
  })

  it("reads through the native plugin and maps an empty pasteboard to ''", async () => {
    const nav = fakeNavigator({ writeText: jest.fn(), readText: jest.fn(async () => "web") })
    installNativeClipboardBridge({ nav, loader: makeLoader() })
    await expect(nav.clipboard.readText()).resolves.toBe("from clipboard")

    const empty = fakeNavigator({ writeText: jest.fn(), readText: jest.fn(async () => "web") })
    installNativeClipboardBridge({
      nav: empty,
      loader: makeLoader({
        read: async () => {
          throw new Error("There is no data on the clipboard")
        },
      }),
    })
    await expect(empty.clipboard.readText()).resolves.toBe("")
  })

  it("bridges the text/plain representation of write(items)", async () => {
    const webWrite = jest.fn(async () => {})
    const nav = fakeNavigator({ writeText: jest.fn(), readText: jest.fn(), write: webWrite })
    const write = jest.fn(async () => {})
    installNativeClipboardBridge({ nav, loader: makeLoader({ write }) })
    const item = {
      types: ["text/plain", "text/html"],
      // jsdom's Blob has no `.text()`; WebViews do. Return the minimal shape.
      getType: async (type: string) => ({
        text: async () => (type === "text/plain" ? "plain" : "<b>x</b>"),
      }),
    } as unknown as ClipboardItem
    await nav.clipboard.write([item])
    expect(write).toHaveBeenCalledWith({ string: "plain" })
    expect(webWrite).not.toHaveBeenCalled()

    const image = { types: ["image/png"], getType: jest.fn() } as unknown as ClipboardItem
    await nav.clipboard.write([image])
    expect(webWrite).toHaveBeenCalledWith([image])
  })

  it("creates navigator.clipboard when the WebView exposes none", async () => {
    const nav = fakeNavigator()
    const write = jest.fn(async () => {})
    installNativeClipboardBridge({ nav, loader: makeLoader({ write }) })
    await nav.clipboard.writeText("y")
    expect(write).toHaveBeenCalledWith({ string: "y" })
  })

  it("rejects when neither the plugin nor the WebView can write", async () => {
    const nav = fakeNavigator()
    installNativeClipboardBridge({
      nav,
      loader: async () => {
        throw new Error("missing")
      },
    })
    await expect(nav.clipboard.writeText("z")).rejects.toMatchObject({ name: "NotAllowedError" })
  })

  it("is idempotent", () => {
    const nav = fakeNavigator({ writeText: jest.fn(), readText: jest.fn() })
    expect(installNativeClipboardBridge({ nav, loader: makeLoader() })).toBe(true)
    expect(installNativeClipboardBridge({ nav, loader: makeLoader() })).toBe(false)
  })
})
