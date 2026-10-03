type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

const mockWalk = jest.fn()
const mockRoots = jest.fn(async () => [{ path: "/host-root", source: "desktop-project" }])
jest.mock("@/lib/files/workspace-fs", () => ({
  listWorkspaceRoots: () => mockRoots(),
  walkWorkspace: (...args: unknown[]) => mockWalk(...args),
}))
jest.mock("@/lib/plugin/core/transport", () => ({
  listPluginPermissions: async () => ["filesystem:read"],
}))

import type { WorkspaceFsChange } from "@/lib/files/workspace-watch"

import {
  __resetVscodeWorkspaceFilesForTesting,
  activeWatcherHandles,
  clearVscodeWorkspaceFilesForPlugin,
  configureVscodeWorkspaceFiles,
  createVscodeWorkspaceFilesDependencies,
  FIND_FILES_WALK_LIMIT,
  installVscodeWorkspaceFileHandlers,
  pushWorkspaceFolders,
  WATCH_BATCH_MS,
  type Folder,
  type VscodeWorkspaceFilesDependencies,
} from "./workspace-file-handlers"

const REPO: Folder = { uri: "file:///repo", name: "repo", path: "/repo" }
const OTHER: Folder = { uri: "file:///other", name: "other", path: "/other" }

function setup(options: { granted?: string[]; files?: Record<string, string[]> } = {}) {
  let folders: Folder[] = [REPO]
  let foldersChanged: () => void = () => {}
  const sent: Array<[string, string, unknown]> = []
  const listeners = new Map<string, Set<(change: WorkspaceFsChange) => void>>()
  /** Fire a change at every listener on a folder, as the shared root watch does. */
  const watches = {
    get: (root: string) =>
      listeners.has(root)
        ? (change: WorkspaceFsChange) =>
            listeners.get(root)!.forEach((listener) => listener(change))
        : undefined,
    keys: () => listeners.keys(),
  }
  const stopped: string[] = []
  const files = options.files ?? {
    "/repo": [
      "/repo/src/a.ts",
      "/repo/src/b.js",
      "/repo/src/deep/c.ts",
      "/repo/.git/HEAD",
      "/repo/node_modules/x/index.ts",
    ],
    "/other": ["/other/z.ts"],
  }
  const deps: VscodeWorkspaceFilesDependencies = {
    folders: () => folders,
    onFoldersChanged: (listener) => {
      foldersChanged = listener
      return () => {}
    },
    extraRoots: async () => ["/host-root"],
    permissions: async () => options.granted ?? ["filesystem:read"],
    walk: jest.fn(async (root: string, walkOptions: { relPath?: string }) => ({
      files: (files[root] ?? []).filter(
        (file) => !walkOptions.relPath || file.startsWith(`${root}/${walkOptions.relPath}/`)
      ),
      truncated: false,
      skippedSensitive: 0,
    })),
    watch: (root, listener) => {
      const set = listeners.get(root) ?? new Set()
      set.add(listener)
      listeners.set(root, set)
      return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(root)
        stopped.push(root)
      }
    },
    sendToHost: jest.fn(async (pluginId: string, method: string, payload: unknown) => {
      sent.push([pluginId, method, payload])
      return null
    }),
    hosts: () => ["ext.a", "ext.b"],
  }
  configureVscodeWorkspaceFiles(deps)
  const call = (method: string, payload: unknown, pluginId = "ext.a") =>
    handlers.get(method)!(payload, { pluginId, method, requestId: null })
  return {
    deps,
    sent,
    watches,
    stopped,
    call,
    setFolders(next: Folder[]) {
      folders = next
      foldersChanged()
    },
  }
}

beforeEach(() => {
  handlers.clear()
  mockLog.mockClear()
  __resetVscodeWorkspaceFilesForTesting()
  installVscodeWorkspaceFileHandlers()
})

describe("workspace folders", () => {
  it("go to a host before it activates, and to every host when they change", async () => {
    const h = setup()
    await pushWorkspaceFolders("ext.a")
    expect(h.sent).toEqual([
      ["ext.a", "workspace:foldersChanged", { folders: [{ uri: "file:///repo", name: "repo" }] }],
    ])
    h.setFolders([REPO, OTHER])
    expect(h.sent.slice(1).map(([pluginId, method]) => `${pluginId} ${method}`)).toEqual([
      "ext.a workspace:foldersChanged",
      "ext.b workspace:foldersChanged",
    ])
  })
})

