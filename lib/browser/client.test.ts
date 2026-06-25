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
