/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"
import type { PluginNodeDef } from "@/types/plugin/plugin-workflow"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

// Controllable fs double so the desktop tool paths (list / read / search) can
// run under jsdom without a real Tauri host. The factory is hoisted, so it
// references the mocks lazily.
const mockReadDir = jest.fn(async (_p: string) => [] as Array<Record<string, unknown>>)
const mockReadTextFile = jest.fn(async (_p: string) => "")
jest.mock(
  "@tauri-apps/plugin-fs",
  () => ({
    readDir: (...a: unknown[]) => (mockReadDir as (...x: unknown[]) => unknown)(...a),
    readTextFile: (...a: unknown[]) => (mockReadTextFile as (...x: unknown[]) => unknown)(...a),
  }),
  { virtual: true }
)

import workspaceTools from "./index"

/** ctx that reports a Tauri host so the desktop tool bodies run. */
const makeDesktopCtx = () => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const nodes: Record<string, PluginNodeDef> = {}
  const ctx = {
    pluginId: "cognia-workspace-tools",
    capabilities: { tauri: true },
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
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
    },
    workflow: {
      registerNode: (node: PluginNodeDef) => {
        nodes[node.kind] = node
        return jest.fn()
      },
    },
  } as unknown as import("@/types/plugin").PluginContext
  return { ctx, tools, nodes }
}

const makeCtx = () => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const nodes: Record<string, PluginNodeDef> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-workspace-tools",
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
      expect(result.path).toBe("src")
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
        if (dir === ".") {
          return [
            { name: ".git", isDirectory: true, isFile: false },
            { name: "src", isDirectory: true, isFile: false },
            { name: "readme.md", isDirectory: false, isFile: true },
            { name: "binary.bin", isDirectory: false, isFile: true },
          ]
        }
        if (dir === "./src") {
          return [{ name: "app.ts", isDirectory: false, isFile: true }]
        }
        return []
      })
      mockReadTextFile.mockImplementation(async (path: string) => {
        if (path === "./binary.bin") throw new Error("not utf-8")
        if (path === "./src/app.ts") return "const TODO = 1\nconst ok = 2"
        if (path === "./readme.md") return "nothing here"
        return ""
      })
      const { ctx, tools } = makeDesktopCtx()
      await workspaceTools.activate?.(ctx)
      const result = (await tools.workspace_search({ pattern: "TODO" })) as {
        ok: boolean
        matches: Array<{ path: string; line: number; text: string }>
      }
      expect(result.ok).toBe(true)
      expect(result.matches).toEqual([{ path: "./src/app.ts", line: 1, text: "const TODO = 1" }])
      // The dotdir was never descended into.
      expect(mockReadDir).not.toHaveBeenCalledWith("./.git")
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
        path: "src",
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
        path: "note.txt",
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
        matches: [{ path: "./readme.md", line: 2, text: "needle" }],
      })
      await workspaceTools.deactivate?.(ctx)
    })
  })
})
