/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@cognia/plugin-sdk"
import type { PluginNodeDef } from "@cognia/plugin-sdk"

// Controllable fs double so the desktop tool paths (list / read / search) can
// run under jsdom without a real Tauri host. The factory is hoisted, so it
// references the mocks lazily.
const mockReadDir = jest.fn(async (_p: string) => [] as Array<Record<string, unknown>>)
const mockReadTextFile = jest.fn(async (_p: string) => "")
// `lstat` backs the symlink guard and `stat` the pre-read size bound; both
// default to "ordinary small file" so existing cases are unaffected.
const mockLstat = jest.fn(async (_p: string) => ({ isSymlink: false }) as Record<string, unknown>)
const mockStat = jest.fn(async (_p: string) => ({ size: 10 }) as Record<string, unknown>)
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    readDir: (...a: unknown[]) => (mockReadDir as (...x: unknown[]) => unknown)(...a),
    readTextFile: (...a: unknown[]) => (mockReadTextFile as (...x: unknown[]) => unknown)(...a),
    lstat: (...a: unknown[]) => (mockLstat as (...x: unknown[]) => unknown)(...a),
    stat: (...a: unknown[]) => (mockStat as (...x: unknown[]) => unknown)(...a),
  }),
  { virtual: true }
)

import workspaceTools, { __setWorkspaceRootForTesting } from "./index"

// Every tool now resolves paths against the OPEN WORKSPACE and rejects
// anything outside it, so the suite has to declare one.
const WS = "/ws"
beforeEach(() => __setWorkspaceRootForTesting(WS))
afterEach(() => __setWorkspaceRootForTesting(undefined))

/** ctx that reports a Tauri host so the desktop tool bodies run. */
const makeDesktopCtx = () => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const definitions: Record<string, { parametersSchema?: unknown }> = {}
  const nodes: Record<string, PluginNodeDef> = {}
  const ctx = {
    pluginId: "cognia-workspace-tools",
    capabilities: { tauri: true },
    workspace: { getActiveRoot: () => WS },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    agent: {
      registerTool: ({
        name,
        execute,
        definition,
      }: {
        name: string
        execute: (args: unknown) => Promise<unknown>
        definition?: { parametersSchema?: unknown }
      }) => {
        tools[name] = execute
        // Capture the definition too: the harness used to drop it, which is
        // why all three tools shipping an EMPTY parametersSchema went
        // unnoticed — the model saw no parameter names at all.
        definitions[name] = definition ?? {}
      },
    },
    workflow: {
      registerNode: (node: PluginNodeDef) => {
        nodes[node.kind] = node
        return jest.fn()
      },
    },
  } as unknown as import("@cognia/plugin-sdk").PluginContext
  return { ctx, tools, definitions, nodes }
}

const makeCtx = () => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const nodes: Record<string, PluginNodeDef> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-workspace-tools",
    capabilities: { tauri: false } as never,
    workspace: { getActiveRoot: () => WS } as never,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerTool: ({
        name,
        execute,
      }: {
        name: string
        execute: (args: unknown) => Promise<unknown>
      }) => {
        tools[name] = execute
      },
    } as never,
    workflow: {
      registerNode: (node: PluginNodeDef) => {
        nodes[node.kind] = node
        return jest.fn()
      },
    } as never,
  }
  return { ctx: ctx as PluginContext, tools, nodes }
}

