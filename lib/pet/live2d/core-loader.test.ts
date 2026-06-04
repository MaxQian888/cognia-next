import { CUBISM_CORE_PUBLIC_PATH } from "./constants"
import { ensureCubismCore, resetCubismCoreLoaderForTests } from "./core-loader"

describe("ensureCubismCore", () => {
  beforeEach(() => {
    resetCubismCoreLoaderForTests()
  })

  it("resolves true immediately when the core global is already present", async () => {
    const inject = jest.fn()
    const ready = await ensureCubismCore({ getCore: () => ({}), injectScript: inject })
    expect(ready).toBe(true)
    expect(inject).not.toHaveBeenCalled()
  })

  it("injects the local core script then re-checks the global", async () => {
    let present = false
    const inject = jest.fn(async (src: string) => {
      expect(src).toBe(CUBISM_CORE_PUBLIC_PATH)
      present = true
    })
    const ready = await ensureCubismCore({
      getCore: () => (present ? {} : undefined),
      injectScript: inject,
    })
    expect(ready).toBe(true)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it("resolves false when injection rejects", async () => {
    const ready = await ensureCubismCore({
      getCore: () => undefined,
      injectScript: async () => {
        throw new Error("404")
      },
    })
    expect(ready).toBe(false)
  })

  it("resolves false when the global is still absent after injection", async () => {
    const ready = await ensureCubismCore({
      getCore: () => undefined,
      injectScript: async () => {},
    })
    expect(ready).toBe(false)
  })

  it("caches the in-flight promise so concurrent callers share one injection", async () => {
    let present = false
    const inject = jest.fn(async () => {
      present = true
    })
    const getCore = () => (present ? {} : undefined)
    const [a, b] = await Promise.all([
      ensureCubismCore({ getCore, injectScript: inject }),
      ensureCubismCore({ getCore, injectScript: inject }),
    ])
    expect(a).toBe(true)
    expect(b).toBe(true)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  describe("default deps", () => {
    afterEach(() => {
      resetCubismCoreLoaderForTests()
      document.head.querySelectorAll("script").forEach((s) => s.remove())
      delete (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore
    })

    it("reads the default core global from window", async () => {
      ;(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore = {}
      const ready = await ensureCubismCore()
      expect(ready).toBe(true)
    })

    it("injects a script tag by default and resolves on load", async () => {
      const promise = ensureCubismCore()
      // The default injector appends a <script>; simulate a successful load.
      const script = document.head.querySelector("script")
      expect(script?.getAttribute("src")).toBe(CUBISM_CORE_PUBLIC_PATH)
      ;(window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore = {}
      script?.onload?.(new Event("load"))
      expect(await promise).toBe(true)
    })

    it("resolves false when the default script errors", async () => {
      const promise = ensureCubismCore()
      const script = document.head.querySelector("script")
      script?.onerror?.(new Event("error"))
      expect(await promise).toBe(false)
    })

    // NOTE: the `typeof window === "undefined"` (defaultGetCore) and
    // `typeof document === "undefined"` (defaultInjectScript) SSR guards cannot
    // be exercised under jsdom — both globals are defined non-configurable, so
    // they can be neither deleted nor redefined. They run only in a true
    // server (no-DOM) environment, which this Jest jsdom suite never is.
  })
})
