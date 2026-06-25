jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import { browserClient } from "./client"

const call = transport.call as jest.Mock
const rect = { x: 1, y: 2, width: 3, height: 4 }

beforeEach(() => call.mockReset().mockResolvedValue(undefined))

describe("browserClient (embedded pane)", () => {
  it("embedCreate flattens the rect alongside the url", async () => {
    call.mockResolvedValueOnce("browser-embed")
    await expect(browserClient.embedCreate("http://localhost:3000/", rect)).resolves.toBe(
      "browser-embed"
    )
    expect(call).toHaveBeenCalledWith("browser_embed_create", {
      url: "http://localhost:3000/",
      ...rect,
    })
  })

  it("embedSetBounds flattens the rect", async () => {
    await browserClient.embedSetBounds(rect)
    expect(call).toHaveBeenCalledWith("browser_embed_set_bounds", rect)
  })

  it("embedSetVisible passes the flag and bounds", async () => {
    await browserClient.embedSetVisible(false, rect)
    expect(call).toHaveBeenCalledWith("browser_embed_set_visible", { visible: false, ...rect })
  })

  it("embedNavigate forwards the url", async () => {
    await browserClient.embedNavigate("http://localhost:3000/x")
    expect(call).toHaveBeenCalledWith("browser_embed_navigate", { url: "http://localhost:3000/x" })
  })

  it("embedSetSelectMode forwards the flag", async () => {
    await browserClient.embedSetSelectMode(true)
    expect(call).toHaveBeenCalledWith("browser_embed_set_select_mode", { on: true })
  })

  it("embedCapture returns the screenshot for the rect", async () => {
    call.mockResolvedValueOnce({ bytes: "AAAA", width: 10, height: 10 })
    const shot = await browserClient.embedCapture(rect)
    expect(shot.bytes).toBe("AAAA")
    expect(call).toHaveBeenCalledWith("browser_embed_capture", rect)
  })

  it("embedReload and embedDestroy take no args", async () => {
    await browserClient.embedReload()
    expect(call).toHaveBeenCalledWith("browser_embed_reload", {})
    await browserClient.embedDestroy()
    expect(call).toHaveBeenCalledWith("browser_embed_destroy", {})
  })
})

describe("browserClient agent methods", () => {
  it("embedSnapshot unwraps the ok envelope", async () => {
    call.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        error: null,
        snapshot: { generation: 1, url: "u", title: "t", nodes: [] },
      })
    )
    const snap = await browserClient.embedSnapshot()
    expect(call).toHaveBeenCalledWith("browser_embed_snapshot", {})
    expect(snap.generation).toBe(1)
  })

  it("embedSnapshot throws on ok:false", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ ok: false, error: "kaboom", snapshot: null }))
    await expect(browserClient.embedSnapshot()).rejects.toThrow("kaboom")
  })

  it("embedAct passes reference/action/serialized args", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ ok: true, error: null, generation: 2 }))
    const res = await browserClient.embedAct("e1", "click", {})
    expect(call).toHaveBeenCalledWith("browser_embed_act", {
      reference: "e1",
      action: "click",
      args: "{}",
    })
    expect(res.generation).toBe(2)
  })

  it("embedReadConsole parses the array", async () => {
    call.mockResolvedValueOnce(JSON.stringify([{ level: "warn", text: "x", ts: 1 }]))
    const out = await browserClient.embedReadConsole()
    expect(call).toHaveBeenCalledWith("browser_embed_drain_console", {})
    expect(out).toHaveLength(1)
  })

  it("embedReadNetwork parses the array", async () => {
    call.mockResolvedValueOnce(
      JSON.stringify([{ url: "u", method: "GET", status: 200, ok: true, durationMs: 3 }])
    )
    expect(await browserClient.embedReadNetwork()).toHaveLength(1)
  })

  it("nav primitives dispatch by name", async () => {
    await browserClient.embedBack()
    await browserClient.embedForward()
    await browserClient.embedStop()
    expect(call).toHaveBeenNthCalledWith(1, "browser_embed_back", {})
    expect(call).toHaveBeenNthCalledWith(2, "browser_embed_forward", {})
    expect(call).toHaveBeenNthCalledWith(3, "browser_embed_stop", {})
  })

  it("getUrl/getTitle return strings", async () => {
    call.mockResolvedValueOnce("http://localhost/").mockResolvedValueOnce("Home")
    expect(await browserClient.embedGetUrl()).toBe("http://localhost/")
    expect(await browserClient.embedGetTitle()).toBe("Home")
  })
})
