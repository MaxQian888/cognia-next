/**
 * Tests for lib/skills/built-in/lark/auth-bridge.ts.
 *
 * Mocks the three external deps (Dexie adapter row fetch, keyring read,
 * tenant token fetch) so the bridge can be exercised in isolation
 * without a real Lark adapter configured.
 */

import { resolveLarkAuth } from "./auth-bridge"
import { getAdapterInstance, listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { connectorsKeyringGet } from "@/lib/connectors/tauri/commands"
import { getTenantAccessToken } from "@/lib/connectors/adapters/lark/auth"

jest.mock("@/lib/db/adapter-instances", () => ({
  getAdapterInstance: jest.fn(),
  listAdapterInstancesByType: jest.fn(),
}))
jest.mock("@/lib/connectors/tauri/commands", () => ({
  connectorsKeyringGet: jest.fn(),
}))
jest.mock("@/lib/connectors/adapters/lark/auth", () => ({
  getTenantAccessToken: jest.fn(),
}))

const mockGetAdapter = getAdapterInstance as jest.Mock
const mockListByType = listAdapterInstancesByType as jest.Mock
const mockKeyring = connectorsKeyringGet as jest.Mock
const mockTenantToken = getTenantAccessToken as jest.Mock

function mkAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "lark-1",
    type: "lark",
    displayName: "My Lark",
    enabled: true,
    transportMode: "webhook",
    settings: { appId: "cli_test_app" },
    credentialsRef: { keyringService: "x", accounts: [] },
    trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
    defaultMode: "auto",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

beforeEach(() => {
  mockGetAdapter.mockReset()
  mockListByType.mockReset()
  mockKeyring.mockReset()
  mockTenantToken.mockReset()
})

describe("resolveLarkAuth", () => {
  it("no_adapter when no Lark row exists", async () => {
    mockListByType.mockResolvedValue([])
    const r = await resolveLarkAuth()
    expect(r).toEqual({
      ok: false,
      reason: "no_adapter",
      message: expect.stringContaining("No Lark adapter"),
    })
  })

  it("adapter_disabled when row exists but enabled=false", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ enabled: false })])
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("adapter_disabled")
      if ("adapterId" in r) expect(r.adapterId).toBe("lark-1")
    }
  })

  it("missing_app_id when settings.appId is blank", async () => {
    mockListByType.mockResolvedValue([mkAdapter({ settings: {} })])
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("missing_app_id")
  })

  it("missing_app_secret when keyring returns undefined", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockResolvedValue(undefined)
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("missing_app_secret")
  })

  it("returns user identity env when user_token present", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity).toBe("user")
      expect(r.env).toEqual({
        LARK_APP_ID: "cli_test_app",
        LARK_APP_SECRET: "secret-x",
        LARK_USER_ACCESS_TOKEN: "uat-aaa",
      })
    }
  })

  it("falls back to bot identity when user_token absent", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appSecret") return "secret-x"
      return undefined // no user_token
    })
    mockTenantToken.mockResolvedValue("tat-bbb")
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity).toBe("bot")
      expect(r.env).toEqual({
        LARK_APP_ID: "cli_test_app",
        LARK_APP_SECRET: "secret-x",
        LARK_TENANT_ACCESS_TOKEN: "tat-bbb",
      })
    }
  })

  it("identity='bot' explicit override skips user_token lookup", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-aaa"
      return undefined
    })
    mockTenantToken.mockResolvedValue("tat-bbb")
    const r = await resolveLarkAuth({ identity: "bot" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.identity).toBe("bot")
      expect(r.env.LARK_USER_ACCESS_TOKEN).toBeUndefined()
      expect(r.env.LARK_TENANT_ACCESS_TOKEN).toBe("tat-bbb")
    }
  })

  it("tenant_token_failed surfaces upstream error", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appSecret") return "secret-x"
      return undefined
    })
    mockTenantToken.mockRejectedValue(new Error("invalid app_secret"))
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe("tenant_token_failed")
      expect(r.message).toContain("invalid app_secret")
    }
  })

  it("explicit adapterId routes to getAdapterInstance instead of listByType", async () => {
    mockGetAdapter.mockResolvedValue(mkAdapter({ id: "lark-2" }))
    mockKeyring.mockImplementation(async (_id: string, key: string) => {
      if (key === "appSecret") return "secret-x"
      if (key === "user_token") return "uat-z"
      return undefined
    })
    const r = await resolveLarkAuth({ adapterId: "lark-2" })
    expect(mockGetAdapter).toHaveBeenCalledWith("lark-2")
    expect(mockListByType).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.adapterId).toBe("lark-2")
  })

  it("keyring throw is treated as missing credential (graceful)", async () => {
    mockListByType.mockResolvedValue([mkAdapter()])
    mockKeyring.mockRejectedValue(new Error("keyring locked"))
    const r = await resolveLarkAuth()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe("missing_app_secret")
  })
})
