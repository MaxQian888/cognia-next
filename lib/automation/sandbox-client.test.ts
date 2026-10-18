import {
  isSandboxStreamUnavailable,
  sandboxClient,
  SANDBOX_STREAM_UNAVAILABLE,
} from "@/lib/automation/sandbox-client"
import { transport } from "@/lib/tauri"

jest.mock("@/lib/tauri", () => ({
  transport: { call: jest.fn() },
}))

const call = transport.call as jest.Mock

beforeEach(() => call.mockReset())

test("binary uploads bind the connection, exact container and current controller lease", async () => {
  const receipt = { path: "/home/cua/proof.bin", size: 3, sha256: "digest" }
  call.mockResolvedValueOnce(receipt)
  await expect(
    sandboxClient.uploadFile("c1", "container-1", "fresh-lease", receipt.path, "AP+A")
  ).resolves.toEqual(receipt)
  expect(call).toHaveBeenCalledWith("cua_sandbox_upload_file", {
    connectionId: "c1",
    expectedContainerId: "container-1",
    token: "fresh-lease",
    path: receipt.path,
    dataBase64: "AP+A",
  })
})

test("binary downloads preserve bytes and refuse container replacement errors", async () => {
  const download = { path: "/home/cua/proof.bin", size: 3, sha256: "digest", dataBase64: "AP+A" }
  call.mockResolvedValueOnce(download)
  await expect(sandboxClient.downloadFile("c1", "container-1", download.path)).resolves.toEqual(
    download
  )
  expect(call).toHaveBeenCalledWith("cua_sandbox_download_file", {
    connectionId: "c1",
    expectedContainerId: "container-1",
    path: download.path,
  })
  call.mockRejectedValueOnce(new Error("Container identity changed"))
  await expect(sandboxClient.downloadFile("c1", "container-1", download.path)).rejects.toThrow(
    "Container identity changed"
  )
})

test("start invokes cua_sandbox_start with connectionId + image", async () => {
  call.mockResolvedValueOnce(49160)
  const port = await sandboxClient.start("c1", "ghcr.io/trycua/cua-xfce:latest")
  expect(call).toHaveBeenCalledWith("cua_sandbox_start", {
    connectionId: "c1",
    image: "ghcr.io/trycua/cua-xfce:latest",
  })
  expect(port).toBe(49160)
})

test("stop invokes cua_sandbox_stop", async () => {
  call.mockResolvedValueOnce(undefined)
  await sandboxClient.stop("c1")
  expect(call).toHaveBeenCalledWith("cua_sandbox_stop", { connectionId: "c1" })
})

test("health invokes cua_sandbox_health", async () => {
  call.mockResolvedValueOnce(true)
  expect(await sandboxClient.health("c1")).toBe(true)
  expect(call).toHaveBeenCalledWith("cua_sandbox_health", { connectionId: "c1" })
})

test("desktop observation and control stay scoped to the same connection and lease", async () => {
  await sandboxClient.desktopFrame("c1")
  await sandboxClient.acquireControl("c1", true)
  await sandboxClient.renewControl("c1", "lease", 7)
  await sandboxClient.controlInput("c1", "lease", 7, "frame-1", { x: 12, y: 30 }, { kind: "click" })
  await sandboxClient.releaseControl("c1", "lease", 7)
  expect(call.mock.calls).toEqual([
    ["cua_sandbox_desktop_capture", { connectionId: "c1" }],
    ["cua_sandbox_desktop_acquire_control", { connectionId: "c1", takeover: true }],
    ["cua_sandbox_desktop_renew_control", { connectionId: "c1", token: "lease", fence: 7 }],
    [
      "cua_sandbox_desktop_input",
      {
        connectionId: "c1",
        token: "lease",
        fence: 7,
        frameId: "frame-1",
        point: { x: 12, y: 30 },
        action: { kind: "click" },
      },
    ],
    ["cua_sandbox_desktop_release_control", { connectionId: "c1", token: "lease", fence: 7 }],
  ])
})

test("stream grants open, claim with the lease, and close by viewer id", async () => {
  const grant = { viewerId: "v1", url: "http://127.0.0.1:49000/?token=t", role: "viewer" }
  call.mockResolvedValue(grant)
  await expect(sandboxClient.streamOpen("c1")).resolves.toEqual(grant)
  expect(call).toHaveBeenLastCalledWith("cua_sandbox_desktop_stream_open", { connectionId: "c1" })
  await sandboxClient.streamClaim("c1", "v1", "lease", 7)
  expect(call).toHaveBeenLastCalledWith("cua_sandbox_desktop_stream_claim", {
    connectionId: "c1",
    viewerId: "v1",
    token: "lease",
    fence: 7,
  })
  await sandboxClient.streamClose("c1", "v1")
  expect(call).toHaveBeenLastCalledWith("cua_sandbox_desktop_stream_close", {
    connectionId: "c1",
    viewerId: "v1",
  })
})

test("a sandbox without Selkies is recognised by its refusal code", () => {
  expect(
    isSandboxStreamUnavailable(new Error(`Backend error: ${SANDBOX_STREAM_UNAVAILABLE}`))
  ).toBe(true)
  expect(isSandboxStreamUnavailable(SANDBOX_STREAM_UNAVAILABLE)).toBe(true)
  expect(isSandboxStreamUnavailable(new Error("docker port failed"))).toBe(false)
})