describe("fs:authorize", () => {
  it("answers the folder holding the path, for the permission the access needs", async () => {
    const h = setup()
    await expect(
      h.call("fs:authorize", { extensionId: "ext.a", path: "/repo/src/a.ts", access: "read" })
    ).resolves.toEqual({ root: "/repo" })
    // The host's own browsable roots count too.
    await expect(h.call("fs:authorize", { path: "/host-root/x", access: "read" })).resolves.toEqual(
      { root: "/host-root" }
    )
    await expect(h.call("fs:authorize", { path: "/repo/a", access: "write" })).rejects.toThrow(
      /filesystem:write/
    )
    await expect(h.call("fs:authorize", { path: "/etc/passwd", access: "read" })).rejects.toThrow(
      /not inside an open workspace folder/
    )
    await expect(h.call("fs:authorize", { path: "/repo2/a", access: "read" })).rejects.toThrow(
      /not inside/
    )
    await expect(h.call("fs:authorize", { path: "/repo/a", access: "exec" })).rejects.toThrow(
      /Unknown access/
    )
    await expect(
      h.call("fs:authorize", { extensionId: "ext.b", path: "/repo/a", access: "read" })
    ).rejects.toThrow(/ownership/)
  })
})

describe("workspace.findFiles", () => {
  it("matches each file's path inside its folder, with the default excludes", async () => {
    const h = setup()
    h.setFolders([REPO, OTHER])
    await expect(
      h.call("workspace:findFiles", { include: { pattern: "**/*.ts" } })
    ).resolves.toEqual([
      "file:///repo/src/a.ts",
      "file:///repo/src/deep/c.ts",
      "file:///repo/node_modules/x/index.ts",
      "file:///other/z.ts",
    ])
    // `null` turns the excludes off; an exclude glob replaces them.
    await expect(
      h.call("workspace:findFiles", { include: { pattern: "**/HEAD" }, exclude: null })
    ).resolves.toEqual(["file:///repo/.git/HEAD"])
    await expect(
      h.call("workspace:findFiles", {
        include: { pattern: "**/*.ts" },
        exclude: { pattern: "**/node_modules/**" },
        maxResults: 2,
      })
    ).resolves.toEqual(["file:///repo/src/a.ts", "file:///repo/src/deep/c.ts"])
  })

  it("walks only the base of a relative pattern, matching from there", async () => {
    const h = setup()
    await expect(
      h.call("workspace:findFiles", { include: { base: "file:///repo/src", pattern: "*.ts" } })
    ).resolves.toEqual(["file:///repo/src/a.ts"])
    expect(h.deps.walk).toHaveBeenCalledWith("/repo", {
      relPath: "src",
      maxEntries: FIND_FILES_WALK_LIMIT,
    })
    // A base above the folders searches the folders inside it.
    await expect(
      h.call("workspace:findFiles", { include: { base: "file:///", pattern: "repo/src/*.js" } })
    ).resolves.toEqual(["file:///repo/src/b.js"])
    await expect(
      h.call("workspace:findFiles", { include: { base: "file:///nowhere", pattern: "**" } })
    ).resolves.toEqual([])
    await expect(
      h.call("workspace:findFiles", { include: { base: "git:/x", pattern: "**" } })
    ).rejects.toThrow(/file URI/)
  })

  it("needs filesystem:read, and says when a walk was cut short", async () => {
    await expect(
      setup({ granted: [] }).call("workspace:findFiles", { include: { pattern: "*" } })
    ).rejects.toThrow(/filesystem:read/)
    const h = setup()
    ;(h.deps.walk as jest.Mock).mockResolvedValueOnce({
      files: [],
      truncated: true,
      skippedSensitive: 2,
    })
    await h.call("workspace:findFiles", { include: { pattern: "*" } })
    expect(mockLog.mock.calls.map(([, entry]) => entry.message)).toEqual([
      expect.stringMatching(/first 50000 files/),
      expect.stringMatching(/2 in \/repo were left out/),
    ])
  })
})

