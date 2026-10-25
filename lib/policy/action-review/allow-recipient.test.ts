import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

const mockSettings: { agentPermissions: Record<string, unknown> } = { agentPermissions: {} }
const mockSave = jest.fn(async (patch: { agentPermissions: Record<string, unknown> }) => {
  mockSettings.agentPermissions = patch.agentPermissions
})
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: () => ({ settings: mockSettings, save: mockSave }) },
}))

import {
  AllowRecipientTargetMissingError,
  allowShadowRecipient,
  type AllowRecipientDeps,
} from "./allow-recipient"
import {
  conversationTarget,
  mailTarget,
  repositoryTarget,
  siteTarget,
  type OutboundTarget,
} from "./outbound-targets"

const CHAT = conversationTarget("lark:bot-a:oc_1")!
const MAIL = mailTarget("ops@example.com")!

function grant(target: OutboundTarget): OutboundRecipientGrant {
  return {
    recipient: target as OutboundRecipientGrant["recipient"],
    addedAt: 1,
    addedBy: "local-user",
  }
}

function deps(lists: { bot?: OutboundRecipientGrant[]; adapter?: OutboundRecipientGrant[] }) {
  const writeBotList = jest.fn(async () => undefined)
  const writeAdapterList = jest.fn(async () => undefined)
  const all: AllowRecipientDeps = {
    readBotList: async () => lists.bot,
    writeBotList,
    readAdapterList: async () => lists.adapter,
    writeAdapterList,
    now: () => 42,
  }
  return { all, writeBotList, writeAdapterList }
}

describe("allowShadowRecipient", () => {
  it("appends to the list as it stands now, as a person's edit", async () => {
    const existing = grant(MAIL)
    const { all, writeBotList } = deps({ bot: [existing] })
    await expect(
      allowShadowRecipient({ kind: "bot", installationId: "boti_1" }, CHAT, all)
    ).resolves.toBe(true)
    expect(writeBotList).toHaveBeenCalledWith("boti_1", [
      existing,
      { recipient: CHAT, addedAt: 42, addedBy: "local-user" },
    ])
  })

  it("writes a connection's list for an adapter row", async () => {
    const { all, writeAdapterList, writeBotList } = deps({ adapter: [] })
    await allowShadowRecipient({ kind: "adapter", adapterId: "bot-a" }, CHAT, all)
    expect(writeAdapterList).toHaveBeenCalledWith("bot-a", [
      { recipient: CHAT, addedAt: 42, addedBy: "local-user" },
    ])
    expect(writeBotList).not.toHaveBeenCalled()
  })

  it("adds nothing for a recipient the list already holds", async () => {
    const { all, writeAdapterList } = deps({ adapter: [grant(CHAT)] })
    await expect(
      allowShadowRecipient({ kind: "adapter", adapterId: "bot-a" }, CHAT, all)
    ).resolves.toBe(false)
    expect(writeAdapterList).not.toHaveBeenCalled()
  })

  it("refuses when the list's owner is gone, or the recipient cannot be listed", async () => {
    const { all } = deps({})
    await expect(
      allowShadowRecipient({ kind: "bot", installationId: "boti_x" }, CHAT, all)
    ).rejects.toBeInstanceOf(AllowRecipientTargetMissingError)
    await expect(
      allowShadowRecipient({ kind: "adapter", adapterId: "gone" }, CHAT, all)
    ).rejects.toThrow("Connection gone no longer exists")
    await expect(
      allowShadowRecipient(
        { kind: "adapter", adapterId: "bot-a" },
        { kind: "public", channel: "tool:x", recipient: "public:x" },
        all
      )
    ).rejects.toThrow("cannot be listed")
  })
})

describe("allowShadowRecipient into a GitHub account's list (ADR-0239 phase 2)", () => {
  const WEB = repositoryTarget("acme/web")!
  const into = {
    kind: "integration-account",
    pluginId: "github-delivery",
    accountId: "acct_1",
  } as const

  it("appends the repository to the account's list as it stands now", async () => {
    const existing = grant(repositoryTarget("acme/api")!)
    const writeAccountList = jest.fn(async () => undefined)
    const readAccountList = jest.fn(async () => [existing])
    await expect(
      allowShadowRecipient(into, WEB, { readAccountList, writeAccountList, now: () => 42 })
    ).resolves.toBe(true)
    expect(readAccountList).toHaveBeenCalledWith("github-delivery", "acct_1")
    expect(writeAccountList).toHaveBeenCalledWith("github-delivery", "acct_1", [
      existing,
      { recipient: WEB, addedAt: 42, addedBy: "local-user" },
    ])
  })

  it("adds nothing twice, and refuses when the account is gone", async () => {
    const writeAccountList = jest.fn(async () => undefined)
    await expect(
      allowShadowRecipient(into, WEB, {
        readAccountList: async () => [grant(WEB)],
        writeAccountList,
      })
    ).resolves.toBe(false)
    expect(writeAccountList).not.toHaveBeenCalled()
    await expect(
      allowShadowRecipient(into, WEB, { readAccountList: async () => undefined })
    ).rejects.toThrow("Integration account acct_1 no longer exists")
  })
})

describe("allowShadowRecipient into the global site list (ADR-0239 phase 2b)", () => {
  const FORMS = siteTarget("https://forms.example.com/apply")!
  const SHOP = siteTarget("https://shop.example.com")!

  it("appends the site to the list as it stands now", async () => {
    const writeSiteList = jest.fn(async () => undefined)
    await expect(
      allowShadowRecipient({ kind: "sites" }, FORMS, {
        readSiteList: async () => [grant(SHOP)],
        writeSiteList,
        now: () => 42,
      })
    ).resolves.toBe(true)
    expect(writeSiteList).toHaveBeenCalledWith([
      grant(SHOP),
      { recipient: FORMS, addedAt: 42, addedBy: "local-user" },
    ])
  })

  it("saves through the settings store, keeping the other permissions, and adds nothing twice", async () => {
    mockSettings.agentPermissions = {
      outboundAuthorizationByCategory: { browser: "enforce" },
      outboundSites: [grant(SHOP)],
    }
    await expect(allowShadowRecipient({ kind: "sites" }, FORMS, { now: () => 42 })).resolves.toBe(
      true
    )
    expect(mockSettings.agentPermissions).toEqual({
      outboundAuthorizationByCategory: { browser: "enforce" },
      outboundSites: [grant(SHOP), { recipient: FORMS, addedAt: 42, addedBy: "local-user" }],
    })
    mockSave.mockClear()
    await expect(allowShadowRecipient({ kind: "sites" }, SHOP)).resolves.toBe(false)
    expect(mockSave).not.toHaveBeenCalled()
  })
})