describe("workspace-tools (built-in)", () => {
  it("declares workflow capability for contributed nodes", () => {
    expect(workspaceTools.manifest.capabilities).toEqual(["tools", "workflow"])
  })

  it("registers three tools on activate", async () => {
    const { ctx, tools } = makeCtx()
    await workspaceTools.activate?.(ctx)
    expect(Object.keys(tools).sort()).toEqual([
      "workspace_list_files",
      "workspace_read_file",
      "workspace_search",
    ])
  })

  it("registers workflow nodes for the same workspace abilities", async () => {
    const { ctx, nodes } = makeCtx()
    await workspaceTools.activate?.(ctx)
    expect(Object.keys(nodes).sort()).toEqual([
      "action.listFiles",
      "action.readFile",
      "action.search",
    ])
    expect(nodes["action.listFiles"]).toMatchObject({
      label: "List workspace files",
      category: "plugin",
      desktopOnly: true,
      defaultParams: { path: "." },
    })
    expect(nodes["action.readFile"].paramsSchema.required).toEqual(["path"])
    expect(nodes["action.search"].paramsSchema.required).toEqual(["pattern"])
  })

  it("returns the desktop-only diagnostic when not running in Tauri", async () => {
    const { ctx, tools } = makeCtx()
    await workspaceTools.activate?.(ctx)
    const list = await tools.workspace_list_files({ path: "." })
    expect(list).toMatchObject({ ok: false })
  })

  it("workspace_read_file requires a path arg", async () => {
    const { ctx, tools } = makeCtx()
    await workspaceTools.activate?.(ctx)
    // In browser fallback, both no-path and missing-path return ok=false.
    const result = await tools.workspace_read_file({})
    expect(result).toMatchObject({ ok: false })
  })

  it("deactivate runs without throwing", async () => {
    const { ctx } = makeCtx()
    await workspaceTools.activate?.(ctx)
    await expect(workspaceTools.deactivate?.(ctx)).resolves.not.toThrow()
  })

  it("workspace_search returns ok:false on an invalid regex instead of throwing", async () => {
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    // Unbalanced character class — `new RegExp("[(")` throws; the guard must
    // catch it and surface a structured error rather than crash the tool.
    const result = (await tools.workspace_search({ pattern: "[(" })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/invalid regex/i)
    await workspaceTools.deactivate?.(ctx)
  })

  it("workspace_search still rejects an empty pattern", async () => {
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_search({ pattern: "" })) as { ok: boolean }
    expect(result.ok).toBe(false)
    await workspaceTools.deactivate?.(ctx)
  })

  it("gives every agent tool a real parameter schema", async () => {
    // `sidecar-tools-bridge` forwards `parametersSchema` verbatim as the MCP
    // tool's jsonSchema. An empty `{ properties: {} }` — which all three tools
    // shipped — means the model is handed a tool with no parameter names and
    // has to guess them from the description.
    const { ctx, definitions } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    for (const name of ["workspace_list_files", "workspace_read_file", "workspace_search"]) {
      const schema = definitions[name]?.parametersSchema as {
        properties?: Record<string, unknown>
        additionalProperties?: boolean
      }
      expect(Object.keys(schema?.properties ?? {}).length).toBeGreaterThan(0)
      expect(schema.additionalProperties).toBe(false)
    }
    expect(
      Object.keys(
        (definitions.workspace_search.parametersSchema as { properties: Record<string, unknown> })
          .properties
      ).sort()
    ).toEqual(["ignoreCase", "path", "pattern"])
    expect(
      (definitions.workspace_read_file.parametersSchema as { required: string[] }).required
    ).toEqual(["path"])
    await workspaceTools.deactivate?.(ctx)
  })

  it("declares the tool schema its workflow node uses", async () => {
    // The node and the tool are the same operation; they must not drift.
    const { ctx, definitions, nodes } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    expect(definitions.workspace_read_file.parametersSchema).toBe(
      nodes["action.readFile"].paramsSchema
    )
    await workspaceTools.deactivate?.(ctx)
  })

  describe("desktop tool bodies (Tauri host)", () => {
    beforeEach(() => {
      mockReadDir.mockReset()
      mockReadTextFile.mockReset()
    })

    it("workspace_list_files maps fs entries to a normalized shape", async () => {
      mockReadDir.mockResolvedValue([
        { name: "a.ts", isFile: true, isDirectory: false },
        { name: "sub", isFile: false, isDirectory: true },
      ])
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_list_files({ path: "src" })) as {
        ok: boolean
        path: string
        entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>
      }
      expect(result.ok).toBe(true)
      expect(result.path).toBe(`${WS}/src`)
      expect(result.entries).toEqual([
        { name: "a.ts", isFile: true, isDirectory: false },
        { name: "sub", isFile: false, isDirectory: true },
      ])
      await workspaceTools.deactivate?.(ctx)
    })

    it("workspace_read_file returns content and flags truncation past maxBytes", async () => {
      mockReadTextFile.mockResolvedValue("0123456789")
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_read_file({ path: "f.txt", maxBytes: 4 })) as {
        ok: boolean
        content: string
        truncated: boolean
      }
      expect(result.ok).toBe(true)
      expect(result.content).toBe("0123")
      expect(result.truncated).toBe(true)
      await workspaceTools.deactivate?.(ctx)
    })

    it("workspace_search walks the tree, matches lines, and skips unreadable files", async () => {
      // root has a dotdir (skipped), a normal dir, a matching file, and an
      // unreadable file (readTextFile rejects → swallowed).
      mockReadDir.mockImplementation(async (dir: string) => {
        if (dir === WS) {
          return [
            { name: ".git", isDirectory: true, isFile: false },
            { name: "src", isDirectory: true, isFile: false },
            { name: "readme.md", isDirectory: false, isFile: true },
            { name: "binary.bin", isDirectory: false, isFile: true },
          ]
        }
        if (dir === `${WS}/src`) {
          return [{ name: "app.ts", isDirectory: false, isFile: true }]
        }
        return []
      })
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path === `${WS}/binary.bin`) throw new Error("not utf-8")
        if (path === `${WS}/src/app.ts`) return "const TODO = 1\nconst ok = 2"
        if (path === `${WS}/readme.md`) return "nothing here"
        return ""
      })
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_search({ pattern: "TODO" })) as {
        ok: boolean
        matches: Array<{ path: string; line: number; text: string }>
      }
      expect(result.ok).toBe(true)
      expect(result.matches).toEqual([
        { path: `${WS}/src/app.ts`, line: 1, text: "const TODO = 1" },
      ])
      // The dotdir was never descended into.
      expect(mockReadDir).not.toHaveBeenCalledWith(`${WS}/.git`)
      await workspaceTools.deactivate?.(ctx)
    })

    it("never descends into dependency/build directories", async () => {
      // Dot-directories were the only exclusion, so a search at a real project
      // root read every file under node_modules as UTF-8.
      mockReadDir.mockImplementation(async (dir: string) => {
        if (dir === WS) {
          return [
            { name: "node_modules", isDirectory: true, isFile: false },
            { name: "target", isDirectory: true, isFile: false },
            { name: "dist", isDirectory: true, isFile: false },
            { name: "src", isDirectory: true, isFile: false },
          ]
        }
        if (dir === `${WS}/src`) return [{ name: "app.ts", isDirectory: false, isFile: true }]
        return []
      })
      mockReadTextFile.mockResolvedValue("const TODO = 1")
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      await tools.workspace_search({ pattern: "TODO" })
      for (const skipped of [`${WS}/node_modules`, `${WS}/target`, `${WS}/dist`]) {
        expect(mockReadDir).not.toHaveBeenCalledWith(skipped)
      }
      expect(mockReadDir).toHaveBeenCalledWith(`${WS}/src`)
      await workspaceTools.deactivate?.(ctx)
    })

    it("skips oversized files and reports the sweep as truncated", async () => {
      mockReadDir.mockImplementation(async (dir: string) =>
        dir === WS ? [{ name: "bundle.js", isDirectory: false, isFile: true }] : []
      )
      // 512KB cap — a bundle/lockfile read as text.
      mockReadTextFile.mockResolvedValue(`TODO${"x".repeat(600 * 1024)}`)
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_search({ pattern: "TODO" })) as {
        matches: unknown[]
        truncated: boolean
      }
      expect(result.matches).toEqual([])
      expect(result.truncated).toBe(true)
      await workspaceTools.deactivate?.(ctx)
    })

    it("stops descending past the depth cap", async () => {
      // Every directory contains one more directory — unbounded without a cap.
      mockReadDir.mockImplementation(async () => [
        { name: "deeper", isDirectory: true, isFile: false },
      ])
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_search({ pattern: "TODO" })) as { truncated: boolean }
      expect(result.truncated).toBe(true)
      // depth 0..12 inclusive → 13 readDir calls, then the cap trips.
      expect(mockReadDir.mock.calls.length).toBeLessThanOrEqual(14)
      await workspaceTools.deactivate?.(ctx)
    })
  })

  describe("workflow node executors", () => {
    beforeEach(() => {
      mockReadDir.mockReset()
      mockReadTextFile.mockReset()
    })

    it("action.listFiles delegates to the existing listFiles implementation", async () => {
      mockReadDir.mockResolvedValue([{ name: "a.ts", isFile: true, isDirectory: false }])
      const { ctx, nodes } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = await nodes["action.listFiles"].execute({
        params: { path: "src" },
      } as never)
      expect(result.output).toMatchObject({
        ok: true,
        path: `${WS}/src`,
        entries: [{ name: "a.ts", isFile: true, isDirectory: false }],
      })
      await workspaceTools.deactivate?.(ctx)
    })

    it("action.readFile delegates to the existing readFile implementation", async () => {
      mockReadTextFile.mockResolvedValue("abcdef")
      const { ctx, nodes } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = await nodes["action.readFile"].execute({
        params: { path: "note.txt", maxBytes: 3 },
      } as never)
      expect(result.output).toMatchObject({
        ok: true,
        path: `${WS}/note.txt`,
        content: "abc",
        truncated: true,
      })
      await workspaceTools.deactivate?.(ctx)
    })

    it("action.search delegates to the existing search implementation", async () => {
      mockReadDir.mockResolvedValue([{ name: "readme.md", isDirectory: false, isFile: true }])
      mockReadTextFile.mockResolvedValue("hello\nneedle")
      const { ctx, nodes } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = await nodes["action.search"].execute({
        params: { pattern: "needle", path: "." },
      } as never)
      expect(result.output).toMatchObject({
        ok: true,
        pattern: "needle",
        matches: [{ path: `${WS}/readme.md`, line: 2, text: "needle" }],
      })
      await workspaceTools.deactivate?.(ctx)
    })
  })
})

