import {
  DESKTOP_NETWORK_RUNTIME_PACKAGES,
  __resetDesktopNetworkRuntime,
  installDesktopNetworkRuntime,
  type DesktopNetworkRuntimeDeps,
} from "./desktop-network-runtime"

function makeDeps(): DesktopNetworkRuntimeDeps & {
  setWebSearchAdapters: jest.Mock
  setRagAdapters: jest.Mock
  proxyFetch: jest.Mock
} {
  return {
    proxyFetch: jest.fn().mockResolvedValue(new Response("ok")),
    setWebSearchAdapters: jest.fn(),
    setRagAdapters: jest.fn(),
  } as never
}

describe("installDesktopNetworkRuntime", () => {
  beforeEach(() => {
    __resetDesktopNetworkRuntime()
  })

  afterEach(() => {
    __resetDesktopNetworkRuntime()
  })

  it("installs the host transport into every listed package", () => {
    const deps = makeDeps()

    installDesktopNetworkRuntime(deps)

    expect(deps.setWebSearchAdapters).toHaveBeenCalledTimes(1)
    expect(deps.setRagAdapters).toHaveBeenCalledTimes(1)
    expect(deps.setWebSearchAdapters.mock.calls[0][0].proxyFetch).toBe(deps.proxyFetch)
    expect(deps.setRagAdapters.mock.calls[0][0].proxyFetch).toBe(deps.proxyFetch)
  })

  it("is idempotent so Strict Mode and the headless bootstrap can both call it", () => {
    const deps = makeDeps()

    installDesktopNetworkRuntime(deps)
    installDesktopNetworkRuntime(deps)

    expect(deps.setWebSearchAdapters).toHaveBeenCalledTimes(1)
    expect(deps.setRagAdapters).toHaveBeenCalledTimes(1)
  })

  it("gives RAG a logger bound to the network scope", () => {
    const deps = makeDeps()

    installDesktopNetworkRuntime(deps)

    const logger = deps.setRagAdapters.mock.calls[0][0].logger
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
    // Exercised, not just shape-checked: a logger that throws on call would
    // take down whichever RAG request happened to log first. Console output is
    // silenced because the point is that the call survives, not what it prints.
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => {})
    const consoleDebug = jest.spyOn(console, "debug").mockImplementation(() => {})
    try {
      expect(() =>
        logger.error("rerank failed", new Error("boom"), { provider: "cohere" })
      ).not.toThrow()
    } finally {
      consoleError.mockRestore()
      consoleDebug.mockRestore()
    }
  })

  it("keeps the package list and the installs in sync", () => {
    const deps = makeDeps()
    installDesktopNetworkRuntime(deps)

    const installs =
      deps.setWebSearchAdapters.mock.calls.length + deps.setRagAdapters.mock.calls.length
    expect(installs).toBe(DESKTOP_NETWORK_RUNTIME_PACKAGES.length)
    expect(DESKTOP_NETWORK_RUNTIME_PACKAGES).toEqual(["@cognia/web-search", "@cognia/rag"])
  })

  it("really routes a package call through the host transport once installed", async () => {
    // The default deps close over the real `proxyFetch`; this asserts the
    // wiring end-to-end against the package's own getter rather than trusting
    // the setter mock.
    const { webSearchFetch, resetWebSearchRuntimeAdaptersForTesting } =
      await import("@cognia/web-search/runtime-adapters")
    const { setRAGRuntimeAdapters } = await import("@cognia/rag/runtime-adapters")
    resetWebSearchRuntimeAdaptersForTesting()

    const proxyFetch = jest.fn().mockResolvedValue(new Response("via-proxy"))
    installDesktopNetworkRuntime({
      proxyFetch,
      setWebSearchAdapters: (await import("@cognia/web-search/runtime-adapters"))
        .setWebSearchRuntimeAdapters,
      setRagAdapters: setRAGRuntimeAdapters,
    })

    const response = await webSearchFetch("https://api.tavily.com/search")
    expect(await response.text()).toBe("via-proxy")
    resetWebSearchRuntimeAdaptersForTesting()
  })
})
