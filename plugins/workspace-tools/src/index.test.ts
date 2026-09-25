import type {
  PluginContext,
  PluginNodeDef,
  PluginToolContext,
  PluginToolRegistration,
} from "@cognia/plugin-sdk"

import manifestJson from "../plugin.json"
import workspaceTools, {
  READ_DEFAULT_MAX_BYTES,
  READ_MAX_FILE_BYTES,
  READ_MAX_RETURN_BYTES,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_MATCHES,
  SEARCH_TIME_BUDGET_MS,
  SEARCH_TOOL_TIMEOUT_MS,
  WORKSPACE_TOOL_NAMES,
  manifest,
  resolveInWorkspace,
} from "./index"

/**
 * An in-memory project the fake `ctx.workspace` serves. Keys are paths
 * relative to the root; a value is file content, or `{ size }` for a file
 * whose size matters but whose bytes do not.
 */
type FakeFile = string | { size: number; content?: string }

interface FakeWorkspaceOptions {
  root?: string
  files?: Record<string, FakeFile>
  /** Paths the walk treats as git-ignored unless `includeIgnored`. */
  ignored?: string[]
}

interface WalkOpts {
  relPath?: string
  includeIgnored?: boolean
  includeDirs?: boolean
  maxEntries?: number
  maxDepth?: number
}

function sizeOf(file: FakeFile): number {
  return typeof file === "string" ? file.length : file.size
}

function createFakeWorkspace(options: FakeWorkspaceOptions = {}) {
  let root: string | undefined = options.root ?? "/ws"
  const files = new Map(Object.entries(options.files ?? {}))
  const ignored = new Set(options.ignored ?? [])

  const dirsOf = () => {
    const dirs = new Set<string>()
    for (const path of files.keys()) {
      const parts = path.split("/")
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"))
    }
    return dirs
  }

  const workspace = {
    getActiveRoot: jest.fn(() => root),
    acquire: jest.fn(async (spec: { kind: string; path: string }) => ({
      root: spec.path,
      origin: "local-path" as const,
      ephemeral: false,
    })),
    walk: jest.fn(async (_handle: unknown, opts: WalkOpts = {}) => {
      const base = opts.relPath ?? ""
      const dirs = dirsOf()
      if (base && !dirs.has(base)) throw new Error(`not a directory: ${base}`)
      const prefix = base ? `${base}/` : ""
      const depthOf = (path: string) => path.slice(prefix.length).split("/").length
      const maxDepth = opts.maxDepth ?? 24
      const isIgnored = (path: string) =>
        !opts.includeIgnored && [...ignored].some((i) => path === i || path.startsWith(`${i}/`))
      const entries: Array<{
        relPath: string
        absolutePath: string
        isDir: boolean
        size: number
        mtimeMs: number | null
      }> = []
      let skippedSensitive = 0
      let truncated = false
      const candidates: Array<[string, boolean]> = [
        ...[...dirs].map((d) => [d, true] as [string, boolean]),
        ...[...files.keys()].map((f) => [f, false] as [string, boolean]),
      ]
      for (const [path, isDir] of candidates.sort(([a], [b]) => a.localeCompare(b))) {
        if (!path.startsWith(prefix) || depthOf(path) > maxDepth || isIgnored(path)) continue
        if (!isDir && path.split("/").pop() === ".env") {
          skippedSensitive += 1
          continue
        }
        if (isDir && !opts.includeDirs) continue
        if (entries.length >= (opts.maxEntries ?? 5000)) {
          truncated = true
          break
        }
        entries.push({
          relPath: path,
          absolutePath: `${root}/${path}`,
          isDir,
          size: isDir ? 0 : sizeOf(files.get(path)!),
          mtimeMs: null,
        })
      }
      return { entries, truncated, skippedSensitive }
    }),
    read: jest.fn(async (_handle: unknown, rel: string, opts?: { maxBytes?: number }) => {
      const file = files.get(rel)
      if (file === undefined) throw new Error(`read ${rel}: No such file or directory`)
      const text = typeof file === "string" ? file : (file.content ?? "x".repeat(file.size))
      const cap = opts?.maxBytes
      return cap !== undefined && text.length > cap
        ? `${text.slice(0, cap)}\n... (truncated)`
        : text
    }),
  }
  return {
    workspace,
    setRoot: (next: string | undefined) => {
      root = next
    },
  }
}

