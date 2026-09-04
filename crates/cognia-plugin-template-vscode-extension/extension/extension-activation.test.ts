/**
 * The scaffold must activate cleanly against the Host the CLI hands it to.
 *
 * The shim exposes the whole `vscode` surface, but the Host answers only the
 * calls it has a canonical adapter for. Everything named in
 * `EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS` gets a deterministic capability
 * error, and several shim builders send their request with a bare `void`
 * (`buildOutputChannel` / `buildStatusBarItem` in
 * `sidecar/vscode-ext-host/src/vscode-shim/window.ts`), so calling one does
 * not merely do nothing — it raises an unhandled rejection inside the
 * extension host. The scaffold shipped `createOutputChannel`,
 * `createStatusBarItem` and `showInformationMessage`: three unavailable
 * methods, on the very first thing a plugin author runs.
 *
 * This drives the REAL scaffold — `require`d off disk, the same bytes
 * `cognia plugin new --kind vscode` writes — through a `vscode` double that
 * refuses exactly what the Host refuses, and asserts the activation is clean.
 */

import { EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS } from "@/lib/plugin/vscode-shim/runtime-handlers"

/**
 * How each `vscode` API this double implements reaches the Host.
 *
 * Read off the sidecar shim (`sidecar/vscode-ext-host/src/vscode-shim/`), and
 * checked against the Host's own unavailable list below rather than hand-kept:
 * the day an adapter lands, the entry stops being refused here too.
 */
const API_RPC_METHOD = {
  "commands.registerCommand": "commands:register",
  "languages.registerCompletionItemProvider": "languages:register",
  "window.createOutputChannel": "window:createOutputChannel",
  "window.createStatusBarItem": "window:createStatusBarItem",
  "window.showInformationMessage": "window:showMessage",
  "workspace.getConfiguration.get": "workspace:configurationGet",
  "workspace.onDidSaveTextDocument": "workspace:documentSaved",
} as const

const UNAVAILABLE = new Set<string>(EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS)

interface Disposable {
  dispose: () => void
}

interface ActivationSummary {
  registeredCommands: string[]
  registeredWebviewViews: string[]
  registeredLanguageProviders: string[]
}

interface ScaffoldModule {
  activate: (context: { subscriptions: Disposable[] }) => ActivationSummary
  deactivate: () => void
}

interface VscodeDouble {
  reached: string[]
  commands: Map<string, (...args: unknown[]) => unknown>
  completionProviders: unknown[]
  module: Record<string, unknown>
}

/**
 * A `vscode` double whose every entry point records the Host method it would
 * reach, and refuses the ones the Host refuses — the way the sidecar does.
 *
 * `getConfiguration().get()` is the one deliberate exception: its RPC IS
 * unavailable, but the shim wraps the request in `.catch()` and answers with
 * the caller's default synchronously, so depending on it is safe and the
 * template's note 1 documents exactly that.
 */
function createVscodeDouble(): VscodeDouble {
  const reached: string[] = []
  const commands = new Map<string, (...args: unknown[]) => unknown>()
  const completionProviders: unknown[] = []

  const call = (api: keyof typeof API_RPC_METHOD): void => {
    const method = API_RPC_METHOD[api]
    reached.push(method)
    if (UNAVAILABLE.has(method)) {
      throw new Error(`VS Code RPC ${method} is unavailable on this host`)
    }
  }
  const disposable = (): Disposable => ({ dispose: () => {} })

  return {
    reached,
    commands,
    completionProviders,
    module: {
      commands: {
        registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
          call("commands.registerCommand")
          commands.set(id, handler)
          return disposable()
        },
      },
      languages: {
        registerCompletionItemProvider(
          selector: unknown,
          provider: unknown,
          ...triggers: string[]
        ) {
          call("languages.registerCompletionItemProvider")
          completionProviders.push({ selector, provider, triggers })
          return disposable()
        },
      },
      window: {
        createOutputChannel(name: string) {
          call("window.createOutputChannel")
          return { name, appendLine: () => {}, dispose: () => {} }
        },
        createStatusBarItem(alignment?: number, priority?: number) {
          call("window.createStatusBarItem")
          return { alignment, priority, show: () => {}, dispose: () => {} }
        },
        async showInformationMessage(message: string) {
          call("window.showInformationMessage")
          return message
        },
      },
      workspace: {
        getConfiguration(section: string) {
          return {
            section,
            get<T>(_key: string, defaultValue: T): T {
              // Records the reach but never throws: the shim `.catch()`es this
              // one and answers with the default (template note 1).
              reached.push(API_RPC_METHOD["workspace.getConfiguration.get"])
              return defaultValue
            },
          }
        },
        onDidSaveTextDocument(listener: (event: unknown) => void) {
          call("workspace.onDidSaveTextDocument")
          void listener
          return disposable()
        },
      },
    },
  }
}