describe("workspace confinement", () => {
  // This describe sits outside the "desktop tool bodies" block, so it needs its
  // own reset — otherwise `not.toHaveBeenCalled()` below would read calls made
  // by earlier tests and pass vacuously.
  beforeEach(() => {
    mockReadDir.mockReset()
    mockReadDir.mockResolvedValue([])
    mockReadTextFile.mockReset()
    mockReadTextFile.mockResolvedValue("")
    mockLstat.mockReset()
    mockLstat.mockResolvedValue({ isSymlink: false })
    mockStat.mockReset()
    mockStat.mockResolvedValue({ size: 10 })
  })

  // These tools import `@tauri-apps/plugin-fs` directly and MUST keep doing so:
  // `ctx.fs` confines every path to `<plugin_dir>/data` (`resolve_scoped` in
  // crates/cognia-plugin-runtime), which is the plugin's private data dir, not
  // the user's workspace — routing through it would break the plugin, not
  // secure it. So the declared `filesystem:read` permission gates nothing here
  // and confinement has to live in the plugin.
  const ESCAPES = [
    "../../etc/passwd",
    "/etc/passwd",
    "src/../../../../root/.ssh/id_rsa",
    "./../outside",
  ]

  it.each(ESCAPES)("workspace_read_file rejects %s", async (path) => {
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_read_file({ path })) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/escapes the workspace/)
    expect(mockReadTextFile).not.toHaveBeenCalled()
    await workspaceTools.deactivate?.(ctx)
  })

  it.each(ESCAPES)("workspace_list_files rejects %s", async (path) => {
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_list_files({ path })) as { ok: boolean; error?: string }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/escapes the workspace/)
    await workspaceTools.deactivate?.(ctx)
  })

  it("workspace_search rejects a root outside the workspace", async () => {
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_search({ pattern: "x", path: "../.." })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/escapes the workspace/)
    await workspaceTools.deactivate?.(ctx)
  })

  it("allows an absolute path that is genuinely inside the workspace", async () => {
    mockReadTextFile.mockResolvedValue("inside")
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_read_file({ path: `${WS}/src/a.ts` })) as {
      ok: boolean
      path?: string
    }
    expect(result.ok).toBe(true)
    expect(result.path).toBe(`${WS}/src/a.ts`)
    await workspaceTools.deactivate?.(ctx)
  })

  // The lexical resolver above cannot see a symlink, and git tracks symlinks —
  // so cloning a hostile repo into the workspace is enough to plant a link to
  // ~/.ssh that `readTextFile` / `readDir` follow straight out of the tree.
  describe("symlink escape", () => {
    /** Report `link` (and nothing else) as a symlink. */
    const linkAt = (link: string) =>
      mockLstat.mockImplementation(async (p: string) => ({ isSymlink: p === link }))

    it("workspace_read_file rejects a symlinked final component", async () => {
      linkAt(`${WS}/notes.txt`)
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_read_file({ path: "notes.txt" })) as {
        ok: boolean
        error?: string
      }
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/escapes the workspace via symlink/)
      expect(mockReadTextFile).not.toHaveBeenCalled()
      await workspaceTools.deactivate?.(ctx)
    })

    it("workspace_read_file rejects a symlinked intermediate directory", async () => {
      linkAt(`${WS}/docs`)
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_read_file({ path: "docs/id_rsa" })) as {
        ok: boolean
        error?: string
      }
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/escapes the workspace via symlink/)
      expect(mockReadTextFile).not.toHaveBeenCalled()
      await workspaceTools.deactivate?.(ctx)
    })

    it("workspace_list_files rejects a symlinked directory", async () => {
      linkAt(`${WS}/docs`)
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_list_files({ path: "docs" })) as {
        ok: boolean
        error?: string
      }
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/escapes the workspace via symlink/)
      expect(mockReadDir).not.toHaveBeenCalled()
      await workspaceTools.deactivate?.(ctx)
    })

    it("workspace_search does not follow a symlinked entry", async () => {
      mockReadDir.mockResolvedValue([
        { name: "escape", isDirectory: false, isFile: false, isSymlink: true },
        { name: "real.ts", isDirectory: false, isFile: true, isSymlink: false },
      ])
      mockReadTextFile.mockResolvedValue("hit")
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_search({ pattern: "hit" })) as {
        ok: boolean
        matches: Array<{ path: string }>
      }
      expect(result.ok).toBe(true)
      expect(result.matches.map((m) => m.path)).toEqual([`${WS}/real.ts`])
      expect(mockReadTextFile).not.toHaveBeenCalledWith(`${WS}/escape`)
      await workspaceTools.deactivate?.(ctx)
    })

    it("treats an unstattable component as clean so the real error surfaces", async () => {
      mockLstat.mockRejectedValue(new Error("ENOENT"))
      mockReadTextFile.mockRejectedValue(new Error("no such file"))
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      await expect(tools.workspace_read_file({ path: "missing.ts" })).rejects.toThrow(
        /no such file/
      )
      await workspaceTools.deactivate?.(ctx)
    })

    it("allows a workspace root that is itself reached through a symlink", async () => {
      linkAt(WS)
      mockReadTextFile.mockResolvedValue("inside")
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_read_file({ path: "a.ts" })) as { ok: boolean }
      expect(result.ok).toBe(true)
      await workspaceTools.deactivate?.(ctx)
    })
  })

  // A multi-GB file used to be pulled into a string before its length was
  // checked, so the bound has to be enforced from `stat` instead.
  it("workspace_search skips an oversized file without reading it", async () => {
    mockReadDir.mockResolvedValue([
      { name: "huge.bin", isDirectory: false, isFile: true, isSymlink: false },
    ])
    mockStat.mockResolvedValue({ size: 512 * 1024 + 1 })
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_search({ pattern: "x" })) as {
      ok: boolean
      truncated: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.truncated).toBe(true)
    expect(mockReadTextFile).not.toHaveBeenCalled()
    await workspaceTools.deactivate?.(ctx)
  })

  it("fails closed when no workspace is open", async () => {
    __setWorkspaceRootForTesting(null)
    const { ctx, tools } = makeDesktopCtx()
    await workspaceTools.activate?.(ctx)
    const result = (await tools.workspace_read_file({ path: "a.ts" })) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No workspace is open/)
    await workspaceTools.deactivate?.(ctx)
  })
})