function activate(fake: ReturnType<typeof createFakeWorkspace>) {
  const tools = new Map<string, PluginToolRegistration>()
  const nodes = new Map<string, PluginNodeDef>()
  const disposers: Array<() => void> = []
  const ctx = {
    pluginId: "cognia-workspace-tools",
    workspace: fake.workspace,
    logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    lifecycle: {
      onDispose: jest.fn((dispose: () => void) => {
        disposers.push(dispose)
      }),
    },
    agent: {
      registerTool: (tool: PluginToolRegistration) => {
        tools.set(tool.name, tool)
        return () => undefined
      },
    },
    workflow: {
      registerNode: jest.fn((node: PluginNodeDef) => {
        nodes.set(node.kind, node)
        return jest.fn()
      }),
    },
  } as unknown as PluginContext
  void workspaceTools.activate(ctx)
  const call = (
    name: string,
    args: Record<string, unknown>,
    callCtx: Partial<PluginToolContext> = {}
  ) =>
    tools.get(name)!.execute(args, { config: {}, ...callCtx }) as Promise<Record<string, unknown>>
  return { ctx, tools, nodes, disposers, call }
}

describe("manifest", () => {
  it("adopts plugin.json itself as the manifest", () => {
    expect(manifest).toEqual(manifestJson)
    expect(workspaceTools.manifest).toBe(manifest)
  })

  it("is desktop-only, and says so with a reason for each blocked surface", () => {
    const compat = manifestJson.runtimeCompatibility
    expect(compat.tauri.availability).toBe("supported")
    expect(compat.browser).toMatchObject({ availability: "blocked", reason: expect.any(String) })
    expect(compat.mobile).toMatchObject({ availability: "blocked", reason: expect.any(String) })
  })

  it("describes what the plugin actually ships", () => {
    expect(manifestJson.description).toMatch(/agent tools/)
    expect(manifestJson.description).not.toMatch(/plugin authors/)
  })

  it("localizes every workflow node it registers, in both locales", () => {
    const { nodes } = activate(createFakeWorkspace())
    const en = manifestJson.i18n.locales.en as Record<string, string>
    const zh = manifestJson.i18n.locales["zh-CN"] as Record<string, string>
    for (const node of nodes.values()) {
      for (const field of ["label", "description"] as const) {
        const key = `workflow.nodes.${node.kind}.${field}`
        expect(en[key]).toBe(node[field])
        expect(zh[key]).toEqual(expect.any(String))
      }
    }
  })
})

describe("registration", () => {
  it("registers three read-only path tools with real schemas", () => {
    const { tools } = activate(createFakeWorkspace())
    expect([...tools.keys()].sort()).toEqual([...WORKSPACE_TOOL_NAMES].sort())
    for (const tool of tools.values()) {
      expect(tool.pluginId).toBeUndefined()
      expect(tool.definition.access).toBe("read")
      expect(tool.definition.pathParams).toEqual(["path"])
      const schema = tool.definition.parametersSchema as {
        properties: Record<string, unknown>
        additionalProperties: boolean
      }
      expect(Object.keys(schema.properties).length).toBeGreaterThan(0)
      expect(schema.additionalProperties).toBe(false)
    }
    expect(tools.get("workspace_search")!.definition.timeoutMs).toBe(SEARCH_TOOL_TIMEOUT_MS)
    const readSchema = tools.get("workspace_read_file")!.definition.parametersSchema as {
      properties: { maxBytes: { maximum: number } }
    }
    expect(readSchema.properties.maxBytes.maximum).toBe(READ_MAX_RETURN_BYTES)
  })

  it("registers the workflow nodes with teardown on the plugin lifecycle", () => {
    const { nodes, tools, ctx, disposers } = activate(createFakeWorkspace())
    expect([...nodes.keys()].sort()).toEqual([
      "action.listFiles",
      "action.readFile",
      "action.search",
    ])
    expect(ctx.lifecycle.onDispose).toHaveBeenCalledTimes(3)
    expect(disposers).toHaveLength(3)
    // Same schema for the node inspector and the model-facing tool.
    expect(nodes.get("action.search")!.paramsSchema).toBe(
      tools.get("workspace_search")!.definition.parametersSchema
    )
  })
})

