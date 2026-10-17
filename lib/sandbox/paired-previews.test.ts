const mockAuthHeaders = jest.fn()
jest.mock("@/lib/tauri/companion-auth", () => ({
  companionAuthorizationHeaders: (...args: unknown[]) => mockAuthHeaders(...args),
}))
jest.mock("@/lib/tauri/pinned-fetch", () => ({ pinnedFetch: jest.fn() }))
const mockEnsure = jest.fn()
const mockStop = jest.fn()
jest.mock("@/lib/codeserver/remote-relay", () => ({
  ensureRemotePortRelay: (...args: unknown[]) => mockEnsure(...args),
  stopRemotePortRelay: (...args: unknown[]) => mockStop(...args),
  remoteEndpointCompanionConfig: (endpoint: { baseUrl: string; deviceId: string }) => ({
    baseUrl: endpoint.baseUrl,
    deviceId: endpoint.deviceId,
  }),
}))

import type { RemoteHostEndpoint } from "@/lib/tauri/transport-routing"
import {
  closeSharedPreview,
  listSharedPreviews,
  openSharedPreview,
  SharedPreviewsError,
  sharedPreviewRelayPath,
} from "./paired-previews"

const ID = "0123456789abcdef0123456789abcdef"
const ENDPOINT: RemoteHostEndpoint = {
  baseUrl: "https://host.example:27890/",
  deviceId: "desk",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
  deviceKeyThumbprint: "thumb",
  serverVersion: "1.0.0",
  serverFingerprint: "ab".repeat(32),
}
const row = {
  id: ID,
  projectId: "p",
  workspaceId: "w",
  resolvedPort: 3000,
  expiresAt: 10,
  relayPath: `/api/sandbox/previews/${ID}/`,
}

beforeEach(() => {
  mockAuthHeaders.mockReset().mockResolvedValue({ Authorization: "Bearer t", DPoP: "proof" })
  mockEnsure.mockReset().mockResolvedValue({ port: 5, url: "http://127.0.0.1:5/" })
  mockStop.mockReset().mockResolvedValue(undefined)
})

it("lists with the device's own DPoP credentials over the pinned certificate", async () => {
  const fetcher = jest
    .fn()
    .mockResolvedValue(new Response(JSON.stringify({ items: [row] }), { status: 200 }))
  await expect(listSharedPreviews(ENDPOINT, fetcher)).resolves.toEqual([row])
  expect(mockAuthHeaders).toHaveBeenCalledWith(
    { baseUrl: ENDPOINT.baseUrl, deviceId: "desk" },
    "GET",
    "/api/sandbox/previews",
    fetcher
  )
  expect(fetcher).toHaveBeenCalledWith("https://host.example:27890/api/sandbox/previews", {
    method: "GET",
    headers: { Authorization: "Bearer t", DPoP: "proof", Accept: "application/json" },
    serverFingerprint: ENDPOINT.serverFingerprint,
  })
})

it("drops rows that do not name their own device route", async () => {
  const fetcher = jest.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        items: [
          row,
          { ...row, id: "f".repeat(32) },
          { ...row, id: "../x", relayPath: "/api/sandbox/previews/../x/" },
          { ...row, relayPath: "/api/environment/ports/p/c/3000/" },
          null,
        ],
      }),
      { status: 200 }
    )
  )
  await expect(listSharedPreviews(ENDPOINT, fetcher)).resolves.toEqual([row])
})

it("surfaces a Host refusal with its status and refuses a malformed body", async () => {
  const refused = jest.fn().mockResolvedValue(new Response("", { status: 403 }))
  const error = await listSharedPreviews(ENDPOINT, refused).catch((reason) => reason)
  expect(error).toBeInstanceOf(SharedPreviewsError)
  expect((error as SharedPreviewsError).status).toBe(403)
  const malformed = jest.fn().mockResolvedValue(new Response("{}", { status: 200 }))
  await expect(listSharedPreviews(ENDPOINT, malformed)).rejects.toThrow("preview_list_malformed")
})

it("never lists without a pinned certificate", async () => {
  const fetcher = jest.fn()
  await expect(
    listSharedPreviews({ ...ENDPOINT, serverFingerprint: undefined }, fetcher)
  ).rejects.toThrow("fingerprint")
  expect(fetcher).not.toHaveBeenCalled()
})

it("opens and closes one relay per grant on the device route only", async () => {
  await expect(openSharedPreview(ENDPOINT, { id: ID })).resolves.toEqual({
    port: 5,
    url: "http://127.0.0.1:5/",
  })
  expect(mockEnsure).toHaveBeenCalledWith(
    ENDPOINT,
    `/api/sandbox/previews/${ID}/`,
    `sandbox-preview:${ID}`
  )
  await closeSharedPreview(ID)
  expect(mockStop).toHaveBeenCalledWith(`sandbox-preview:${ID}`)
  expect(() => sharedPreviewRelayPath("../ports")).toThrow("preview_grant_id_invalid")
  expect(() => openSharedPreview(ENDPOINT, { id: ID.toUpperCase() })).toThrow()
})
