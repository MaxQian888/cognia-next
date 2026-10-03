jest.mock("@/lib/files/workspace-fs", () => ({
  statWorkspaceFile: jest.fn(),
  walkWorkspace: jest.fn(),
}))
jest.mock("@/stores/plugin-runtime", () => ({
  usePluginStore: { getState: jest.fn(() => ({ plugins: {} })), subscribe: jest.fn() },
}))
jest.mock("./monaco-bridge", () => ({ getEditorById: jest.fn(), onEditorChange: jest.fn() }))
jest.mock("./vscode-log-buffer", () => ({ appendVscodeLog: jest.fn() }))
const mockManager = {
  getPluginLifecycleState: jest.fn(async () => ({ intent: "enabled" })),
  handleActivationEvent: jest.fn(async () => {}),
}
jest.mock("@/lib/plugin/core/manager", () => ({ getPluginManager: () => mockManager }))
jest.mock("@/lib/boot/capabilities", () => ({
  getBootProfile: () => "main",
  ensureBootCapability: jest.fn(async () => {}),
}))

import { statWorkspaceFile, walkWorkspace } from "@/lib/files/workspace-fs"
import {
  __resetCommandRegistryForTesting,
  executeCommand,
  getCommand,
  registerCommand,
  type CommandRegistration,
} from "@/lib/plugin/commands/registry"
import { __resetLanguagesForTesting, listLanguages } from "@/lib/plugin/bridge/languages-bridge"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginManifest, PluginStatus } from "@/types/plugin/plugin"

import {
  __settleVscodeActivationTriggers,
  createVscodeActivationTriggerDependencies,
  installVscodeActivationTriggers,
  uninstallVscodeActivationTriggers,
  type ActivationTriggerPlugin,
  type VscodeActivationTriggerDependencies,
} from "./activation-triggers"
import { getEditorById, onEditorChange } from "./monaco-bridge"
import { appendVscodeLog } from "./vscode-log-buffer"

function extension(
  id: string,
  status: PluginStatus,
  overrides: Partial<PluginManifest> = {},
  planned = true
): ActivationTriggerPlugin {
  return {
    status,
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      description: "",
      type: "vscode-extension",
      capabilities: [],
      author: { name: "acme" },
      activationEvents: [],
      vscodeExtension: {
        identifier: id,
        version: "1.0.0",
        engineVscode: "^1.91.0",
        vsixSha256: "0",
        source: "openvsx",
        bundleFormat: "cjs",
        activationEvents: [],
        ...(planned ? { activationPlanned: true as const } : {}),
      },
      ...overrides,
    } as PluginManifest,
  }
}

function withCommands(id: string, status: PluginStatus) {
  return extension(id, status, {
    activationEvents: ["onCommand:acme.run"],
    vscodeExtension: {
      ...extension(id, status).manifest.vscodeExtension!,
      commands: [
        { command: "acme.run", title: "Run", category: "Acme", when: "editorFocus" },
        { command: "acme.stop", title: "Stop" },
      ],
    },
  })
}

function setup(
  initial: ActivationTriggerPlugin[],
  overrides: Partial<VscodeActivationTriggerDependencies> = {}
) {
  let plugins = initial
  const pluginListeners = new Set<() => void>()
  const folderListeners = new Set<() => void>()
  const languageListeners = new Set<(id: string) => void>()
  let folders: string[] = []
  const registered: Record<string, string[]> = {}
  const unregistered: string[] = []
  const activated: string[] = []
  const deps: VscodeActivationTriggerDependencies = {
    plugins: () => plugins,
    subscribePlugins: (listener) => {
      pluginListeners.add(listener)
      return () => pluginListeners.delete(listener)
    },
    wantsEnabled: async () => true,
    activate: async (event) => {
      activated.push(event)
    },
    commands: {
      register: registerCommand,
      get: getCommand,
      waitFor: async () => {},
    },
    languages: {
      register: (pluginId, languages) => {
        registered[pluginId] = languages.map((language) => language.id)
      },
      unregister: (pluginId) => {
        unregistered.push(pluginId)
      },
    },
    onEditorLanguage: (listener) => {
      languageListeners.add(listener)
      return () => languageListeners.delete(listener)
    },
    folders: () => folders,
    onFoldersChanged: (listener) => {
      folderListeners.add(listener)
      return () => folderListeners.delete(listener)
    },
    exists: async () => false,
    walk: async () => ({ files: [], truncated: false }),
    log: jest.fn(),
    ...overrides,
  }
  installVscodeActivationTriggers(deps)
  return {
    deps,
    activated,
    registered,
    unregistered,
    setPlugins: async (next: ActivationTriggerPlugin[]) => {
      plugins = next
      pluginListeners.forEach((listener) => listener())
      await __settleVscodeActivationTriggers()
    },
    setFolders: async (next: string[]) => {
      folders = next
      folderListeners.forEach((listener) => listener())
      await __settleVscodeActivationTriggers()
    },
    openDocument: (languageId: string) =>
      languageListeners.forEach((listener) => listener(languageId)),
  }
}