describe("project root", () => {
  it("resolves the root on every call, not once at activation", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "a" } })
    const { call } = activate(fake)
    await call("workspace_list_files", {})
    fake.setRoot("/other")
    const second = await call("workspace_list_files", {})
    expect(second).toMatchObject({ ok: true, path: "/other" })
    expect(fake.workspace.acquire).toHaveBeenLastCalledWith({ kind: "local-path", path: "/other" })
  })

  it("reuses the host handle while the root stays the same", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "a" } })
    const { call } = activate(fake)
    await call("workspace_list_files", {})
    await call("workspace_read_file", { path: "a.txt" })
    expect(fake.workspace.acquire).toHaveBeenCalledTimes(1)
  })

  it("fails closed when no project is open", async () => {
    const fake = createFakeWorkspace()
    fake.setRoot(undefined)
    const { call } = activate(fake)
    for (const name of WORKSPACE_TOOL_NAMES) {
      await expect(call(name, { path: "a.txt", pattern: "x" })).resolves.toMatchObject({
        ok: false,
        error: expect.stringMatching(/No project is open/),
      })
    }
    expect(fake.workspace.acquire).not.toHaveBeenCalled()
  })

  it("reports a refused acquire, then retries it on the next call", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "a" } })
    fake.workspace.acquire.mockRejectedValueOnce(new Error("not inside a workspace"))
    const { call } = activate(fake)
    await expect(call("workspace_list_files", {})).resolves.toEqual({
      ok: false,
      error: "workspace_list_files: not inside a workspace",
    })
    await expect(call("workspace_list_files", {})).resolves.toMatchObject({ ok: true })
    expect(fake.workspace.acquire).toHaveBeenCalledTimes(2)
  })
})

describe("confinement", () => {
  it("resolveInWorkspace keeps relative, dotted, and in-root absolute paths", () => {
    expect(resolveInWorkspace("/ws", undefined)).toEqual({ ok: true, path: "/ws", rel: "" })
    expect(resolveInWorkspace("/ws/", "./src/../lib/a.ts")).toEqual({
      ok: true,
      path: "/ws/lib/a.ts",
      rel: "lib/a.ts",
    })
    expect(resolveInWorkspace("/ws", "/ws/src")).toEqual({ ok: true, path: "/ws/src", rel: "src" })
    expect(resolveInWorkspace("C:\\ws", "src\\a.ts")).toMatchObject({ ok: true, rel: "src/a.ts" })
  })

  it("rejects traversal, outside absolute paths, and look-alike prefixes", () => {
    expect(resolveInWorkspace("/ws", "../etc/passwd")).toMatchObject({ ok: false })
    expect(resolveInWorkspace("/ws", "/etc/passwd")).toMatchObject({ ok: false })
    expect(resolveInWorkspace("/ws", "/ws-evil/a")).toMatchObject({ ok: false })
    expect(resolveInWorkspace("/ws", 42)).toMatchObject({ ok: false, error: /string/ })
  })

  it("refuses an escaping path before any host call", async () => {
    const fake = createFakeWorkspace()
    const { call } = activate(fake)
    await expect(call("workspace_read_file", { path: "../../.ssh/id_rsa" })).resolves.toMatchObject(
      {
        ok: false,
        error: expect.stringMatching(/escapes the workspace/),
      }
    )
    await expect(call("workspace_search", { pattern: "x", path: "/etc" })).resolves.toMatchObject({
      ok: false,
    })
    expect(fake.workspace.walk).not.toHaveBeenCalled()
    expect(fake.workspace.read).not.toHaveBeenCalled()
  })

  it("surfaces the host's own symlink refusal as a structured error", async () => {
    const fake = createFakeWorkspace({ files: { "docs/a.md": "x" } })
    fake.workspace.walk.mockRejectedValueOnce(new Error("path escapes workspace: /Users/me/.ssh"))
    const { call } = activate(fake)
    await expect(call("workspace_list_files", { path: "docs" })).resolves.toEqual({
      ok: false,
      error: "workspace_list_files: path escapes workspace: /Users/me/.ssh",
    })
  })
})

