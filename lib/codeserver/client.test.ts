jest.mock("@/lib/tauri", () => ({ transport: { call: jest.fn() } }))

import { transport } from "@/lib/tauri"
import { __resetRoutingForTests, setActiveRemoteEndpoint } from "@/lib/tauri/transport-routing"

import { CODESERVER_EVENTS, codeServerClient } from "./client"

const call = transport.call as jest.Mock

beforeEach(() => {
  __resetRoutingForTests()
  call.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  __resetRoutingForTests()
})

it("converts a remote relay path into a certificate-pinned local port", async () => {
  setActiveRemoteEndpoint({
    baseUrl: "https://remote.example:27890",
    deviceJwt: "device-jwt",
    serverFingerprint: "ab".repeat(32),
  })
  call
    .mockResolvedValueOnce({
      running: true,
      port: null,
      version: "4.128.0",
      profile: "managed",
      relayPath: "/ide/v1/relay/session/",
    })
    .mockResolvedValueOnce({ port: 43123, url: "http://127.0.0.1:43123/" })

  await expect(codeServerClient.ensure("/remote/work")).resolves.toMatchObject({
    running: true,
    port: 43123,
  })
  expect(call).toHaveBeenNthCalledWith(2, "codeserver_remote_relay_ensure", {
    baseUrl: "https://remote.example:27890",
    deviceJwt: "device-jwt",
    serverFingerprint: "ab".repeat(32),
    relayPath: "/ide/v1/relay/session/",
  })
})

it("fails closed when a remote host has no paired certificate fingerprint", async () => {
  setActiveRemoteEndpoint({
    baseUrl: "https://remote.example:27890",
    deviceJwt: "device-jwt",
  })
  call.mockResolvedValueOnce({
    running: true,
    port: null,
    version: "4.128.0",
    relayPath: "/ide/v1/relay/session/",
  })

  await expect(codeServerClient.ensure("/remote/work")).rejects.toThrow(
    "missing its paired certificate fingerprint"
  )
  expect(call).toHaveBeenCalledTimes(1)
})

it("maps process commands to the right invoke names + args", () => {
  void codeServerClient.supported()
  expect(call).toHaveBeenCalledWith("codeserver_supported", {})

  void codeServerClient.ensure("/work/proj")
  expect(call).toHaveBeenCalledWith("codeserver_ensure", {
    root: "/work/proj",
    profile: "managed",
  })

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

  const artifact = {
    pluginId: "acme",
    pluginVersion: "2.0.0",
    manifestHash: "sha256:manifest",
    catalogHash: "sha256:catalog",
    platformVersion: "1.0.0",
    sha256: "proxy",
    signature: "signature",
    publicKey: "public-key",
    vsixPath: "/cache/acme.vsix",
    executables: [],
  }
  void codeServerClient.activateProxy(artifact)
  expect(call).toHaveBeenCalledWith("codeserver_activate_proxy", { artifact })

  void codeServerClient.readUserSettings()
  expect(call).toHaveBeenCalledWith("codeserver_read_user_settings", { profile: "managed" })

  void codeServerClient.writeUserSettings("{}")
  expect(call).toHaveBeenCalledWith("codeserver_write_user_settings", {
    contents: "{}",
    profile: "managed",
  })

  void codeServerClient.respondToBroker(
    { root: "/work/proj", generation: 3, id: "proxy:2" },
    { result: { ok: true } }
  )
  expect(call).toHaveBeenCalledWith("codeserver_broker_respond", {
    root: "/work/proj",
    generation: 3,
    id: "proxy:2",
    result: { ok: true },
    error: undefined,
  })

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

  void codeServerClient.driveOpen("/work/proj", "/work/proj/src/index.ts", 12, 4)
  expect(call).toHaveBeenCalledWith("codeserver_agent_open", {
    root: "/work/proj",
    path: "/work/proj/src/index.ts",
    line: 12,
    column: 4,
  })

  void codeServerClient.driveApplyEdit("/work/proj", "/work/proj/src/index.ts", 12, 4)
  expect(call).toHaveBeenCalledWith("codeserver_agent_apply_edit", {
    root: "/work/proj",
    path: "/work/proj/src/index.ts",
    line: 12,
    column: 4,
  })

  void codeServerClient.readActive("/work/proj")
  expect(call).toHaveBeenCalledWith("codeserver_agent_read_active", { root: "/work/proj" })
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
  expect(CODESERVER_EVENTS.brokerRequest).toBe("codeserver://broker-request")
  expect(CODESERVER_EVENTS.brokerNotification).toBe("codeserver://broker-notification")
})

it("validates broker paths on the IDE host", () => {
  void codeServerClient.validateBrokerPaths("/work/proj", ["/work/proj/src/index.ts"])
  expect(call).toHaveBeenCalledWith("codeserver_broker_validate_paths", {
    root: "/work/proj",
    paths: ["/work/proj/src/index.ts"],
  })
})

it("creates and redeems scoped broker content handles", () => {
  void codeServerClient.createBrokerContent(
    "/work/proj",
    4,
    "acme",
    "cognia.acme.fs",
    "filesystem:write",
    "application/octet-stream",
    [1, 2, 3]
  )
  expect(call).toHaveBeenCalledWith("codeserver_broker_content_create", {
    root: "/work/proj",
    generation: 4,
    pluginId: "acme",
    providerId: "cognia.acme.fs",
    permission: "filesystem:write",
    mediaType: "application/octet-stream",
    bytes: [1, 2, 3],
  })

  void codeServerClient.redeemBrokerContent(
    "/work/proj",
    4,
    "acme",
    "cognia.acme.fs",
    "filesystem:write",
    "handle"
  )
  expect(call).toHaveBeenCalledWith("codeserver_broker_content_redeem", {
    root: "/work/proj",
    generation: 4,
    pluginId: "acme",
    providerId: "cognia.acme.fs",
    permission: "filesystem:write",
    handleId: "handle",
  })
})
