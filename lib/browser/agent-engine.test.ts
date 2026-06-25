jest.mock("@/lib/browser/client", () => ({
  browserClient: {
    embedNavigate: jest.fn(async () => {}),
    embedSnapshot: jest.fn(async () => ({ generation: 1, url: "u", title: "t", nodes: [] })),
    embedAct: jest.fn(async () => ({ ok: true, error: null, generation: 1 })),
    embedReadConsole: jest.fn(async () => []),
    embedReadNetwork: jest.fn(async () => []),
    embedBack: jest.fn(async () => {}),
    embedForward: jest.fn(async () => {}),
    embedReload: jest.fn(async () => {}),
    embedGetUrl: jest.fn(async () => "http://localhost/"),
    embedGetTitle: jest.fn(async () => "Home"),
  },
}))

import { browserClient } from "@/lib/browser/client"
import { routeEngine, EmbeddedEngine } from "@/lib/browser/agent-engine"

const mockClient = browserClient as unknown as Record<string, jest.Mock>

beforeEach(() => Object.values(mockClient).forEach((m) => m.mockClear()))

describe("routeEngine", () => {
  it("routes localhost to the embedded engine, trusted tier", () => {
    const r = routeEngine("http://localhost:3000/")
    expect(r.engine).toBeInstanceOf(EmbeddedEngine)
    expect(r.tier).toBe("trusted")
    expect(r.untrusted).toBe(false)
  })

  it("flags public URLs as untrusted (still embedded in Phase 1)", () => {
    const r = routeEngine("https://example.com/")
    expect(r.tier).toBe("public")
    expect(r.untrusted).toBe(true)
    expect(r.engine).toBeInstanceOf(EmbeddedEngine)
  })
})

describe("EmbeddedEngine", () => {
  it("act delegates to browserClient.embedAct", async () => {
    await new EmbeddedEngine().act("e1", "click", {})
    expect(mockClient.embedAct).toHaveBeenCalledWith("e1", "click", {})
  })

  it("getPage combines url + title", async () => {
    const page = await new EmbeddedEngine().getPage()
    expect(page).toEqual({ url: "http://localhost/", title: "Home" })
  })

  it("snapshot/navigate/console/network delegate", async () => {
    const e = new EmbeddedEngine()
    await e.navigate("http://localhost/")
    await e.snapshot()
    await e.readConsole()
    await e.readNetwork()
    expect(mockClient.embedNavigate).toHaveBeenCalledWith("http://localhost/")
    expect(mockClient.embedSnapshot).toHaveBeenCalled()
    expect(mockClient.embedReadConsole).toHaveBeenCalled()
    expect(mockClient.embedReadNetwork).toHaveBeenCalled()
  })

  it("back/forward/stop/reload delegate to browserClient", async () => {
    const e = new EmbeddedEngine()
    await e.back()
    await e.forward()
    await e.reload()
    expect(mockClient.embedBack).toHaveBeenCalled()
    expect(mockClient.embedForward).toHaveBeenCalled()
    expect(mockClient.embedReload).toHaveBeenCalled()
  })
})