describe("workspace_list_files", () => {
  it("lists immediate children, including git-ignored ones, with file sizes", async () => {
    const fake = createFakeWorkspace({
      files: { "src/a.ts": "aa", "src/deep/b.ts": "b", "dist/x.js": "x", "README.md": "hello" },
      ignored: ["dist"],
    })
    const { call } = activate(fake)
    const result = await call("workspace_list_files", {})
    expect(result).toEqual({
      ok: true,
      path: "/ws",
      entries: [
        { name: "dist", isDirectory: true, isFile: false },
        { name: "README.md", isDirectory: false, isFile: true, size: 5 },
        { name: "src", isDirectory: true, isFile: false },
      ],
      truncated: false,
    })
    expect(fake.workspace.walk).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeIgnored: true, includeDirs: true, maxDepth: 1 })
    )
  })

  it("reports credential files the host withheld", async () => {
    const fake = createFakeWorkspace({ files: { ".env": "SECRET=1", "a.txt": "a" } })
    const { call } = activate(fake)
    await expect(call("workspace_list_files", {})).resolves.toMatchObject({
      withheldCredentialFiles: 1,
    })
  })
})

describe("workspace_read_file", () => {
  it("requires a path", async () => {
    const { call } = activate(createFakeWorkspace())
    await expect(call("workspace_read_file", {})).resolves.toEqual({
      ok: false,
      error: "path is required",
    })
  })

  it("sizes the file first, then reads it capped at maxBytes", async () => {
    const fake = createFakeWorkspace({ files: { "src/a.ts": "0123456789" } })
    const { call } = activate(fake)
    const result = await call("workspace_read_file", { path: "src/a.ts", maxBytes: 4 })
    expect(result).toMatchObject({ ok: true, path: "/ws/src/a.ts", size: 10, truncated: true })
    expect(result.content).toMatch(/^0123/)
    const walkOrder = fake.workspace.walk.mock.invocationCallOrder[0]
    const readOrder = fake.workspace.read.mock.invocationCallOrder[0]
    expect(walkOrder).toBeLessThan(readOrder)
    expect(fake.workspace.read).toHaveBeenCalledWith(expect.anything(), "src/a.ts", {
      maxBytes: 4,
    })
  })

  it("defaults and clamps maxBytes", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "a" } })
    const { call } = activate(fake)
    await call("workspace_read_file", { path: "a.txt" })
    await call("workspace_read_file", { path: "a.txt", maxBytes: 10 ** 9 })
    expect(fake.workspace.read.mock.calls.map((c) => c[2])).toEqual([
      { maxBytes: READ_DEFAULT_MAX_BYTES },
      { maxBytes: READ_MAX_RETURN_BYTES },
    ])
  })

  it("refuses an oversized file without reading it", async () => {
    const fake = createFakeWorkspace({ files: { "big.log": { size: READ_MAX_FILE_BYTES + 1 } } })
    const { call } = activate(fake)
    await expect(call("workspace_read_file", { path: "big.log" })).resolves.toMatchObject({
      ok: false,
      error: expect.stringMatching(/read limit/),
    })
    expect(fake.workspace.read).not.toHaveBeenCalled()
  })

  it("explains a directory, a missing file, and a withheld credential file", async () => {
    const fake = createFakeWorkspace({ files: { "src/a.ts": "a", ".env": "S=1" } })
    const { call } = activate(fake)
    await expect(call("workspace_read_file", { path: "src" })).resolves.toMatchObject({
      error: expect.stringMatching(/is a directory/),
    })
    await expect(call("workspace_read_file", { path: "." })).resolves.toMatchObject({
      error: expect.stringMatching(/is a directory/),
    })
    await expect(call("workspace_read_file", { path: "src/nope.ts" })).resolves.toMatchObject({
      error: expect.stringMatching(/does not exist, or the host withholds/),
    })
    await expect(call("workspace_read_file", { path: ".env" })).resolves.toMatchObject({
      ok: false,
    })
    expect(fake.workspace.read).not.toHaveBeenCalled()
  })

  it("turns a host read failure (e.g. a binary file) into a structured error", async () => {
    const fake = createFakeWorkspace({ files: { "img.png": "x" } })
    fake.workspace.read.mockRejectedValueOnce(new Error("stream did not contain valid UTF-8"))
    const { call } = activate(fake)
    await expect(call("workspace_read_file", { path: "img.png" })).resolves.toEqual({
      ok: false,
      error: "workspace_read_file: stream did not contain valid UTF-8",
    })
  })
})

