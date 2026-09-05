import {
  DeviceLifecycleNoHostError,
  applyDeviceLifecycleOverHttp,
  lifecycleRoute,
} from "./lifecycle-http"

jest.mock("@/lib/tauri/companion-auth", () => ({
  companionAuthorizationHeaders: async (_c: unknown, method: string, path: string) => ({
    Authorization: "Bearer t",
    DPoP: `${method} ${path}`,
  }),
}))
jest.mock("@/lib/tauri/pinned-fetch", () => ({ pinnedFetch: jest.fn() }))
jest.mock("@/lib/tauri/transport-companion", () => ({ loadCompanionConfig: () => null }))

const config = () => ({
  baseUrl: "https://host:27890",
  deviceId: "me",
  serverVersion: "1",
  serverFingerprint: "ab",
})

describe("lifecycleRoute", () => {
  it("maps the three actions onto the owner routes", () => {
    expect(lifecycleRoute("suspend", "d 1")).toEqual({
      method: "POST",
      path: "/api/devices/d%201/suspend",
    })
    expect(lifecycleRoute("resume", "d1")).toEqual({
      method: "POST",
      path: "/api/devices/d1/resume",
    })
    expect(lifecycleRoute("revoke", "d1")).toEqual({ method: "DELETE", path: "/api/devices/d1" })
  })
})

describe("applyDeviceLifecycleOverHttp", () => {
  it("refuses without a paired Host", async () => {
    await expect(applyDeviceLifecycleOverHttp("suspend", "d1")).rejects.toBeInstanceOf(
      DeviceLifecycleNoHostError
    )
  })

  it("sends the owner-authenticated request and returns the outcome", async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            deviceId: "d1",
            previousState: "active",
            state: "suspended",
            changed: true,
          }),
          {
            status: 200,
          }
        )
    )
    await expect(
      applyDeviceLifecycleOverHttp("suspend", "d1", { config, fetcher })
    ).resolves.toMatchObject({ deviceId: "d1", state: "suspended", changed: true })
    expect(fetcher).toHaveBeenCalledWith(
      "https://host:27890/api/devices/d1/suspend",
      expect.objectContaining({
        method: "POST",
        serverFingerprint: "ab",
        headers: expect.objectContaining({
          Authorization: "Bearer t",
          DPoP: "POST /api/devices/d1/suspend",
        }),
      })
    )
  })

  it("surfaces the Host's refusal with its status and message", async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "forbidden", message: "not the owner" }), {
          status: 403,
        })
    )
    await expect(applyDeviceLifecycleOverHttp("revoke", "d1", { config, fetcher })).rejects.toThrow(
      /refused revoke \(403\): not the owner/
    )
  })
})
