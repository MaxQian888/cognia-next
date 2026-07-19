jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import { browserClient } from "./client"

const call = transport.call as jest.Mock
const rect = { x: 1, y: 2, width: 3, height: 4 }

beforeEach(() => {
  call.mockReset().mockResolvedValue(undefined)
  browserClient.setEmbedOwnerToken("owner-1")
})

describe("browserClient (embedded pane)", () => {
  it("embedCreate flattens the rect alongside the url", async () => {
    call.mockResolvedValueOnce("browser-embed")
    await expect(browserClient.embedCreate("http://localhost:3000/", rect)).resolves.toBe(
      "browser-embed"
    )
    expect(call).toHaveBeenCalledWith("browser_embed_create", {
      url: "http://localhost:3000/",
      ownerToken: "owner-1",
      ...rect,
    })
  })

  it("embedSetBounds flattens the rect", async () => {
    await browserClient.embedSetBounds(rect)
    expect(call).toHaveBeenCalledWith("browser_embed_set_bounds", {
      ownerToken: "owner-1",
      ...rect,
    })
  })

  it("embedSetVisible passes the flag and bounds", async () => {
    await browserClient.embedSetVisible(false, rect)
    expect(call).toHaveBeenCalledWith("browser_embed_set_visible", {
      visible: false,
      ownerToken: "owner-1",
      ...rect,
    })
  })

  it("embedNavigate forwards the url", async () => {
    await browserClient.embedNavigate("http://localhost:3000/x")
    expect(call).toHaveBeenCalledWith("browser_embed_navigate", {
      url: "http://localhost:3000/x",
      ownerToken: "owner-1",
    })
  })

  it("embedSetSelectMode forwards the flag", async () => {
    await browserClient.embedSetSelectMode(true)
    expect(call).toHaveBeenCalledWith("browser_embed_set_select_mode", {
      on: true,
      ownerToken: "owner-1",
    })
  })

  it("embedClearSelection takes no args", async () => {
    await browserClient.embedClearSelection()
    expect(call).toHaveBeenCalledWith("browser_embed_clear_selection", {
      ownerToken: "owner-1",
    })
  })

  it("embedSetPanelLabels serializes the labels to a JSON string", async () => {
    await browserClient.embedSetPanelLabels({ details: "Details", collapse: "Collapse" })
    expect(call).toHaveBeenCalledWith("browser_embed_set_panel_labels", {
      labels: JSON.stringify({ details: "Details", collapse: "Collapse" }),
      ownerToken: "owner-1",
    })
  })

  it("embedCapture returns the screenshot for the rect", async () => {
    call
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ bytes: "AAAA", width: 10, height: 10 })
      .mockResolvedValueOnce(undefined)
    const pending = browserClient.embedCapture(rect)
    const shot = await pending
    expect(shot.bytes).toBe("AAAA")
    expect(call.mock.calls).toEqual([
      ["browser_embed_set_frozen", { on: true, ownerToken: "owner-1" }],
      ["browser_embed_capture", { ...rect, ownerToken: "owner-1" }],
      ["browser_embed_set_frozen", { on: false, ownerToken: "owner-1" }],
    ])
  })

  it("always unfreezes when capture fails", async () => {
    call.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("capture failed"))
    const pending = browserClient.embedCapture(rect)
    const assertion = expect(pending).rejects.toThrow("capture failed")
    await assertion
    expect(call).toHaveBeenLastCalledWith("browser_embed_set_frozen", {
      on: false,
      ownerToken: "owner-1",
    })
  })

  it("attempts to unfreeze when freezing fails", async () => {
    call.mockRejectedValueOnce(new Error("freeze failed")).mockResolvedValueOnce(undefined)
    await expect(browserClient.embedCapture(rect)).rejects.toThrow("freeze failed")
    expect(call.mock.calls).toEqual([
      ["browser_embed_set_frozen", { on: true, ownerToken: "owner-1" }],
      ["browser_embed_set_frozen", { on: false, ownerToken: "owner-1" }],
    ])
  })

  it("embedReload and embedDestroy take no args", async () => {
    await browserClient.embedReload()
    expect(call).toHaveBeenCalledWith("browser_embed_reload", { ownerToken: "owner-1" })
    await browserClient.embedDestroy()
    expect(call).toHaveBeenCalledWith("browser_embed_destroy", { ownerToken: "owner-1" })
  })
})