beforeEach(() => {
  __resetCommandRegistryForTesting()
})

afterEach(() => {
  uninstallVscodeActivationTriggers()
})

describe("contributed commands of a dormant extension", () => {
  it("are listed with their title, category and when clause", async () => {
    setup([withCommands("acme.ext", "installed")])
    await __settleVscodeActivationTriggers()
    expect(getCommand("acme.run")).toMatchObject({
      pluginId: "acme.ext",
      title: "Run",
      category: "Acme",
      when: "editorFocus",
    })
    expect(getCommand("acme.stop")).toMatchObject({ title: "Stop" })
    expect(getCommand("acme.stop")?.category).toBeUndefined()
  })

  it("start the extension when run, then run the command it registered", async () => {
    const real = jest.fn((...args: unknown[]) => `ran ${args.join(",")}`)
    const env = setup([withCommands("acme.ext", "installed")], {
      activate: async (event) => {
        env.activated.push(event)
        // Starting takes the placeholder down; the extension registers its own.
        await env.setPlugins([withCommands("acme.ext", "enabled")])
        registerCommand({ id: "acme.run", pluginId: "acme.ext", handler: real })
      },
    })
    await __settleVscodeActivationTriggers()
    await expect(executeCommand("acme.run", 1, 2)).resolves.toBe("ran 1,2")
    expect(env.activated).toEqual(["onCommand:acme.run"])
    expect(real).toHaveBeenCalledWith(1, 2)
  })

  it("fail plainly when the started extension never registers the command", async () => {
    setup([withCommands("acme.ext", "installed")])
    await __settleVscodeActivationTriggers()
    await expect(executeCommand("acme.stop")).rejects.toThrow(
      "VS Code extension acme.ext did not register the command acme.stop when it started"
    )
  })

  it("give way to the extension's own once it starts, and come back when it is suspended", async () => {
    const env = setup([withCommands("acme.ext", "installed")])
    await __settleVscodeActivationTriggers()
    const placeholder = getCommand("acme.run")!.handler
    await env.setPlugins([withCommands("acme.ext", "loading")])
    expect(getCommand("acme.run")).toBeUndefined()
    const own: CommandRegistration = { id: "acme.run", pluginId: "acme.ext", handler: jest.fn() }
    registerCommand(own)
    await env.setPlugins([withCommands("acme.ext", "enabled")])
    expect(getCommand("acme.run")?.handler).toBe(own.handler)
    // Suspending takes the extension's commands down; the placeholders return.
    __resetCommandRegistryForTesting()
    await env.setPlugins([withCommands("acme.ext", "suspended")])
    expect(getCommand("acme.run")?.handler).not.toBe(placeholder)
    expect(getCommand("acme.run")?.title).toBe("Run")
  })

  it("leave a command another plugin owns alone", async () => {
    const other = jest.fn()
    registerCommand({ id: "acme.run", pluginId: "other", handler: other })
    setup([withCommands("acme.ext", "installed")])
    await __settleVscodeActivationTriggers()
    expect(getCommand("acme.run")?.handler).toBe(other)
  })

  it("are not shown for a disabled extension, a running one, or one installed before planning", async () => {
    setup([withCommands("acme.off", "disabled"), withCommands("acme.on", "enabled")], {
      wantsEnabled: async (pluginId) => pluginId !== "acme.off",
    })
    await __settleVscodeActivationTriggers()
    expect(getCommand("acme.run")).toBeUndefined()
    uninstallVscodeActivationTriggers()
    const legacy = withCommands("acme.legacy", "installed")
    delete legacy.manifest.vscodeExtension!.activationPlanned
    setup([legacy])
    await __settleVscodeActivationTriggers()
    expect(getCommand("acme.run")).toBeUndefined()
  })

  it("are taken down when the triggers stop", async () => {
    setup([withCommands("acme.ext", "installed")])
    await __settleVscodeActivationTriggers()
    uninstallVscodeActivationTriggers()
    expect(getCommand("acme.run")).toBeUndefined()
  })
})

