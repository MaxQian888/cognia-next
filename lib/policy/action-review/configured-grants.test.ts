import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import {
  __resetRunningBotGrantsForTesting,
  beginBotOutboundRun,
  botRecipientGrants,
  configuredPolicyGrants,
  listsRecipient,
  recipientGrant,
  recipientGrantList,
  runningBotGrantsOf,
} from "./configured-grants"
import {
  conversationTarget,
  mailTarget,
  outboundFingerprint,
  personTarget,
} from "./outbound-targets"

const CHAT = conversationTarget("lark:bot-a:oc_1")!
const MEMBER = personTarget("bot-a", "ou_1")!
const MAIL = mailTarget("ops@example.com")!

function grant(target: {
  kind: string
  channel: string
  recipient: string
}): OutboundRecipientGrant {
  return {
    recipient: target as OutboundRecipientGrant["recipient"],
    addedAt: 1,
    addedBy: "local-user",
  }
}

beforeEach(() => __resetRunningBotGrantsForTesting())

describe("recipientGrantList", () => {
  it("grants the fingerprints the engine matches for each recipient", () => {
    expect(recipientGrantList("adapter:bot-a", [grant(CHAT), grant(MEMBER)])).toEqual({
      policyRef: "adapter:bot-a",
      fingerprints: [outboundFingerprint(CHAT), outboundFingerprint(MEMBER)],
    })
    expect(recipientGrantList("adapter:bot-a", [])).toBeUndefined()
    expect(recipientGrantList("adapter:bot-a", undefined)).toBeUndefined()
  })

  it("names a Bot's list by its installation", () => {
    expect(botRecipientGrants({ id: "boti_1", outboundRecipients: [grant(MAIL)] })).toEqual([
      { policyRef: "bot:boti_1", fingerprints: [outboundFingerprint(MAIL)] },
    ])
    expect(botRecipientGrants({ id: "boti_2" })).toEqual([])
  })
})

describe("recipientGrant", () => {
  it("turns a picked recipient into a person's list entry", () => {
    expect(recipientGrant(CHAT, 7)).toEqual({
      recipient: { kind: "conversation", channel: "bot-a", recipient: "conv:lark:bot-a:oc_1" },
      addedAt: 7,
      addedBy: "local-user",
    })
    expect(recipientGrant(MAIL, 7)?.recipient).toEqual({
      kind: "mail",
      channel: "mail",
      recipient: "mail:ops@example.com",
    })
  })

  it("refuses a target no list may hold", () => {
    expect(
      recipientGrant({ kind: "public", channel: "tool:x", recipient: "public:x" })
    ).toBeUndefined()
    expect(recipientGrant({ kind: "unknown", channel: "tool:x", recipient: "*" })).toBeUndefined()
  })

  it("finds a recipient a list already holds", () => {
    expect(listsRecipient([grant(CHAT)], CHAT)).toBe(true)
    expect(listsRecipient([grant(CHAT)], MEMBER)).toBe(false)
  })
})

describe("configuredPolicyGrants", () => {
  it("reads the list of each bot account the targets go through, once each", async () => {
    const adapterRecipients = jest.fn(async (id: string) =>
      id === "bot-a" ? [grant(CHAT)] : undefined
    )
    const lists = await configuredPolicyGrants([CHAT, MEMBER, MAIL], {
      adapterRecipients,
      proactivePush: async () => false,
    })
    expect(adapterRecipients).toHaveBeenCalledTimes(1)
    expect(adapterRecipients).toHaveBeenCalledWith("bot-a")
    expect(lists).toEqual([
      { policyRef: "adapter:bot-a", fingerprints: [outboundFingerprint(CHAT)] },
    ])
  })

  it("grants a conversation that opted into proactive pushes, on its chat or thread key", async () => {
    const proactivePush = jest.fn(async (key: string) => key === "lark:bot-a:oc_1:om_t")
    const lists = await configuredPolicyGrants([CHAT], {
      conversationKeys: ["lark:bot-a:oc_1:om_t"],
      adapterRecipients: async () => undefined,
      proactivePush,
    })
    expect(proactivePush).toHaveBeenCalledWith("lark:bot-a:oc_1")
    expect(lists).toEqual([
      {
        policyRef: "proactive-push:lark:bot-a:oc_1:om_t",
        fingerprints: [outboundFingerprint(CHAT)],
      },
    ])
  })

  it("grants nothing when a lookup fails", async () => {
    await expect(
      configuredPolicyGrants([CHAT], {
        adapterRecipients: async () => {
          throw new Error("db closed")
        },
        proactivePush: async () => {
          throw new Error("db closed")
        },
      })
    ).resolves.toEqual([])
  })
})

describe("running handler Bots", () => {
  const installation = (id: string) => ({ id, outboundRecipients: [grant(CHAT)] })

  it("lends a plugin its running installations' lists until each run ends", () => {
    const endOne = beginBotOutboundRun("run-1", { pluginId: "p1", installation: installation("a") })
    const endTwo = beginBotOutboundRun("run-2", { pluginId: "p1", installation: installation("b") })
    beginBotOutboundRun("run-3", { pluginId: "p2", installation: installation("c") })
    expect(runningBotGrantsOf("p1").map((list) => list.policyRef)).toEqual(["bot:a", "bot:b"])
    endOne()
    expect(runningBotGrantsOf("p1").map((list) => list.policyRef)).toEqual(["bot:b"])
    endTwo()
    expect(runningBotGrantsOf("p1")).toEqual([])
    expect(runningBotGrantsOf("p2").map((list) => list.policyRef)).toEqual(["bot:c"])
  })

  it("records nothing for an installation with no list", () => {
    const end = beginBotOutboundRun("run-1", { pluginId: "p1", installation: { id: "a" } })
    expect(runningBotGrantsOf("p1")).toEqual([])
    end()
  })
})
