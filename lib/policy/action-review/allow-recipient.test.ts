import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import {
  AllowRecipientTargetMissingError,
  allowShadowRecipient,
  type AllowRecipientDeps,
} from "./allow-recipient"
import { conversationTarget, mailTarget, type OutboundTarget } from "./outbound-targets"

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
