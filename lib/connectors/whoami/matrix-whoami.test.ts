/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { invoke } from "@tauri-apps/api/core"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { defaultGroupChatPolicy } from "@/types/connectors/policy"
import { MatrixWhoamiError, probeMatrixIdentity } from "./matrix-whoami"

const mockInvoke = invoke as jest.Mock

function httpResp(status: number, body: unknown) {
  return { status, headers: {}, body: typeof body === "string" ? body : JSON.stringify(body) }
}

async function seedRow(overrides: Partial<AdapterInstanceRow> = {}) {
  await getDb().adapterInstances.put({
    id: "mx-1",
    type: "matrix",
    displayName: "Matrix",
    enabled: true,
    transportMode: "longpoll",
    settings: { homeserver: "matrix.org" },
    credentialsRef: { keyringService: "com.cognia.platforms", accounts: ["accessToken"] },
    trigger: defaultGroupChatPolicy(),
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockInvoke.mockReset()
})

describe("probeMatrixIdentity", () => {
  it("persists Matrix whoami identity", async () => {
    await seedRow()
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "connectors_keyring_get") return Promise.resolve("tok")
      if (cmd === "connectors_http_request") {
        return Promise.resolve(httpResp(200, { user_id: "@bot:matrix.org", device_id: "DEV" }))
      }
      return Promise.reject(new Error(`unexpected command ${cmd}`))
    })

    await expect(probeMatrixIdentity("mx-1", { now: () => 123 })).resolves.toEqual({
      botName: "bot",
      appId: "https://matrix.org",
      openId: "@bot:matrix.org",
      deviceId: "DEV",
    })

    expect(mockInvoke).toHaveBeenCalledWith("connectors_keyring_get", {
      adapterId: "mx-1",
      credential: "accessToken",
    })
    expect(mockInvoke).toHaveBeenCalledWith("connectors_http_request", {
      req: {
        url: "https://matrix.org/_matrix/client/v3/account/whoami",
        method: "GET",
        headers: { Authorization: "Bearer tok" },
      },
    })
    const row = await getDb().adapterInstances.get("mx-1")
    expect(row?.lastWhoamiAt).toBe(123)
    expect(row?.lastWhoamiResult).toEqual({
      botName: "bot",
      appId: "https://matrix.org",
      openId: "@bot:matrix.org",
      deviceId: "DEV",
    })
    expect(row?.settings).toEqual({ homeserver: "matrix.org", deviceId: "DEV" })
  })

  it("throws MatrixWhoamiError when the adapter is not matrix", async () => {
    await seedRow({ type: "telegram" })
    await expect(probeMatrixIdentity("mx-1")).rejects.toBeInstanceOf(MatrixWhoamiError)
  })

  it("throws MatrixWhoamiError when the token is missing", async () => {
    await seedRow()
    mockInvoke.mockResolvedValue(null)
    await expect(probeMatrixIdentity("mx-1")).rejects.toThrow("Access token")
  })
})