describe("contributed languages of a dormant extension", () => {
  it("are registered while it is dormant and released when it starts", async () => {
    const lang = extension("acme.lang", "installed", {
      vscodeLanguages: [{ id: "acmelang", extensions: [".acme"] }],
    })
    const env = setup([lang])
    await __settleVscodeActivationTriggers()
    expect(env.registered).toEqual({ "acme.lang": ["acmelang"] })
    await env.setPlugins([{ ...lang, status: "enabling" }])
    expect(env.unregistered).toEqual(["acme.lang"])
  })
})

describe("onLanguage", () => {
  it("fires when an editor opens a document of a language a dormant plugin waits for", async () => {
    const env = setup([
      extension("acme.py", "installed", { activationEvents: ["onLanguage:python"] }),
    ])
    await __settleVscodeActivationTriggers()
    env.openDocument("rust")
    env.openDocument("python")
    expect(env.activated).toEqual(["onLanguage:python"])
  })

  it("does not fire when no dormant plugin waits for the language", async () => {
    const env = setup([
      extension("acme.py", "enabled", { activationEvents: ["onLanguage:python"] }),
    ])
    await __settleVscodeActivationTriggers()
    env.openDocument("python")
    expect(env.activated).toEqual([])
  })
})

describe("workspaceContains", () => {
  const watcher = (status: PluginStatus = "installed") =>
    extension("acme.ws", status, {
      activationEvents: ["workspaceContains:**/pyproject.toml", "workspaceContains:setup.cfg"],
    })

  it("starts the extension when an open folder holds a matching file", async () => {
    const walk = jest.fn(async () => ({
      files: ["src/app.py", "pkg/pyproject.toml"],
      truncated: false,
    }))
    const env = setup([watcher()], { walk })
    await __settleVscodeActivationTriggers()
    expect(env.activated).toEqual([])
    await env.setFolders(["/repo"])
    expect(walk).toHaveBeenCalledWith("/repo", 50_000)
    expect(env.activated).toEqual(["workspaceContains:acme.ws"])
  })

  it("checks a literal path directly", async () => {
    const exists = jest.fn(async (_root: string, path: string) => path === "setup.cfg")
    const walk = jest.fn(async () => ({ files: [], truncated: false }))
    const env = setup([watcher()], { exists, walk })
    await env.setFolders(["/repo"])
    expect(exists).toHaveBeenCalledWith("/repo", "setup.cfg")
    expect(walk).not.toHaveBeenCalled()
    expect(env.activated).toEqual(["workspaceContains:acme.ws"])
  })

  it("ignores matches under excluded folders, logs a cut-short search, and checks each folder set once", async () => {
    const walk = jest.fn(async () => ({
      files: ["node_modules/x/pyproject.toml", ".git/pyproject.toml"],
      truncated: true,
    }))
    const env = setup([watcher()], { walk })
    await env.setFolders(["/repo"])
    expect(env.activated).toEqual([])
    expect(env.deps.log).toHaveBeenCalledWith(
      "acme.ws",
      "warn",
      "workspaceContains: searched only the first 50000 files of /repo"
    )
    await env.setPlugins([watcher()])
    expect(walk).toHaveBeenCalledTimes(1)
  })

  it("logs a failed search", async () => {
    const env = setup([watcher()], {
      walk: async () => {
        throw new Error("denied")
      },
    })
    await env.setFolders(["/repo"])
    expect(env.deps.log).toHaveBeenCalledWith(
      "acme.ws",
      "warn",
      "workspaceContains: could not search the open folders: denied"
    )
  })
})

