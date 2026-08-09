/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"

const listAccountsMock = jest.fn()
const getActiveAccountMock = jest.fn()
const deleteAccountMock = jest.fn()
const saveAccountMock = jest.fn()

jest.mock("./transport", () => ({
  listAccounts: (...args: unknown[]) => listAccountsMock(...args),
  getActiveAccount: (...args: unknown[]) => getActiveAccountMock(...args),
  deleteAccount: (...args: unknown[]) => deleteAccountMock(...args),
  saveAccount: (...args: unknown[]) => saveAccountMock(...args),
}))

const settingsStoreState: { settings: Record<string, unknown> | null } = { settings: null }
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => settingsStoreState,
    setState: (patch: { settings?: Record<string, unknown> }) => {
      if (patch.settings) settingsStoreState.settings = patch.settings
    },
  },
}))

import {
  deleteProviderAccount,
  inspectProviderAccountReferences,
  persistProviderAccount,
  setProviderDefaultAccount,
} from "./account-lifecycle"

const TARGET = "account-target"
const REPLACEMENT = "account-replacement"

beforeEach(async () => {
  jest.clearAllMocks()
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await Promise.all([
    getDb().sessions.clear(),
    getDb().characters.clear(),
    getDb().settings.clear(),
  ])
  settingsStoreState.settings = null
  listAccountsMock.mockResolvedValue([
    { id: TARGET, label: "Old" },
    { id: REPLACEMENT, label: "New" },
  ])
  getActiveAccountMock.mockResolvedValue({ activeAccountId: TARGET, env: [] })
  deleteAccountMock.mockResolvedValue(undefined)
  saveAccountMock.mockResolvedValue(undefined)
})

async function seedReferences() {
  await getDb().sessions.bulkPut([
    {
      id: "session-1",
      title: "Pinned chat",
      accountId: TARGET,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      id: "session-2",
      title: "Unrelated chat",
      accountId: "other",
      createdAt: 1,
      updatedAt: 1,
    },
  ] as never[])
  await getDb().characters.put({
    id: "character-1",
    name: "Pinned character",
    accountIdOverride: TARGET,
    createdAt: 1,
    updatedAt: 1,
  } as never)
  await getDb().settings.put({
    id: "singleton",
    defaultProvider: "anthropic",
    defaultAccountIds: { anthropic: TARGET },
    updatedAt: 1,
  } as never)
}

describe("provider account lifecycle", () => {
  it("routes account persistence through the atomic host save command", async () => {
    const account = {
      id: TARGET,
      credential: { provider: "anthropic" },
      createdAtMs: 1,
      lastUsedAtMs: 1,
    } as never
    await persistProviderAccount("anthropic", account)
    expect(saveAccountMock).toHaveBeenCalledWith("anthropic", account)
  })
  it("reports session, character, default, and active references", async () => {
    await seedReferences()

    await expect(inspectProviderAccountReferences("anthropic", TARGET)).resolves.toMatchObject({
      sessions: [{ id: "session-1", title: "Pinned chat" }],
      characters: [{ id: "character-1", name: "Pinned character" }],
      isDefault: true,
      isActive: true,
    })
  })

  it("atomically rewrites references before deleting with the selected replacement", async () => {
    await seedReferences()

    await deleteProviderAccount({
      provider: "anthropic",
      accountId: TARGET,
      replacementAccountId: REPLACEMENT,
    })

    expect((await getDb().sessions.get("session-1"))?.accountId).toBe(REPLACEMENT)
    expect((await getDb().characters.get("character-1"))?.accountIdOverride).toBe(REPLACEMENT)
    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({
      anthropic: REPLACEMENT,
    })
    expect(deleteAccountMock).toHaveBeenCalledWith("anthropic", TARGET, REPLACEMENT)
  })

  it("restores references when keyring deletion fails", async () => {
    await seedReferences()
    deleteAccountMock.mockRejectedValueOnce(new Error("keyring delete failed"))

    await expect(
      deleteProviderAccount({
        provider: "anthropic",
        accountId: TARGET,
        replacementAccountId: REPLACEMENT,
      })
    ).rejects.toThrow(/keyring delete failed/)

    expect((await getDb().sessions.get("session-1"))?.accountId).toBe(TARGET)
    expect((await getDb().characters.get("character-1"))?.accountIdOverride).toBe(TARGET)
    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({
      anthropic: TARGET,
    })
  })

  it("clears references when deleting the provider's final account", async () => {
    await seedReferences()
    listAccountsMock.mockResolvedValue([{ id: TARGET, label: "Only" }])

    await deleteProviderAccount({
      provider: "anthropic",
      accountId: TARGET,
      replacementAccountId: null,
    })

    expect((await getDb().sessions.get("session-1"))?.accountId).toBeUndefined()
    expect((await getDb().characters.get("character-1"))?.accountIdOverride).toBeUndefined()
    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({})
    expect(deleteAccountMock).toHaveBeenCalledWith("anthropic", TARGET, null)
  })

  it("sets and clears a provider default without changing other providers", async () => {
    await getDb().settings.put({
      id: "singleton",
      defaultAccountIds: { codex: "codex-account" },
      updatedAt: 1,
    } as never)

    await setProviderDefaultAccount("anthropic", TARGET)
    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({
      anthropic: TARGET,
      codex: "codex-account",
    })

    await setProviderDefaultAccount("anthropic", null)
    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({
      codex: "codex-account",
    })
  })

  it("preserves a legacy default under its original provider when setting another provider", async () => {
    await getDb().settings.put({
      id: "singleton",
      defaultProvider: "anthropic",
      defaultAccountId: TARGET,
      updatedAt: 1,
    } as never)

    await setProviderDefaultAccount("codex", "codex-account")

    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({
      anthropic: TARGET,
      codex: "codex-account",
    })
  })

  it("preserves a legacy OpenCode Go default under the OpenCode provider", async () => {
    await getDb().settings.put({
      id: "singleton",
      defaultProvider: "opencode-go",
      defaultAccountId: TARGET,
      updatedAt: 1,
    } as never)

    await setProviderDefaultAccount("codex", "codex-account")

    expect((await getDb().settings.get("singleton"))?.defaultAccountIds).toEqual({
      codex: "codex-account",
      opencode: TARGET,
    })
  })
})
