import type { OutboundRecipientGrant } from "@cognia/agent-config-types/action-review"

import { STACKED_DELIVERY_DEFAULTS } from "@/lib/stack/team-policy"

import {
  __resetRunningBotGrantsForTesting,
  beginBotOutboundRun,
  botRecipientGrants,
  botScopeGrants,
  configuredGithubGrants,
  configuredPolicyGrants,
  listsRecipient,
  recipientGrant,
  recipientGrantList,
  runningBotGrantsOf,
  teamDeliveryGrants,
} from "./configured-grants"
import {
  conversationTarget,
  mailTarget,
  outboundFingerprint,
  personTarget,
  repositoryTarget,
  siteTarget,
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

  it("lists a repository whole, and a site by its origin (ADR-0239 phase 2)", () => {
    expect(recipientGrant(repositoryTarget("acme/web", 12)!, 7)?.recipient).toEqual({
      kind: "repository",
      channel: "github",
      recipient: "github:github.com/acme/web",
    })
    expect(recipientGrant(siteTarget("https://forms.example.com/a")!, 7)?.recipient).toEqual({
      kind: "site",
      channel: "browser",
      recipient: "site:https://forms.example.com",
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

describe("configuredGithubGrants (ADR-0239 phase 2)", () => {
  const WEB = repositoryTarget("acme/web")!
  const ENTERPRISE = repositoryTarget("ghe.example.com/acme/web")!
  const account = { pluginId: "github-delivery", accountId: "acct_1" }
  const commentPr = {
    actionId: "commentPr",
    operationId: "github.commentPr",
    risk: "write",
  } as const
  const connection = { id: "conn_1", providerFingerprint: "fp" }
  const capabilityGrant = (extra: Record<string, unknown> = {}) => ({
    id: "grant_1",
    connectionId: "conn_1",
    providerFingerprint: "fp",
    operationPatterns: ["github.comment*"],
    resourceScopes: [{ kind: "repository", values: ["Acme/Web"] }],
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-25T00:00:00.000Z",
    ...extra,
  })

  it("is the account's own list", async () => {
    const accountRecipients = jest.fn(async () => [grant(WEB)])
    await expect(
      configuredGithubGrants({ account }, { accountRecipients, capabilityGrants: async () => [] })
    ).resolves.toEqual([
      { policyRef: "integration-account:acct_1", fingerprints: [outboundFingerprint(WEB)] },
    ])
    expect(accountRecipients).toHaveBeenCalledWith("github-delivery", "acct_1")
  })

  it("is every GitHub account's list for a gh command, which names no account", async () => {
    const githubAccountRecipients = async () => [
      { id: "a", outboundRecipients: [grant(WEB)] },
      { id: "b", outboundRecipients: [] },
      { id: "c" },
    ]
    await expect(configuredGithubGrants({}, { githubAccountRecipients })).resolves.toEqual([
      { policyRef: "integration-account:a", fingerprints: [outboundFingerprint(WEB)] },
    ])
  })

  it("adds a repository-scoped capability grant that covers the action, on the account's host", async () => {
    const lists = await configuredGithubGrants(
      { account, operation: commentPr, host: "ghe.example.com" },
      {
        accountRecipients: async () => undefined,
        capabilityGrants: async () => [{ connection, grants: [capabilityGrant()] }],
      }
    )
    expect(lists).toEqual([
      { policyRef: "capability-grant:grant_1", fingerprints: [outboundFingerprint(ENTERPRISE)] },
    ])
  })

  it.each([
    ["another operation", capabilityGrant({ operationPatterns: ["github.mergePr"] })],
    [
      "the action id, when it has an operation id",
      capabilityGrant({ operationPatterns: ["commentPr"] }),
    ],
    ["no repository scope", capabilityGrant({ resourceScopes: undefined })],
    ["an expired grant", capabilityGrant({ expiresAt: "2000-01-01T00:00:00.000Z" })],
    ["another workflow", capabilityGrant({ workflowId: "wf_other" })],
    ["another connection", capabilityGrant({ connectionId: "conn_2" })],
  ])("skips a capability grant for %s", async (_label, candidate) => {
    await expect(
      configuredGithubGrants(
        { account, operation: { ...commentPr, workflowId: "wf_1" } },
        {
          accountRecipients: async () => undefined,
          capabilityGrants: async () => [{ connection, grants: [candidate] }],
        }
      )
    ).resolves.toEqual([])
  })

  it("needs allowDestructive for a destructive action", async () => {
    const destructive = { actionId: "mergePr", risk: "destructive" } as const
    const deps = (allowDestructive?: boolean) => ({
      accountRecipients: async () => undefined,
      capabilityGrants: async () => [
        {
          connection,
          grants: [capabilityGrant({ operationPatterns: ["*"], allowDestructive })],
        },
      ],
    })
    await expect(
      configuredGithubGrants({ account, operation: destructive }, deps())
    ).resolves.toEqual([])
    await expect(
      configuredGithubGrants({ account, operation: destructive }, deps(true))
    ).resolves.toHaveLength(1)
  })

  it("reads no capability grant for a raw request or a gh command", async () => {
    const capabilityGrants = jest.fn(async () => [{ connection, grants: [capabilityGrant()] }])
    await configuredGithubGrants(
      { account },
      { accountRecipients: async () => undefined, capabilityGrants }
    )
    await configuredGithubGrants({}, { githubAccountRecipients: async () => [], capabilityGrants })
    expect(capabilityGrants).not.toHaveBeenCalled()
  })

  it("grants nothing from a lookup that fails", async () => {
    const fail = async () => {
      throw new Error("db closed")
    }
    await expect(
      configuredGithubGrants(
        { account, operation: commentPr },
        { accountRecipients: fail, capabilityGrants: fail }
      )
    ).resolves.toEqual([])
    await expect(configuredGithubGrants({}, { githubAccountRecipients: fail })).resolves.toEqual([])
  })
})

describe("botScopeGrants", () => {
  it("is the installation's repository, on the account's host", () => {
    expect(botScopeGrants({ id: "boti_1" }, "acme/web", "ghe.example.com")).toEqual([
      {
        policyRef: "bot-scope:boti_1",
        fingerprints: [outboundFingerprint(repositoryTarget("ghe.example.com/acme/web")!)],
      },
    ])
  })

  it("is nothing without a scope", () => {
    expect(botScopeGrants({ id: "boti_1" }, undefined)).toEqual([])
    expect(botScopeGrants({ id: "boti_1" }, "not a repository")).toEqual([])
  })
})

describe("teamDeliveryGrants", () => {
  const stacked = { ...STACKED_DELIVERY_DEFAULTS }

  it("is the team's bound repositories when stacked delivery is on", () => {
    expect(
      teamDeliveryGrants({ id: "team_1", config: { githubDeliveryPolicy: stacked } }, [
        "acme/web",
        "acme/api",
        "",
      ])
    ).toEqual([
      {
        policyRef: "team-delivery:team_1",
        fingerprints: [
          outboundFingerprint(repositoryTarget("acme/web")!),
          outboundFingerprint(repositoryTarget("acme/api")!),
        ],
      },
    ])
  })

  it("is nothing when stacked delivery is off, or nothing is bound", () => {
    expect(
      teamDeliveryGrants(
        {
          id: "team_1",
          config: {
            githubDeliveryPolicy: { ...STACKED_DELIVERY_DEFAULTS, stackedPullRequests: false },
          },
        },
        ["acme/web"]
      )
    ).toEqual([])
    expect(teamDeliveryGrants({ id: "team_1", config: {} }, ["acme/web"])).toEqual([])
    expect(
      teamDeliveryGrants({ id: "team_1", config: { githubDeliveryPolicy: stacked } }, [])
    ).toEqual([])
  })
})