describe("browserClient agent methods", () => {
  it("embedDrainSelection unwraps the bulk envelope", async () => {
    const selection = {
      paneId: "browser-embed",
      selector: "#go",
      domPath: "button#go",
      tagName: "button",
      id: "go",
      classes: null,
      rect: { x: 0, y: 0, width: 10, height: 10 },
      outerHTML: '<button id="go"></button>',
      text: "Go",
      pageUrl: "http://localhost/",
      pageTitle: "Home",
    }
    call.mockResolvedValueOnce(JSON.stringify({ ok: true, error: null, selections: [selection] }))
    await expect(browserClient.embedDrainSelection()).resolves.toEqual([selection])
    expect(call).toHaveBeenCalledWith("browser_embed_drain_selection", {
      ownerToken: "owner-1",
    })
  })

  it("embedDrainSelection surfaces an error envelope", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ ok: false, error: "page gone", selections: [] }))
    await expect(browserClient.embedDrainSelection()).rejects.toThrow("page gone")
  })

  it.each([
    "null",
    JSON.stringify({ ok: "yes", selections: [] }),
    JSON.stringify({ ok: true, selections: [{ selector: "#missing-shape" }] }),
  ])("embedDrainSelection rejects an untrusted runtime payload", async (raw) => {
    call.mockResolvedValueOnce(raw)
    await expect(browserClient.embedDrainSelection()).rejects.toThrow(/invalid selection drain/)
  })

  it("embedSnapshot unwraps the ok envelope", async () => {
    call.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        error: null,
        snapshot: { generation: 1, url: "u", title: "t", nodes: [] },
      })
    )
    const snap = await browserClient.embedSnapshot()
    expect(call).toHaveBeenCalledWith("browser_embed_snapshot", { ownerToken: "owner-1" })
    expect(snap.generation).toBe(1)
  })

  it("embedSnapshot throws on ok:false", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ ok: false, error: "kaboom", snapshot: null }))
    await expect(browserClient.embedSnapshot()).rejects.toThrow("kaboom")
  })

  it("embedSnapshot forwards options as a JSON args string", async () => {
    call.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        error: null,
        snapshot: { generation: 1, url: "u", title: "t", nodes: [] },
      })
    )
    await browserClient.embedSnapshot({ includeText: true })
    expect(call).toHaveBeenCalledWith("browser_embed_snapshot", {
      args: JSON.stringify({ includeText: true }),
      ownerToken: "owner-1",
    })
  })

  it("embedEvaluate forwards the expression and parses the envelope", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ ok: true, value: "Home" }))
    const res = await browserClient.embedEvaluate("document.title")
    expect(call).toHaveBeenCalledWith("browser_embed_evaluate", {
      expr: "document.title",
      ownerToken: "owner-1",
    })
    expect(res).toEqual({ ok: true, value: "Home" })
  })

  it("embedHasSelector forwards the selector", async () => {
    call.mockResolvedValueOnce(true)
    expect(await browserClient.embedHasSelector(".ready")).toBe(true)
    expect(call).toHaveBeenCalledWith("browser_embed_has_selector", {
      selector: ".ready",
      ownerToken: "owner-1",
    })
  })

  it("embedNetworkState parses the counters", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ pending: 1, completed: 4 }))
    expect(await browserClient.embedNetworkState()).toEqual({ pending: 1, completed: 4 })
    expect(call).toHaveBeenCalledWith("browser_embed_network_state", { ownerToken: "owner-1" })
  })

  it("embedAct passes reference/action/serialized args", async () => {
    call.mockResolvedValueOnce(JSON.stringify({ ok: true, error: null, generation: 2 }))
    const res = await browserClient.embedAct("e1", "click", {})
    expect(call).toHaveBeenCalledWith("browser_embed_act", {
      reference: "e1",
      action: "click",
      args: "{}",
      ownerToken: "owner-1",
    })
    expect(res.generation).toBe(2)
  })

  it("embedReadConsole parses the array", async () => {
    call.mockResolvedValueOnce(JSON.stringify([{ level: "warn", text: "x", ts: 1 }]))
    const out = await browserClient.embedReadConsole()
    expect(call).toHaveBeenCalledWith("browser_embed_drain_console", { ownerToken: "owner-1" })
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
    expect(call).toHaveBeenNthCalledWith(1, "browser_embed_back", { ownerToken: "owner-1" })
    expect(call).toHaveBeenNthCalledWith(2, "browser_embed_forward", { ownerToken: "owner-1" })
    expect(call).toHaveBeenNthCalledWith(3, "browser_embed_stop", { ownerToken: "owner-1" })
  })

  it("getUrl/getTitle return strings", async () => {
    call.mockResolvedValueOnce("http://localhost/").mockResolvedValueOnce("Home")
    expect(await browserClient.embedGetUrl()).toBe("http://localhost/")
    expect(await browserClient.embedGetTitle()).toBe("Home")
  })

  it("embedHasText forwards the text and returns the boolean", async () => {
    call.mockResolvedValueOnce(true)
    expect(await browserClient.embedHasText("Loaded")).toBe(true)
    expect(call).toHaveBeenCalledWith("browser_embed_has_text", {
      text: "Loaded",
      ownerToken: "owner-1",
    })
  })

  describe("action recording", () => {
    it("start/stop take no arguments", async () => {
      call.mockResolvedValue("1")
      await browserClient.embedStartRecord()
      await browserClient.embedStopRecord()
      expect(call).toHaveBeenNthCalledWith(1, "browser_embed_start_record", {
        ownerToken: "owner-1",
      })
      expect(call).toHaveBeenNthCalledWith(2, "browser_embed_stop_record", {
        ownerToken: "owner-1",
      })
    })

    it("embedDrainRecord parses the json array the page returns", async () => {
      const step = {
        act: "click",
        at: 1,
        target: { selector: "#go", role: "button", name: "Go", domPath: "body > button" },
      }
      call.mockResolvedValueOnce(JSON.stringify([step]))
      expect(await browserClient.embedDrainRecord()).toEqual([step])
      expect(call).toHaveBeenCalledWith("browser_embed_drain_record", {
        ownerToken: "owner-1",
      })
    })

    it("embedDrainRecord yields an empty list when nothing was buffered", async () => {
      call.mockResolvedValueOnce("[]")
      expect(await browserClient.embedDrainRecord()).toEqual([])
    })
  })
})
