// SSR guard for the Monaco loader, split out of `monaco-loader.test.ts`: that
// file is jsdom-docblocked, and from Node 26 on jsdom's `window` is
// non-configurable, so `delete global.window` throws. This file runs in the
// `node` project, where there is genuinely no window.

// `export {}` makes this a module: `monaco-loader.test.ts` has no imports either,
// so without it TS treats both files as global scripts and the identically-named
// mock consts collide (TS2451).
export {}

const mockConfig = jest.fn()
const mockIsTauri = jest.fn(() => true)

jest.mock("@monaco-editor/react", () => ({
  __esModule: true,
  loader: {
    config: (...args: unknown[]) => mockConfig(...args),
  },
}))

jest.mock("@/lib/tauri", () => ({
  __esModule: true,
  isTauri: () => mockIsTauri(),
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.resetModules()
})

describe("configureMonacoLoader — no window (SSR)", () => {
  it("has no window to begin with", () => {
    expect(typeof window).toBe("undefined")
  })

  it("returns early without configuring the loader, even in Tauri mode", async () => {
    // isTauri() is true here, so only the window guard can suppress the call.
    const { configureMonacoLoader } = await import("./monaco-loader")
    configureMonacoLoader()
    expect(mockConfig).not.toHaveBeenCalled()
  })
})
