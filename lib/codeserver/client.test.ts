jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"

import { CODESERVER_EVENTS, codeServerClient } from "./client"

const call = transport.call as jest.Mock

beforeEach(() => {
  call.mockReset().mockResolvedValue(undefined)
})

it("maps process commands to the right invoke names + args", () => {
  void codeServerClient.supported()
  expect(call).toHaveBeenCalledWith("codeserver_supported", {})

  void codeServerClient.ensure("/work/proj")
  expect(call).toHaveBeenCalledWith("codeserver_ensure", { root: "/work/proj" })

  void codeServerClient.status("/work/proj")
  expect(call).toHaveBeenCalledWith("codeserver_status", { root: "/work/proj" })

  void codeServerClient.stop("/work/proj")
  expect(call).toHaveBeenCalledWith("codeserver_stop", { root: "/work/proj" })

  void codeServerClient.stopAll()
  expect(call).toHaveBeenCalledWith("codeserver_stop_all", {})

  void codeServerClient.download()
  expect(call).toHaveBeenCalledWith("codeserver_download", {})
})

it("spreads the rect into the embed command payloads", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 }
  void codeServerClient.embedCreate("http://127.0.0.1:5/", rect)
  expect(call).toHaveBeenCalledWith("codeserver_embed_create", {
    url: "http://127.0.0.1:5/",
    ...rect,
  })

  void codeServerClient.embedSetBounds(rect)
  expect(call).toHaveBeenCalledWith("codeserver_embed_set_bounds", { ...rect })

  void codeServerClient.embedSetVisible(false, rect)
  expect(call).toHaveBeenCalledWith("codeserver_embed_set_visible", { visible: false, ...rect })

  void codeServerClient.embedNavigate("http://127.0.0.1:5/x")
  expect(call).toHaveBeenCalledWith("codeserver_embed_navigate", { url: "http://127.0.0.1:5/x" })

  void codeServerClient.embedDestroy()
  expect(call).toHaveBeenCalledWith("codeserver_embed_destroy", {})
})

it("exposes the download-progress event name", () => {
  expect(CODESERVER_EVENTS.downloadProgress).toBe("codeserver://download-progress")
})
