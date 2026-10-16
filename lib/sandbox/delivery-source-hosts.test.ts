import { recordDeliverySourceHost, revokeDeliverySourceHosts } from "./delivery-source-hosts"
import { getActiveRemoteEndpoint, getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { localTransport, transport } from "@/lib/tauri/transport-instance"
import { recordSessionDeliverySourceHost } from "@/lib/db/sessions"
import { isTauri } from "@/lib/utils"
import { useAccountStore } from "@/stores/account/account-store"

jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteEndpoint: jest.fn(),
  getActiveRemoteTransport: jest.fn(),
}))
jest.mock("@/lib/tauri/transport-instance", () => ({
  localTransport: { call: jest.fn() },
  transport: { call: jest.fn() },
  onTransportChange: () => () => undefined,
}))
jest.mock("@/lib/utils", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/platform/detect", () => ({ isHeadlessHost: () => true }))
jest.mock("@/stores/account/account-store", () => ({
  useAccountStore: { getState: jest.fn(), subscribe: jest.fn(() => () => undefined) },
}))
jest.mock("@/lib/db/schema", () => {
  const db = {}
  return { getDb: () => db }
})
jest.mock("@/lib/db/sessions", () => ({ recordSessionDeliverySourceHost: jest.fn() }))
const remote = { call: jest.fn() }
const endpoint = {
  baseUrl: "https://host.test",
  serverFingerprint: "fingerprint",
  deviceId: "device",
  deviceKeyThumbprint: "key",
}
const endpointIdentity = JSON.stringify([
  endpoint.baseUrl,
  endpoint.serverFingerprint,
  endpoint.deviceId,
  endpoint.deviceKeyThumbprint,
])
beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getActiveRemoteTransport).mockReturnValue(null)
  jest.mocked(getActiveRemoteEndpoint).mockReturnValue(null)
  jest.mocked(localTransport.call).mockResolvedValue({ hostId: "host-a" })
  jest.mocked(isTauri).mockReturnValue(true)
  jest
    .mocked(useAccountStore.getState)
    .mockReturnValue({ unlockedAccountId: "account", locked: false } as never)
  jest.mocked(recordSessionDeliverySourceHost).mockResolvedValue(undefined)
  jest.mocked(transport.call).mockResolvedValue({ hostId: "host-a" })
  remote.call.mockResolvedValue({ hostId: "host-a" })
})
test("records a Host identity before returning the admission fence", async () => {
  const fence = await recordDeliverySourceHost("chat")
  expect(recordSessionDeliverySourceHost).toHaveBeenCalledWith(
    "chat",
    { kind: "local", hostId: "host-a" },
    expect.objectContaining({ assertActive: expect.any(Function) })
  )
  expect(localTransport.call).toHaveBeenCalledWith("managed_desktop_local_call", {
    name: "managed_desktop_handoff_source_host",
    args: {},
  })
  expect(fence).not.toThrow()
})
test("refuses missing source conversation and a changed Host during capture", async () => {
  jest
    .mocked(recordSessionDeliverySourceHost)
    .mockRejectedValueOnce(new Error("delivery_source_conversation_missing"))
  await expect(recordDeliverySourceHost("missing")).rejects.toThrow("conversation_missing")
  jest.mocked(localTransport.call).mockImplementation(async () => {
    jest.mocked(getActiveRemoteTransport).mockReturnValue(remote as never)
    return { hostId: "host-a" } as never
  })
  await expect(recordDeliverySourceHost("chat")).rejects.toThrow("host_changed")
})
test("unrelated legacy rows do not contact any Host", async () => {
  await revokeDeliverySourceHosts([{ id: "legacy" }, undefined])
  expect(localTransport.call).not.toHaveBeenCalled()
})
test("never redirects a remote source to the selected local or another Host", async () => {
  const row = {
    id: "chat",
    deliverySourceHosts: [{ kind: "remote" as const, hostId: "host-a", endpointIdentity }],
  }
  await expect(revokeDeliverySourceHosts([row])).rejects.toThrow("original_host_required")
  expect(localTransport.call).not.toHaveBeenCalled()
  jest.mocked(getActiveRemoteTransport).mockReturnValue(remote as never)
  jest
    .mocked(getActiveRemoteEndpoint)
    .mockReturnValue({ ...endpoint, deviceId: "another" } as never)
  await expect(revokeDeliverySourceHosts([row])).rejects.toThrow("original_host_required")
  expect(remote.call).not.toHaveBeenCalled()
})
test("checks backend Host identity before tombstoning and propagates offline failure", async () => {
  const row = { id: "chat", deliverySourceHosts: [{ kind: "local" as const, hostId: "other" }] }
  await expect(revokeDeliverySourceHosts([row])).rejects.toThrow("original_host_required")
  expect(localTransport.call).toHaveBeenCalledTimes(1)
  jest.mocked(localTransport.call).mockRejectedValue(new Error("offline"))
  await expect(
    revokeDeliverySourceHosts([
      { ...row, deliverySourceHosts: [{ kind: "local", hostId: "host-a" }] },
    ])
  ).rejects.toThrow("offline")
})
test("revokes conversation on exactly the captured remote pairing", async () => {
  jest.mocked(getActiveRemoteTransport).mockReturnValue(remote as never)
  jest.mocked(getActiveRemoteEndpoint).mockReturnValue(endpoint as never)
  await revokeDeliverySourceHosts([
    { id: "chat", deliverySourceHosts: [{ kind: "remote", hostId: "host-a", endpointIdentity }] },
  ])
  expect(remote.call).toHaveBeenLastCalledWith("managed_desktop_handoff_revoke_source", {
    conversationIds: ["chat"],
  })
  expect(localTransport.call).not.toHaveBeenCalled()
})

test("uses the live headless transport rather than the fixed local WebStub", async () => {
  jest.mocked(isTauri).mockReturnValue(false)
  await recordDeliverySourceHost("chat")
  expect(transport.call).toHaveBeenCalledWith("managed_desktop_handoff_source_host", {})
  expect(localTransport.call).not.toHaveBeenCalled()
})
test("an account switch and switch-back while waiting cannot write source ownership", async () => {
  let listener: (() => void) | undefined
  jest.mocked(useAccountStore.subscribe).mockImplementation((callback) => {
    listener = callback as () => void
    return () => undefined
  })
  jest.mocked(localTransport.call).mockImplementation(async () => {
    jest
      .mocked(useAccountStore.getState)
      .mockReturnValue({ unlockedAccountId: "another", locked: false } as never)
    listener?.()
    jest
      .mocked(useAccountStore.getState)
      .mockReturnValue({ unlockedAccountId: "account", locked: false } as never)
    listener?.()
    return { hostId: "host-a" } as never
  })
  await expect(recordDeliverySourceHost("chat")).rejects.toThrow("owner_changed")
  expect(recordSessionDeliverySourceHost).not.toHaveBeenCalled()
})
test("persists successful revocation before asking for the next original Host", async () => {
  const saved = jest.fn(async () => undefined)
  const remoteHost = { kind: "remote" as const, hostId: "host-b", endpointIdentity }
  await expect(
    revokeDeliverySourceHosts(
      [{ id: "chat", deliverySourceHosts: [{ kind: "local", hostId: "host-a" }, remoteHost] }],
      () => undefined,
      saved
    )
  ).rejects.toThrow("original_host_required")
  expect(saved).toHaveBeenCalledWith("chat", [remoteHost])
})