describe("workspace_search", () => {
  it("matches lines across the tree and reports where", async () => {
    const fake = createFakeWorkspace({
      files: { "src/a.ts": "const foo = 1\nbar\nFOO()", "b.md": "nothing" },
    })
    const { call } = activate(fake)
    await expect(call("workspace_search", { pattern: "foo", ignoreCase: true })).resolves.toEqual({
      ok: true,
      pattern: "foo",
      matches: [
        { path: "/ws/src/a.ts", line: 1, text: "const foo = 1" },
        { path: "/ws/src/a.ts", line: 3, text: "FOO()" },
      ],
      truncated: false,
    })
  })

  it("skips dependency, build and dot folders — unless the search starts inside one", async () => {
    const fake = createFakeWorkspace({
      files: {
        "node_modules/x/i.js": "needle",
        ".git/config": "needle",
        "dist/app.js": "needle",
        "src/ok.ts": "needle",
      },
    })
    const { call } = activate(fake)
    const all = await call("workspace_search", { pattern: "needle" })
    expect((all.matches as Array<{ path: string }>).map((m) => m.path)).toEqual(["/ws/src/ok.ts"])
    expect(all.truncatedReasons).toEqual(["skipped-directories"])

    const inside = await call("workspace_search", { pattern: "needle", path: "dist" })
    expect((inside.matches as Array<{ path: string }>).map((m) => m.path)).toEqual([
      "/ws/dist/app.js",
    ])
  })

  it("skips an oversized file without reading it", async () => {
    const fake = createFakeWorkspace({
      files: { "big.min.js": { size: SEARCH_MAX_FILE_BYTES + 1 }, "a.ts": "needle" },
    })
    const { call } = activate(fake)
    const result = await call("workspace_search", { pattern: "needle" })
    expect(result).toMatchObject({ ok: true, truncatedReasons: ["oversized-files"] })
    expect(fake.workspace.read.mock.calls.map((c) => c[1])).toEqual(["a.ts"])
  })

  it("stops at the match cap", async () => {
    const lines = Array.from({ length: SEARCH_MAX_MATCHES + 50 }, () => "hit").join("\n")
    const { call } = activate(createFakeWorkspace({ files: { "a.txt": lines } }))
    const result = await call("workspace_search", { pattern: "hit" })
    expect(result.matches).toHaveLength(SEARCH_MAX_MATCHES)
    expect(result.truncatedReasons).toEqual(["max-matches"])
  })

  it("returns what it has once the time budget is spent", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "hit", "b.txt": "hit" } })
    const { call } = activate(fake)
    let now = 1_000
    const spy = jest.spyOn(Date, "now").mockImplementation(() => now)
    fake.workspace.read.mockImplementation(async () => {
      now += SEARCH_TIME_BUDGET_MS + 1
      return "hit"
    })
    try {
      const result = await call("workspace_search", { pattern: "hit" })
      expect(result).toMatchObject({ ok: true, truncated: true })
      expect(result.truncatedReasons).toContain("time-budget")
    } finally {
      spy.mockRestore()
    }
  })

  it("honours cancellation before and during the sweep", async () => {
    const fake = createFakeWorkspace({
      files: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}.txt`, "hit"])),
    })
    const { call } = activate(fake)
    const before = new AbortController()
    before.abort()
    await expect(
      call("workspace_search", { pattern: "hit" }, { signal: before.signal })
    ).resolves.toEqual({ ok: false, error: "The call was cancelled." })
    expect(fake.workspace.walk).not.toHaveBeenCalled()

    const during = new AbortController()
    fake.workspace.read.mockImplementation(async () => {
      during.abort()
      return "hit"
    })
    await expect(
      call("workspace_search", { pattern: "hit" }, { signal: during.signal })
    ).resolves.toEqual({ ok: false, error: "The call was cancelled." })
    expect(fake.workspace.read.mock.calls.length).toBeLessThan(20)
  })

  it("refuses empty, invalid and catastrophic patterns before touching the project", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "a" } })
    const { call } = activate(fake)
    await expect(call("workspace_search", { pattern: "" })).resolves.toMatchObject({
      error: "pattern is required",
    })
    await expect(call("workspace_search", { pattern: "(" })).resolves.toMatchObject({
      error: expect.stringMatching(/^Invalid regex pattern/),
    })
    await expect(call("workspace_search", { pattern: "(a+)+$" })).resolves.toMatchObject({
      error: expect.stringMatching(/^Unsupported regex pattern: nested quantifiers/),
    })
    await expect(call("workspace_search", { pattern: "(a)\\1" })).resolves.toMatchObject({
      error: expect.stringMatching(/backreferences/),
    })
    expect(fake.workspace.walk).not.toHaveBeenCalled()
  })

  it("tests only the head of a very long line", async () => {
    const long = `${"a".repeat(5_000)}needle`
    const { call } = activate(createFakeWorkspace({ files: { "a.txt": long } }))
    await expect(call("workspace_search", { pattern: "needle" })).resolves.toMatchObject({
      matches: [],
    })
  })

  it("skips files the host cannot read as text", async () => {
    const fake = createFakeWorkspace({ files: { "a.bin": "x", "b.txt": "needle" } })
    fake.workspace.read.mockImplementation(async (_h: unknown, rel: string) => {
      if (rel === "a.bin") throw new Error("stream did not contain valid UTF-8")
      return "needle"
    })
    const { call } = activate(fake)
    await expect(call("workspace_search", { pattern: "needle" })).resolves.toMatchObject({
      ok: true,
      matches: [{ path: "/ws/b.txt", line: 1, text: "needle" }],
    })
  })

  it("reports a walk failure as a structured error", async () => {
    const fake = createFakeWorkspace()
    const { call } = activate(fake)
    await expect(call("workspace_search", { pattern: "x", path: "nope" })).resolves.toEqual({
      ok: false,
      error: "workspace_search: not a directory: nope",
    })
  })
})

describe("workflow nodes", () => {
  it("delegate to the same implementations as the tools", async () => {
    const fake = createFakeWorkspace({ files: { "a.txt": "needle" } })
    const { nodes } = activate(fake)
    const signal = new AbortController().signal
    const run = (kind: string, params: Record<string, unknown>) =>
      nodes.get(kind)!.execute({ params, signal } as never) as Promise<{
        output: Record<string, unknown>
      }>

    await expect(run("action.listFiles", { path: "." })).resolves.toMatchObject({
      output: { ok: true, entries: [{ name: "a.txt" }] },
    })
    await expect(run("action.readFile", { path: "a.txt" })).resolves.toMatchObject({
      output: { ok: true, content: "needle" },
    })
    await expect(run("action.search", { pattern: "needle" })).resolves.toMatchObject({
      output: { ok: true, matches: [{ line: 1 }] },
    })
  })

  it("stops a search node when the run is cancelled", async () => {
    const { nodes } = activate(createFakeWorkspace({ files: { "a.txt": "needle" } }))
    const controller = new AbortController()
    controller.abort()
    await expect(
      nodes.get("action.search")!.execute({
        params: { pattern: "needle" },
        signal: controller.signal,
      } as never)
    ).resolves.toEqual({ output: { ok: false, error: "The call was cancelled." } })
  })
})
