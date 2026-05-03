/**
 * @jest-environment jsdom
 */

import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/tauri", () => ({ isTauri: () => false }))

import webTools from "./index"

const makeCtx = (config: Record<string, unknown> = {}) => {
  const tools: Record<string, (args: unknown) => Promise<unknown>> = {}
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-web-tools",
    config,
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

describe("web-tools (built-in)", () => {
  beforeEach(() => {
    // jsdom 22+ has fetch; we replace with a controlled mock per test.
    ;(globalThis as { fetch: unknown }).fetch = jest.fn()
  })

  it("registers web_fetch + web_download on activate", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    expect(Object.keys(tools).sort()).toEqual(["web_download", "web_fetch"])
  })

  it("web_fetch requires a url", async () => {
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = await tools.web_fetch({})
    expect(result).toMatchObject({ ok: false })
  })

  it("web_fetch returns body / status from a successful request", async () => {
    ;(globalThis as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Map([["content-type", "text/plain"]]),
      text: async () => "hello world",
    }))
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_fetch({ url: "https://example.com" })) as {
      ok: boolean
      status: number
      body: string
    }
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body).toContain("hello world")
  })

  it("web_fetch traps fetch errors", async () => {
    ;(globalThis as { fetch: jest.Mock }).fetch = jest.fn(async () => {
      throw new Error("boom")
    })
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = await tools.web_fetch({ url: "https://example.com" })
    expect(result).toMatchObject({ ok: false, error: "boom" })
  })

  it("web_download falls back to a browser <a> when not in Tauri", async () => {
    ;(globalThis as { fetch: jest.Mock }).fetch = jest.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }))
    // jsdom doesn't ship URL.createObjectURL — stub it for this test.
    ;(URL as unknown as { createObjectURL: jest.Mock }).createObjectURL = jest.fn(() => "blob:mock")
    ;(URL as unknown as { revokeObjectURL: jest.Mock }).revokeObjectURL = jest.fn()
    const click = jest.fn()
    const create = jest.spyOn(document, "createElement").mockImplementation((tag) => {
      if (tag === "a") {
        return { href: "", download: "", click } as unknown as HTMLAnchorElement
      }
      return document.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElement
    })
    const { ctx, tools } = makeCtx()
    await webTools.activate?.(ctx)
    const result = (await tools.web_download({
      url: "https://example.com/foo.bin",
    })) as { ok: boolean; downloadedAs: string; bytes: number }
    expect(result.ok).toBe(true)
    expect(result.bytes).toBe(8)
    expect(click).toHaveBeenCalled()
    create.mockRestore()
  })
})
