import { transport } from "@/lib/tauri/transport-instance"
import {
  sandboxPreviewContext,
  sandboxPreviewCreate,
  sandboxPreviewList,
  sandboxPreviewOpen,
  sandboxPreviewRevoke,
  pairedPreviewDeviceId,
  pairedPreviewSupport,
} from "./previews"

const call = jest.spyOn(transport, "call")
beforeEach(() => call.mockReset().mockResolvedValue({ items: [] }))

it("gets runtime targets and deployment-wide snapshot usage from the Host", async () => {
  await sandboxPreviewContext("p")
  expect(call).toHaveBeenCalledWith("sandbox_preview_context", { projectId: "p" })
})

it("sends lease offsets without resolving them against the source workspace", async () => {
  const request = {
    projectId: "p",
    workspaceId: "fork",
    provider: "local",
    containerId: "c",
    port: { kind: "workspace-lease-offset" as const, offset: 2 },
    audience: { kind: "localOwner" as const },
    expiresInSeconds: 900,
  }
  await sandboxPreviewCreate(request)
  expect(call).toHaveBeenCalledWith("sandbox_preview_create", { request })
})

it("lists safe metadata and only obtains bootstrap tokens through create/open", async () => {
  await sandboxPreviewList("p")
  await sandboxPreviewList("p", "w")
  await sandboxPreviewOpen("g")
  await sandboxPreviewRevoke("g")
  expect(call.mock.calls).toEqual([
    ["sandbox_preview_list", { projectId: "p" }],
    ["sandbox_preview_list", { projectId: "p", workspaceId: "w" }],
    ["sandbox_preview_open", { grantId: "g" }],
    ["sandbox_preview_revoke", { grantId: "g" }],
  ])
})

it("only the desktop app can open a paired-device grant", () => {
  expect(pairedPreviewSupport("desktop")).toBe("desktopRelay")
  for (const platform of ["ios", "android", "web", "browser", "unknown"] as const)
    expect(pairedPreviewSupport(platform)).toBe("unsupported")
  expect(pairedPreviewDeviceId({ audience: { kind: "pairedDevice", deviceId: "d" } })).toBe("d")
  expect(pairedPreviewDeviceId({ audience: { kind: "localOwner" } })).toBeNull()
})

it("preserves the Host refusal for a device that may no longer control it", async () => {
  const refusal = new Error("preview_device_not_permitted")
  call.mockRejectedValueOnce(refusal)
  await expect(
    sandboxPreviewCreate({
      projectId: "p",
      workspaceId: "w",
      provider: "local",
      containerId: "c",
      port: { kind: "fixed", port: 3000 },
      audience: { kind: "pairedDevice", deviceId: "d" },
    })
  ).rejects.toBe(refusal)
})

it("follows opaque page tokens without silently truncating the grant inventory", async () => {
  call
    .mockResolvedValueOnce({ items: [{ id: "first" }], nextPageToken: "opaque" })
    .mockResolvedValueOnce({ items: [{ id: "last" }] })
  expect(await sandboxPreviewList("p", "w")).toEqual([{ id: "first" }, { id: "last" }])
  expect(call).toHaveBeenLastCalledWith("sandbox_preview_list", {
    projectId: "p",
    workspaceId: "w",
    pageToken: "opaque",
  })
})

it("refuses a repeating page token instead of rendering a partial inventory", async () => {
  call.mockResolvedValue({ items: [], nextPageToken: "same" })
  await expect(sandboxPreviewList("p")).rejects.toThrow("repeated page token")
})

it("preserves the Host's refusal for the inert numeric origin fallback", async () => {
  const refusal = new Error("preview_origin_isolation_unavailable")
  call.mockRejectedValueOnce(refusal)
  await expect(
    sandboxPreviewCreate({
      projectId: "p",
      workspaceId: "w",
      provider: "local",
      containerId: "c",
      port: { kind: "fixed", port: 3000 },
      originMode: "loopback",
    })
  ).rejects.toBe(refusal)
})
