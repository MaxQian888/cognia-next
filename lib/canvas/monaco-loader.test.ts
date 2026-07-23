/**
 * @jest-environment jsdom
 */

// Module marker: this file has no imports, so without it TS treats it as a
// global script and its mock consts collide with `monaco-loader.ssr.test.ts`.
export {}

const mockConfig = jest.fn()
const mockInit = jest.fn()
const mockIsTauri = jest.fn(() => false)

jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  loader: {
    config: (...args: unknown[]) => mockConfig(...args),
    init: (...args: unknown[]) => mockInit(...args),
  },
}))

jest.mock("@/lib/tauri", () => ({
  __esModule: true,
  isTauri: () => mockIsTauri(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.resetModules()
  delete process.env.NEXT_PUBLIC_MONACO_VS_PATH
  mockIsTauri.mockReturnValue(false)
})

describe("configureMonacoLoader", () => {
  it("points the loader at /monaco/vs in Tauri runtime", async () => {
    mockIsTauri.mockReturnValue(true)
    const { configureMonacoLoader } = await import("./monaco-loader")
    configureMonacoLoader()
    expect(mockConfig).toHaveBeenCalledWith({ paths: { vs: "/monaco/vs" } })
  })

  it("respects NEXT_PUBLIC_MONACO_VS_PATH override in web mode", async () => {
    process.env.NEXT_PUBLIC_MONACO_VS_PATH = "/custom/vs"
    const { configureMonacoLoader } = await import("./monaco-loader")
    configureMonacoLoader()
    expect(mockConfig).toHaveBeenCalledWith({ paths: { vs: "/custom/vs" } })
  })

  it("does not call loader.config when no override is present (web default)", async () => {
    const { configureMonacoLoader } = await import("./monaco-loader")
    configureMonacoLoader()
    expect(mockConfig).not.toHaveBeenCalled()
  })

  it("is idempotent — second call is a no-op", async () => {
    mockIsTauri.mockReturnValue(true)
    const { configureMonacoLoader } = await import("./monaco-loader")
    configureMonacoLoader()
    configureMonacoLoader()
    expect(mockConfig).toHaveBeenCalledTimes(1)
  })

  // The no-window (SSR) branch lives in `monaco-loader.ssr.test.ts` — jsdom's
  // `window` is non-configurable from Node 26 on and cannot be deleted.

  it("survives when process is undefined (browser-only env)", async () => {
    const originalProcess = global.process
    // @ts-expect-error -- simulate browser-only runtime where process is missing
    delete global.process
    try {
      const { configureMonacoLoader } = await import("./monaco-loader")
      configureMonacoLoader()
      // No override path, no Tauri -> nothing called.
      expect(mockConfig).not.toHaveBeenCalled()
    } finally {
      global.process = originalProcess
    }
  })
})

describe("loadConfiguredMonaco", () => {
  it("configures local Tauri assets before initializing Monaco", async () => {
    const monaco = { languages: {}, editor: {} }
    mockIsTauri.mockReturnValue(true)
    mockInit.mockResolvedValue(monaco)
    const { loadConfiguredMonaco } = await import("./monaco-loader")

    await expect(loadConfiguredMonaco()).resolves.toBe(monaco)
    expect(mockConfig).toHaveBeenCalledWith({ paths: { vs: "/monaco/vs" } })
    expect(mockConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mockInit.mock.invocationCallOrder[0]
    )
  })
})
