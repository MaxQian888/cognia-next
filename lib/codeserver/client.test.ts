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

  void codeServerClient.diskUsage()
  expect(call).toHaveBeenCalledWith("codeserver_disk_usage", {})

  void codeServerClient.readUserSettings()
  expect(call).toHaveBeenCalledWith("codeserver_read_user_settings", {})

  void codeServerClient.writeUserSettings("{}")
  expect(call).toHaveBeenCalledWith("codeserver_write_user_settings", { contents: "{}" })

  void codeServerClient.localVsCodeAvailable()
  expect(call).toHaveBeenCalledWith("codeserver_local_vscode_available", {})

  void codeServerClient.openInLocalVsCode("/work/proj", 3, 1)
  expect(call).toHaveBeenCalledWith("codeserver_open_in_local_vscode", {
    path: "/work/proj",
    line: 3,
    column: 1,
  })

  void codeServerClient.uninstall(true)
  expect(call).toHaveBeenCalledWith("codeserver_uninstall", { everything: true })

  void codeServerClient.openFile("/work/proj", "src/index.ts", 12, 4)
  expect(call).toHaveBeenCalledWith("codeserver_open_file", {
    root: "/work/proj",
    path: "src/index.ts",
    line: 12,
    column: 4,
  })
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

it("exposes the backend event names", () => {
  expect(CODESERVER_EVENTS.downloadProgress).toBe("codeserver://download-progress")
  expect(CODESERVER_EVENTS.instanceExited).toBe("codeserver://instance-exited")
})
