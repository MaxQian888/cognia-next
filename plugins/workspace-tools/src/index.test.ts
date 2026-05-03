/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

import workspaceTools from "./index"

const makeCtx = () => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
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
  }
  return { ctx: ctx as PluginContext, tools }
}

describe("workspace-tools (built-in)", () => {
  it("registers three tools on activate", async () => {
    const { ctx, tools } = makeCtx()
    await workspaceTools.activate?.(ctx)
    expect(Object.keys(tools).sort()).toEqual([
      "workspace_list_files",
      "workspace_read_file",
      "workspace_search",
    ])
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
})