describe("file watchers", () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it("send matching changes in batches, minus the ignored kinds", async () => {
    const h = setup()
    await expect(
      h.call("workspace:createFileSystemWatcher", {
        handle: "w1",
        pattern: { pattern: "**/*.ts" },
        ignoreDeleteEvents: true,
      })
    ).resolves.toEqual({ watching: true })
    const fire = h.watches.get("/repo")!
    fire({ kind: "create", path: "/repo/a.ts" })
    fire({ kind: "modify", path: "/repo/a.ts" })
    fire({ kind: "modify", path: "/repo/a.ts" })
    fire({ kind: "any", path: "/repo/b.ts" })
    fire({ kind: "modify", path: "/repo/a.js" })
    fire({ kind: "delete", path: "/repo/a.ts" })
    expect(h.sent).toEqual([])
    jest.advanceTimersByTime(WATCH_BATCH_MS)
    expect(h.sent).toEqual([
      [
        "ext.a",
        "workspace:fileSystemEvents",
        {
          handle: "w1",
          events: [
            { kind: "create", uri: "file:///repo/a.ts" },
            { kind: "change", uri: "file:///repo/a.ts" },
            { kind: "change", uri: "file:///repo/b.ts" },
          ],
        },
      ],
    ])
  })

  it("match a relative pattern inside its base, and follow the folders", async () => {
    const h = setup()
    await h.call("workspace:createFileSystemWatcher", {
      handle: "rel",
      pattern: { base: "file:///repo/src", pattern: "*.ts" },
    })
    await h.call("workspace:createFileSystemWatcher", { handle: "all", pattern: { pattern: "**" } })
    h.watches.get("/repo")!({ kind: "create", path: "/repo/src/a.ts" })
    h.watches.get("/repo")!({ kind: "create", path: "/repo/src/deep/b.ts" })
    jest.advanceTimersByTime(WATCH_BATCH_MS)
    const relEvents = h.sent.find(
      ([, , payload]) => (payload as { handle: string }).handle === "rel"
    )
    expect(relEvents?.[2]).toEqual({
      handle: "rel",
      events: [{ kind: "create", uri: "file:///repo/src/a.ts" }],
    })

    h.setFolders([OTHER])
    expect(h.stopped).toEqual(["/repo", "/repo"])
    expect([...h.watches.keys()]).toEqual(["/other"])
  })

  it("explain a watcher that cannot run, and stop with their extension", async () => {
    const refused = setup({ granted: [] })
    await expect(
      refused.call("workspace:createFileSystemWatcher", { handle: "x", pattern: { pattern: "**" } })
    ).resolves.toEqual({ watching: false })
    expect(mockLog).toHaveBeenCalledWith(
      "ext.a",
      expect.objectContaining({ message: expect.stringMatching(/filesystem:read/) })
    )

    const h = setup()
    await h.call("workspace:createFileSystemWatcher", {
      handle: "outside",
      pattern: { base: "file:///elsewhere", pattern: "**" },
    })
    expect(mockLog).toHaveBeenLastCalledWith(
      "ext.a",
      expect.objectContaining({ message: expect.stringMatching(/outside every open workspace/) })
    )
    await h.call("workspace:createFileSystemWatcher", { handle: "w", pattern: { pattern: "**" } })
    h.call("workspace:disposeFileSystemWatcher", { handle: "outside" })
    expect(activeWatcherHandles("ext.a")).toEqual(["w"])
    clearVscodeWorkspaceFilesForPlugin("ext.a")
    expect(activeWatcherHandles("ext.a")).toEqual([])
    expect(h.stopped).toEqual(["/repo"])
  })
})

describe("createVscodeWorkspaceFilesDependencies", () => {
  it("walks with ignore files off and keeps files only", async () => {
    mockWalk.mockResolvedValueOnce({
      entries: [
        { relPath: "a", absolutePath: "/r/a", isDir: true, size: 0, mtimeMs: null },
        { relPath: "a/b.ts", absolutePath: "/r/a/b.ts", isDir: false, size: 1, mtimeMs: null },
      ],
      truncated: false,
      skippedSensitive: 1,
    })
    const deps = createVscodeWorkspaceFilesDependencies({ sendToHost: jest.fn(), hosts: () => [] })
    await expect(deps.walk("/r", { relPath: "a", maxEntries: 5 })).resolves.toEqual({
      files: ["/r/a/b.ts"],
      truncated: false,
      skippedSensitive: 1,
    })
    expect(mockWalk).toHaveBeenCalledWith("/r", {
      relPath: "a",
      includeIgnored: true,
      maxEntries: 5,
    })
    await expect(deps.extraRoots()).resolves.toEqual(["/host-root"])
    await expect(deps.permissions("ext.a")).resolves.toEqual(["filesystem:read"])
  })
})