describe("createVscodeActivationTriggerDependencies", () => {
  beforeEach(() => {
    __resetLanguagesForTesting()
  })

  it("reads plugins from the store and hears only plugin changes", () => {
    const deps = createVscodeActivationTriggerDependencies()
    const plugin = withCommands("acme.ext", "installed")
    jest.mocked(usePluginStore.getState).mockReturnValue({
      plugins: { "acme.ext": plugin },
    } as never)
    expect(deps.plugins()).toEqual([plugin])
    let storeListener!: (state: unknown, previous: unknown) => void
    jest.mocked(usePluginStore.subscribe).mockImplementation(((listener: typeof storeListener) => {
      storeListener = listener
      return () => {}
    }) as never)
    const listener = jest.fn()
    deps.subscribePlugins(listener)
    const plugins = {}
    storeListener({ plugins }, { plugins })
    storeListener({ plugins: {} }, { plugins })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("reads the intent and fires events through the plugin manager", async () => {
    const deps = createVscodeActivationTriggerDependencies()
    expect(await deps.wantsEnabled("acme.ext")).toBe(true)
    mockManager.getPluginLifecycleState.mockResolvedValueOnce({ intent: "disabled" })
    expect(await deps.wantsEnabled("acme.ext")).toBe(false)
    await deps.activate("onLanguage:python")
    expect(mockManager.handleActivationEvent).toHaveBeenCalledWith("onLanguage:python")
  })

  it("waits for a command to be registered by someone else, or gives up", async () => {
    const deps = createVscodeActivationTriggerDependencies()
    const placeholder = jest.fn()
    registerCommand({ id: "acme.run", pluginId: "acme.ext", handler: placeholder })
    const waiting = deps.commands.waitFor("acme.run", placeholder, 1_000)
    registerCommand({ id: "acme.run", pluginId: "acme.ext", handler: jest.fn() })
    await expect(waiting).resolves.toBeUndefined()
    jest.useFakeTimers()
    try {
      const timedOut = deps.commands.waitFor("acme.none", placeholder, 1_000)
      jest.advanceTimersByTime(1_000)
      await expect(timedOut).resolves.toBeUndefined()
    } finally {
      jest.useRealTimers()
    }
  })

  it("registers and releases languages through the languages bridge", () => {
    const deps = createVscodeActivationTriggerDependencies()
    deps.languages.register("acme.lang", [{ id: "acmelang", extensions: [".acme"] }])
    expect(listLanguages().map((language) => language.id)).toEqual(["acmelang"])
    deps.languages.unregister("acme.lang")
    expect(listLanguages()).toEqual([])
  })

  it("reports the language of documents editors open or relabel", () => {
    const deps = createVscodeActivationTriggerDependencies()
    let editorListener!: (event: { editorId: string; uri: string; kind: string }) => void
    jest.mocked(onEditorChange).mockImplementation(((listener: typeof editorListener) => {
      editorListener = listener
      return () => {}
    }) as never)
    jest.mocked(getEditorById).mockReturnValue({
      getModel: () => ({ language: "python" }),
    } as never)
    const listener = jest.fn()
    deps.onEditorLanguage(listener)
    editorListener({ editorId: "e1", uri: "file:///a.py", kind: "open" })
    editorListener({ editorId: "e1", uri: "file:///a.py", kind: "change-content" })
    editorListener({ editorId: "e1", uri: "file:///a.py", kind: "change-language" })
    expect(listener.mock.calls).toEqual([["python"], ["python"]])
  })

  it("checks paths and walks folders through the workspace file system", async () => {
    const deps = createVscodeActivationTriggerDependencies()
    jest.mocked(statWorkspaceFile).mockResolvedValue({ exists: true } as never)
    expect(await deps.exists("/repo", "setup.cfg")).toBe(true)
    expect(statWorkspaceFile).toHaveBeenCalledWith("/repo", "setup.cfg")
    jest.mocked(walkWorkspace).mockResolvedValue({
      entries: [
        { relPath: "src", absolutePath: "/repo/src", isDir: true, size: 0, mtimeMs: null },
        {
          relPath: "src/a.py",
          absolutePath: "/repo/src/a.py",
          isDir: false,
          size: 1,
          mtimeMs: null,
        },
      ],
      truncated: false,
      skippedSensitive: 0,
    })
    expect(await deps.walk("/repo", 10)).toEqual({ files: ["src/a.py"], truncated: false })
    expect(walkWorkspace).toHaveBeenCalledWith("/repo", { maxEntries: 10 })
    deps.log("acme.ext", "warn", "hello")
    expect(appendVscodeLog).toHaveBeenCalledWith("acme.ext", {
      level: "warn",
      kind: "activation",
      message: "hello",
    })
  })
})
