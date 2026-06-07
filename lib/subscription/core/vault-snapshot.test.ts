jest.mock("@/lib/subscription/core/transport", () => ({
  listAccounts: jest.fn(),
  getAccount: jest.fn(),
  getActiveAccount: jest.fn(),
  getProviderPreset: jest.fn(),
  listPresets: jest.fn(),
  saveAccount: jest.fn(),
  saveProviderPreset: jest.fn(),
  setActiveAccount: jest.fn(),
  setDefaultPreset: jest.fn(),
  setProviderPreset: jest.fn(),
}))

import { applyVaults, snapshotVaults } from "./vault-snapshot"
import type { ProviderVault } from "@/types/subscription"

const transportMocks = jest.requireMock("@/lib/subscription/core/transport") as Record<
  string,
  jest.Mock
>

function account(id: string) {
  return {
    id,
    credential: { provider: "opencode-zen" as const, accessToken: "sk", storedAtMs: 0 },
    createdAtMs: 0,
    lastUsedAtMs: 0,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  transportMocks.listAccounts.mockResolvedValue([])
  transportMocks.getActiveAccount.mockResolvedValue({ env: [] })
  transportMocks.listPresets.mockResolvedValue([])
  transportMocks.getProviderPreset.mockResolvedValue(null)
  transportMocks.saveAccount.mockResolvedValue(undefined)
  transportMocks.saveProviderPreset.mockResolvedValue(undefined)
  transportMocks.setActiveAccount.mockResolvedValue(undefined)
  transportMocks.setDefaultPreset.mockResolvedValue(undefined)
  transportMocks.setProviderPreset.mockResolvedValue(undefined)
})

describe("snapshotVaults", () => {
  it("omits providers with nothing to record", async () => {
    expect(await snapshotVaults()).toEqual({})
  })

  it("captures full accounts + presets + active pointer", async () => {
    transportMocks.listAccounts.mockImplementation(async (p: string) =>
      p === "opencode" ? [{ id: "a1" }] : []
    )
    transportMocks.getAccount.mockResolvedValue(account("a1"))
    transportMocks.getActiveAccount.mockImplementation(async (p: string) =>
      p === "opencode" ? { activeAccountId: "a1", env: [] } : { env: [] }
    )
    transportMocks.listPresets.mockImplementation(async (p: string) =>
      p === "opencode" ? [{ id: "p1", label: "Relay", baseUrl: "https://r.example" }] : []
    )
    transportMocks.getProviderPreset.mockImplementation(async (p: string) =>
      p === "opencode" ? { id: "p1", label: "Relay", baseUrl: "https://r.example" } : null
    )

    const got = await snapshotVaults()
    expect(Object.keys(got)).toEqual(["opencode"])
    expect(got.opencode).toMatchObject({
      schemaVersion: 3,
      activeAccountId: "a1",
      defaultPresetId: "p1",
    })
    expect(got.opencode?.accounts.map((a) => a.id)).toEqual(["a1"])
  })

  it("records an empty vault when only presets or an active pointer exist", async () => {
    transportMocks.listPresets.mockImplementation(async (p: string) =>
      p === "codex" ? [{ id: "p2", label: "Azure", baseUrl: "https://az.example" }] : []
    )
    const got = await snapshotVaults()
    expect(got.codex).toMatchObject({ accounts: [], presets: [{ id: "p2" }] })
  })
})

describe("applyVaults", () => {
  it("writes accounts, presets, default pointer and active pointer", async () => {
    const vault: ProviderVault = {
      schemaVersion: 3,
      accounts: [account("a1"), account("a2")],
      activeAccountId: "a2",
      presets: [{ id: "p1", label: "Relay", baseUrl: "https://r.example" }],
      defaultPresetId: "p1",
    }
    const { accountCount } = await applyVaults({ opencode: vault })
    expect(accountCount).toBe(2)
    expect(transportMocks.saveAccount).toHaveBeenCalledTimes(2)
    expect(transportMocks.saveProviderPreset).toHaveBeenCalledWith("opencode", vault.presets[0])
    expect(transportMocks.setDefaultPreset).toHaveBeenCalledWith("opencode", "p1")
    expect(transportMocks.setActiveAccount).toHaveBeenCalledWith("opencode", "a2")
  })

  it("folds a legacy v2 single preset through the shim", async () => {
    const vault = {
      schemaVersion: 3,
      accounts: [],
      preset: { id: "legacy", label: "Legacy", baseUrl: "https://l.example" },
    } as unknown as ProviderVault
    await applyVaults({ anthropic: vault })
    expect(transportMocks.setProviderPreset).toHaveBeenCalledWith(
      "anthropic",
      expect.objectContaining({ id: "legacy" })
    )
  })
})
