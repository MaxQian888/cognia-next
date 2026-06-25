jest.mock("@/lib/browser/agent-engine", () => {
  const engine = {
    navigate: jest.fn(async () => {}),
    snapshot: jest.fn(async () => ({
      generation: 3,
      url: "http://localhost/",
      title: "t",
      nodes: [],
    })),
    act: jest.fn(async () => ({ ok: true, error: null, generation: 3 })),
    readConsole: jest.fn(async () => [{ level: "warn", text: "x", ts: 1 }]),
    readNetwork: jest.fn(async () => []),
    getPage: jest.fn(async () => ({ url: "http://localhost/", title: "t" })),
  }
  return {
    __engine: engine,
    routeEngine: () => ({ engine, tier: "trusted", untrusted: false }),
  }
})
jest.mock("@cognia/plugin-sdk", () => ({
  defineContextProvider: (p: unknown) => p,
}))

import definition from "@/plugins/browser-tools/src/index"
import * as engineModule from "@/lib/browser/agent-engine"

const engine = (engineModule as unknown as { __engine: Record<string, jest.Mock> }).__engine

type Tools = Record<string, (args: unknown) => Promise<unknown>>

async function collectTools(): Promise<Tools> {
  const tools: Tools = {}
  const ctx = {
    pluginId: "cognia-browser-tools",
    logger: { info: jest.fn() },
    agent: {
      registerTool: (t: { name: string; execute: (a: unknown) => Promise<unknown> }) => {
        tools[t.name] = t.execute
      },
      context: { registerProvider: jest.fn() },
    },
  }
  await definition.activate!(ctx as never)
  return tools
}

beforeEach(() => Object.values(engine).forEach((m) => m.mockClear()))

describe("browser-tools plugin", () => {
  it("registers the full Phase-1 tool surface", async () => {
    const tools = await collectTools()
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "browser_navigate",
        "browser_snapshot",
        "browser_click",
        "browser_type",
        "browser_fill_form",
        "browser_select",
        "browser_hover",
        "browser_read_console",
        "browser_read_network",
        "browser_get_page",
      ])
    )
  })

  it("browser_navigate sets the url and returns a fresh snapshot + untrusted flag", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_navigate({ url: "http://localhost:3000/" })) as {
      navigated: string
      snapshot: { generation: number }
      untrusted: boolean
    }
    expect(engine.navigate).toHaveBeenCalledWith("http://localhost:3000/")
    expect(res.navigated).toBe("http://localhost:3000/")
    expect(res.snapshot.generation).toBe(3)
    expect(res.untrusted).toBe(false)
  })

  it("browser_click acts by ref and returns a refreshed snapshot", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_click({ ref: "e1" })) as {
      result: { ok: boolean }
      snapshot: { generation: number }
    }
    expect(engine.act).toHaveBeenCalledWith("e1", "click", {})
    expect(res.result.ok).toBe(true)
    expect(res.snapshot.generation).toBe(3)
  })

  it("browser_fill_form forwards the text arg", async () => {
    const tools = await collectTools()
    await tools.browser_fill_form({ ref: "e2", text: "hello" })
    expect(engine.act).toHaveBeenCalledWith("e2", "fill", { text: "hello" })
  })

  it("browser_read_console returns drained entries", async () => {
    const tools = await collectTools()
    const res = (await tools.browser_read_console({})) as { entries: unknown[] }
    expect(res.entries).toHaveLength(1)
  })
})
