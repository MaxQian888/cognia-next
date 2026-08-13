import type { CompanionConfig } from "@/lib/tauri/companion-storage"
import { CompanionDeviceRevocationError, revokeCompanionDevice } from "./device-revocation"

const config: CompanionConfig = {
  targetId: "host-a",
  accountId: "local_acct_a",
  baseUrl: "https://host-a.local:7890",
  deviceId: "device-a",
  devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "secret" },
  deviceKeyThumbprint: "thumb-a",
  serverVersion: "1.0.0",
  serverFingerprint: "pin-a",
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  } as unknown as Response
}

it("revokes with the removed Host's explicit credential and TLS pin", async () => {
  const authorize = jest.fn().mockResolvedValue({ Authorization: "Bearer explicit" })
  const fetcher = jest.fn().mockResolvedValue(response(200, { revokedDeviceId: "device-a" }))

  await expect(revokeCompanionDevice(config, { authorize, fetcher })).resolves.toEqual({
    kind: "revoked",
  })
  expect(authorize).toHaveBeenCalledWith(config, "DELETE", "/api/devices/device-a", fetcher)
  expect(fetcher).toHaveBeenCalledWith("https://host-a.local:7890/api/devices/device-a", {
    method: "DELETE",
    headers: { Authorization: "Bearer explicit" },
    serverFingerprint: "pin-a",
  })
})

it("treats an explicit device_revoked response as remote completion", async () => {
  const fetcher = jest.fn().mockResolvedValue(
    response(401, {
      error: { code: "device_revoked", message: "this device has been revoked" },
    })
  )

  await expect(
    revokeCompanionDevice(config, {
      authorize: jest.fn().mockResolvedValue({ DPoP: "proof" }),
      fetcher,
    })
  ).resolves.toEqual({ kind: "already-revoked" })
})

it.each([
  [409, "last_owner"],
  [401, "authentication_failed"],
  [503, "security_store_unavailable"],
])("retains failure details for HTTP %i %s", async (status, code) => {
  const fetcher = jest
    .fn()
    .mockResolvedValue(
      response(status, { error: { code, message: `${code} message`, retryable: status >= 500 } })
    )

  const failure = await revokeCompanionDevice(config, {
    authorize: jest.fn().mockResolvedValue({}),
    fetcher,
  }).catch((error) => error)

  expect(failure).toBeInstanceOf(CompanionDeviceRevocationError)
  expect(failure).toMatchObject({ code, status, retryable: status >= 500 })
})

it("does not turn an offline transport failure into local completion", async () => {
  const failure = await revokeCompanionDevice(config, {
    authorize: jest.fn().mockResolvedValue({}),
    fetcher: jest.fn().mockRejectedValue(new Error("offline")),
  }).catch((error) => error)

  expect(failure).toMatchObject({ code: "network", status: 0, retryable: true })
})