/**
 * The sidecar resolves the bare specifier `vscode` to its shim through a
 * require hook; this virtual mock stands in for that.
 *
 * The exposed module is a stable facade of getters rather than the double
 * itself, because Jest memoizes a mock factory's RESULT and `isolateModules`
 * does not clear it — handing the factory a fresh object per test silently
 * left the scaffold talking to the first test's double. `mock`-prefixed so
 * babel-plugin-jest-hoist lets the factory close over it.
 */
const mockVscodeState: { current: VscodeDouble } = { current: createVscodeDouble() }
jest.mock(
  "vscode",
  () => ({
    get commands() {
      return mockVscodeState.current.module.commands
    },
    get languages() {
      return mockVscodeState.current.module.languages
    },
    get window() {
      return mockVscodeState.current.module.window
    },
    get workspace() {
      return mockVscodeState.current.module.workspace
    },
  }),
  { virtual: true }
)

/** Re-`require` the real emitted scaffold, fresh, against the current double. */
function loadScaffold(): ScaffoldModule {
  let scaffold!: ScaffoldModule
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    scaffold = require("./out/extension.js") as ScaffoldModule
  })
  return scaffold
}

describe("the emitted VS Code scaffold", () => {
  let rejections: unknown[]
  let onRejection: (reason: unknown) => void
  let logSpy: jest.SpyInstance
  let stdoutSpy: jest.SpyInstance

  beforeEach(() => {
    mockVscodeState.current = createVscodeDouble()
    rejections = []
    onRejection = (reason) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    logSpy = jest.spyOn(console, "error").mockImplementation(() => {})
    stdoutSpy = jest.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    process.off("unhandledRejection", onRejection)
    logSpy.mockRestore()
    stdoutSpy.mockRestore()
  })

  it("activates without reaching a single method the Host refuses", async () => {
    const double = mockVscodeState.current
    const scaffold = loadScaffold()
    const context = { subscriptions: [] as Disposable[] }

    const summary = scaffold.activate(context)

    // Give any floating promise a turn to reject before the assertion.
    await new Promise((resolve) => setImmediate(resolve))

    const refused = double.reached.filter(
      (method) => UNAVAILABLE.has(method) && method !== "workspace:configurationGet"
    )
    expect(refused).toEqual([])
    expect(rejections).toEqual([])
    expect(summary).toEqual({
      registeredCommands: ["cogniaPluginTemplate.hello"],
      registeredWebviewViews: [],
      registeredLanguageProviders: ["cogniaPluginTemplate.completion"],
    })
  })

  it("registers the command package.json contributes, and a markdown completion provider", () => {
    const double = mockVscodeState.current
    const scaffold = loadScaffold()

    scaffold.activate({ subscriptions: [] })

    expect([...double.commands.keys()]).toEqual(["cogniaPluginTemplate.hello"])
    expect(double.completionProviders).toEqual([
      {
        selector: { scheme: "file", language: "markdown" },
        provider: expect.objectContaining({ provideCompletionItems: expect.any(Function) }),
        triggers: [":"],
      },
    ])
  })

  it("disposes everything it registered through context.subscriptions", () => {
    const scaffold = loadScaffold()
    const context = { subscriptions: [] as Disposable[] }

    scaffold.activate(context)

    expect(context.subscriptions).toHaveLength(2)
    expect(() => {
      for (const item of context.subscriptions) item.dispose()
    }).not.toThrow()
    expect(() => scaffold.deactivate()).not.toThrow()
  })

  it("runs its command without throwing, and answers with the configured greeting", () => {
    const double = mockVscodeState.current
    const scaffold = loadScaffold()
    scaffold.activate({ subscriptions: [] })

    const handler = double.commands.get("cogniaPluginTemplate.hello")!
    expect(handler()).toEqual({ greeting: "Hello" })
    expect(rejections).toEqual([])
  })

  it("never writes to stdout, which the host process uses for JSON-RPC frames", () => {
    const double = mockVscodeState.current
    const scaffold = loadScaffold()

    scaffold.activate({ subscriptions: [] })
    double.commands.get("cogniaPluginTemplate.hello")!()

    expect(stdoutSpy).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalled()
  })

  it("pins the three surfaces the Host refuses, so a re-add is caught here", () => {
    // Not a restatement of the list: these are the exact methods the scaffold
    // used to reach, and the reason the very first plugin an author generated
    // logged capability errors and an unhandled rejection on activation.
    expect(UNAVAILABLE.has("window:createOutputChannel")).toBe(true)
    expect(UNAVAILABLE.has("window:createStatusBarItem")).toBe(true)
    expect(UNAVAILABLE.has("window:showMessage")).toBe(true)
  })
})
