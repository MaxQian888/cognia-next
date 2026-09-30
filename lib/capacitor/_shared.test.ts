/**
 * @jest-environment jsdom
 */
import {
  asNonThenable,
  dataUrlToBase64,
  detectNativePlatform,
  isMobile,
  makeDefaultLoader,
  readFileAsDataUrl,
  withPlugin,
} from "./_shared"

describe("detectNativePlatform", () => {
  const originalWindow = globalThis.window
  afterEach(() => {
    globalThis.window = originalWindow
    delete (globalThis as { Capacitor?: unknown }).Capacitor
  })

  it("returns 'web' when window is undefined", () => {
    const realWindow = globalThis.window
    // @ts-expect-error simulate SSR
    globalThis.window = undefined
    expect(detectNativePlatform()).toBe("web")
    globalThis.window = realWindow
  })

  it("returns 'tauri' when __TAURI_INTERNALS__ is present", () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} })
    expect(detectNativePlatform()).toBe("tauri")
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it("returns 'mobile' when Capacitor.isNativePlatform() === true", () => {
    Object.assign(window, { Capacitor: { isNativePlatform: () => true } })
    expect(detectNativePlatform()).toBe("mobile")
    expect(isMobile()).toBe(true)
    delete (window as { Capacitor?: unknown }).Capacitor
  })

  it("returns 'web' for plain browser", () => {
    expect(detectNativePlatform()).toBe("web")
    expect(isMobile()).toBe(false)
  })
})

describe("withPlugin", () => {
  it("returns 'unsupported' when loader rejects", async () => {
    const result = await withPlugin(
      async () => {
        throw new Error("module not found")
      },
      async () => "value"
    )
    expect(result).toEqual({ kind: "unsupported" })
  })

  it("returns 'error' when action throws", async () => {
    const result = await withPlugin(
      async () => ({}),
      async () => {
        throw new Error("boom")
      }
    )
    expect(result).toEqual({ kind: "error", message: "boom" })
  })

  it("returns the action result on success", async () => {
    const result = await withPlugin(
      async () => ({ method: () => 42 }),
      async (plugin) => plugin.method()
    )
    expect(result).toBe(42)
  })

  it("normalizes non-Error throws to string", async () => {
    const result = await withPlugin(
      async () => ({}),
      async () => {
        throw "string error"
      }
    )
    expect(result).toEqual({ kind: "error", message: "string error" })
  })
})

describe("readFileAsDataUrl", () => {
  it("reads a Blob as a base64 data URL", async () => {
    const url = await readFileAsDataUrl(new File(["hello"], "f.txt", { type: "text/plain" }))
    expect(url).toBe(`data:text/plain;base64,${btoa("hello")}`)
  })
})

describe("dataUrlToBase64", () => {
  it("strips the data: prefix", () => {
    expect(dataUrlToBase64("data:image/png;base64,QUFB")).toBe("QUFB")
  })

  it("returns the input unchanged when there is no comma", () => {
    expect(dataUrlToBase64("QUFB")).toBe("QUFB")
  })
})

describe("makeDefaultLoader", () => {
  it("creates a loader that returns the named export", async () => {
    // We can't actually dynamic-import from jest, so we just confirm the
    // function shape is correct and rejects on missing module (caught by
    // withPlugin in real usage).
    const loader = makeDefaultLoader("@nonexistent/plugin", "Plugin")
    await expect(loader()).rejects.toBeDefined()
  })
})

describe("asNonThenable", () => {
  it("hides `then` so an awaited plugin proxy resolves instead of hanging", async () => {
    // Shape of `@capacitor/core`'s plugin proxy: every property — `then`
    // included — answers with a method wrapper. Awaiting it directly calls the
    // bogus `then`, which never resolves.
    const calls: string[] = []
    const capacitorLikeProxy = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return () => Promise.reject(new Error('"Clipboard.then()" is not implemented'))
          }
          return (...args: unknown[]) => {
            calls.push(`${String(prop)}:${JSON.stringify(args)}`)
            return Promise.resolve({ value: "native" })
          }
        },
      }
    ) as { read: () => Promise<{ value: string }> }

    const resolved = await (async () => asNonThenable(capacitorLikeProxy))()
    expect((resolved as unknown as { then?: unknown }).then).toBeUndefined()
    await expect(resolved.read()).resolves.toEqual({ value: "native" })
    expect(calls).toEqual(["read:[]"])
  })

  it("returns primitives and nullish values unchanged", () => {
    expect(asNonThenable(null)).toBeNull()
    expect(asNonThenable(undefined)).toBeUndefined()
    expect(asNonThenable(3)).toBe(3)
  })
})

describe("makeDefaultLoader with a registered @capacitor/core plugin", () => {
  const win = globalThis as unknown as Record<string, unknown>
  let savedCapacitor: unknown

  beforeEach(() => {
    savedCapacitor = win.Capacitor
  })
  afterEach(() => {
    win.Capacitor = savedCapacitor
    delete win.androidBridge
  })

  it("resolves the proxy registerPlugin() put on window.Capacitor.Plugins", async () => {
    // Recreate the Android boot: the native bridge publishes PluginHeaders and
    // the transport, then `registerNativePlugins()` calls core's
    // `registerPlugin`, replacing the injected object with core's proxy.
    const nativePromise = jest.fn((plugin: string, method: string) =>
      Promise.resolve({ value: `${plugin}.${method}` })
    )
    win.androidBridge = {}
    win.Capacitor = {
      Plugins: {},
      PluginHeaders: [
        {
          name: "Clipboard",
          methods: [
            { name: "read", rtype: "promise" },
            { name: "write", rtype: "promise" },
          ],
        },
      ],
      nativePromise,
    }
    let registerPlugin: (name: string) => unknown = () => undefined
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      registerPlugin = require("@capacitor/core").registerPlugin
    })
    registerPlugin("Clipboard")

    const loader = makeDefaultLoader<{ read: () => Promise<{ value: string }> }>(
      "@capacitor/clipboard",
      "Clipboard"
    )
    const settled = await Promise.race([
      loader().then(() => "resolved"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 200)),
    ])
    expect(settled).toBe("resolved")

    const plugin = await loader()
    await expect(plugin.read()).resolves.toEqual({ value: "Clipboard.read" })
    expect(nativePromise).toHaveBeenCalledWith("Clipboard", "read", undefined)
  })
})
