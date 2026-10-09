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

jest.mock("@/lib/platform/detect", () => ({
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

  it("leaves a loader without init alone instead of throwing", async () => {
    jest.doMock("@monaco-editor/react", () => ({ __esModule: true, loader: undefined }))
    const { configureMonacoLoader } = await import("./monaco-loader")
    expect(() => configureMonacoLoader()).not.toThrow()
    // Back to this file's loader mock for the tests that follow.
    jest.doMock("@monaco-editor/react", () => ({
      __esModule: true,
      loader: {
        config: (...args: unknown[]) => mockConfig(...args),
        init: (...args: unknown[]) => mockInit(...args),
      },
    }))
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

function makeMonaco() {
  const dispose = jest.fn()
  const create = jest.fn((..._args: unknown[]) => ({ dispose }))
  return { monaco: { languages: {}, editor: { create } }, create, dispose }
}

/** A cancelable promise shaped like `@monaco-editor/loader`'s `makeCancelable`. */
function cancelable<T>(value: T) {
  const promise = Promise.resolve(value) as Promise<T> & { cancel: jest.Mock }
  promise.cancel = jest.fn()
  return promise
}

describe("configureMonacoLoader — service overrides", () => {
  it("installs the clipboard override before any loader.init caller continues", async () => {
    const { monaco, create, dispose } = makeMonaco()
    mockInit.mockReturnValue(cancelable(monaco))
    const { configureMonacoLoader } = await import("./monaco-loader")
    const { CogniaMonacoClipboardService } = await import("./monaco-clipboard-service")
    const { loader } = jest.requireMock<{ loader: { init: () => Promise<unknown> } }>(
      "@monaco-editor/react"
    )
    configureMonacoLoader()

    // `<Editor>` calls loader.init directly — it must get the wrapped init.
    const seen = await loader.init().then((m) => {
      expect(create).toHaveBeenCalledTimes(1)
      return m
    })
    expect(seen).toBe(monaco)
    const [host, options, overrides] = create.mock.calls[0] as [
      HTMLElement,
      unknown,
      { clipboardService: unknown },
    ]
    // A detached throwaway editor: never attached, disposed at once.
    expect(host.isConnected).toBe(false)
    expect(options).toEqual({})
    expect(overrides.clipboardService).toBeInstanceOf(CogniaMonacoClipboardService)
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it("installs the overrides once per Monaco instance", async () => {
    const { monaco, create } = makeMonaco()
    mockInit.mockImplementation(() => cancelable(monaco))
    const { configureMonacoLoader, loadConfiguredMonaco } = await import("./monaco-loader")
    configureMonacoLoader()
    await loadConfiguredMonaco()
    await loadConfiguredMonaco()
    expect(create).toHaveBeenCalledTimes(1)
  })

  it("carries the cancel handle <Editor> calls on unmount", async () => {
    const { monaco } = makeMonaco()
    const inner = cancelable(monaco)
    mockInit.mockReturnValue(inner)
    const { configureMonacoLoader } = await import("./monaco-loader")
    const { loader } = jest.requireMock<{
      loader: { init: () => Promise<unknown> & { cancel: () => void } }
    }>("@monaco-editor/react")
    configureMonacoLoader()

    const outer = loader.init()
    outer.cancel()
    expect(inner.cancel).toHaveBeenCalledTimes(1)
    await outer
  })

  it("marks every later editor and diff-editor container .monaco-component", async () => {
    const { monaco, create } = makeMonaco()
    const editorListeners: Array<(e: { getContainerDomNode(): HTMLElement }) => void> = []
    const diffListeners: typeof editorListeners = []
    const withEvents = {
      ...monaco,
      editor: {
        ...monaco.editor,
        onDidCreateEditor: (l: (typeof editorListeners)[number]) => editorListeners.push(l),
        onDidCreateDiffEditor: (l: (typeof editorListeners)[number]) => diffListeners.push(l),
      },
    }
    mockInit.mockReturnValue(cancelable(withEvents))
    const { loadConfiguredMonaco } = await import("./monaco-loader")
    await loadConfiguredMonaco()

    // Installed after the detached throwaway editor, which is never themed.
    expect(create).toHaveBeenCalledTimes(1)
    expect(editorListeners).toHaveLength(1)
    expect(diffListeners).toHaveLength(1)
    const container = document.createElement("div")
    const diffContainer = document.createElement("div")
    editorListeners[0]({ getContainerDomNode: () => container })
    diffListeners[0]({ getContainerDomNode: () => diffContainer })
    // The context menu's shadow host lands in the container; the theme
    // variables are only declared on `.monaco-component` and friends.
    expect(container).toHaveClass("monaco-component")
    expect(diffContainer).toHaveClass("monaco-component")

    // Once per instance.
    await loadConfiguredMonaco()
    expect(editorListeners).toHaveLength(1)
  })

  it("tolerates an editor whose container is unavailable", async () => {
    const { monaco } = makeMonaco()
    let listener: ((e: { getContainerDomNode(): HTMLElement }) => void) | undefined
    mockInit.mockReturnValue(
      cancelable({
        ...monaco,
        editor: { ...monaco.editor, onDidCreateEditor: (l: typeof listener) => (listener = l) },
      })
    )
    const { loadConfiguredMonaco } = await import("./monaco-loader")
    await loadConfiguredMonaco()
    expect(() =>
      listener!({
        getContainerDomNode: () => {
          throw new Error("disposed")
        },
      })
    ).not.toThrow()
  })

  it("fails open when the detached editor cannot be created", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const monaco = {
      editor: {
        create: jest.fn(() => {
          throw new Error("no dom")
        }),
      },
    }
    mockInit.mockReturnValue(cancelable(monaco))
    const { loadConfiguredMonaco } = await import("./monaco-loader")

    await expect(loadConfiguredMonaco()).resolves.toBe(monaco)
    expect(warn).toHaveBeenCalledWith("[monaco] service overrides not installed", expect.any(Error))
    warn.mockRestore()
  })
})

describe("loadConfiguredMonaco", () => {
  it("configures local Tauri assets before initializing Monaco", async () => {
    const { monaco } = makeMonaco()
    mockIsTauri.mockReturnValue(true)
    mockInit.mockReturnValue(cancelable(monaco))
    const { loadConfiguredMonaco } = await import("./monaco-loader")

    await expect(loadConfiguredMonaco()).resolves.toBe(monaco)
    expect(mockConfig).toHaveBeenCalledWith({ paths: { vs: "/monaco/vs" } })
    expect(mockConfig.mock.invocationCallOrder[0]).toBeLessThan(
      mockInit.mock.invocationCallOrder[0]
    )
  })
})
