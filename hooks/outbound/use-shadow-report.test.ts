/** @jest-environment jsdom */

import type { ActionReviewReceipt } from "@cognia/agent-config-types/action-review"
import { toReceiptRow } from "@/lib/db/action-review-receipts"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import {
  conversationTarget,
  mailTarget,
  repositoryTarget,
  toReviewTarget,
  type OutboundTarget,
} from "@/lib/policy/action-review/outbound-targets"

const mockEnsureBootCapability = jest.fn(async (_capability: string) => undefined)
jest.mock("@/lib/boot/capabilities", () => ({
  ensureBootCapability: (capability: string) => mockEnsureBootCapability(capability),
}))

jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getAllTasks: async () => [{ id: "t1", name: "Morning digest" }] },
}))

const KNOWN_REPO = repositoryTarget("ghe.corp.io/acme/web")!
const mockLoadKnownRepositories = jest.fn(async () => ({
  repositories: [{ target: KNOWN_REPO, name: "ghe.corp.io/acme/web", lastSeenAt: 1 }],
  accountHosts: new Map([["acct_ghe", "ghe.corp.io"]]),
}))
jest.mock("@/hooks/outbound/use-known-repositories", () => ({
  loadKnownRepositories: () => mockLoadKnownRepositories(),
}))
// The registry fills in when a plugin loads; `registered` and the listeners
// let a test load the GitHub plugin after the report was first read.
let mockRegistered = true
let mockRevision = 0
const mockListeners = new Set<() => void>()
jest.mock("@/lib/integrations/registry", () => ({
  getRegisteredIntegration: (pluginId: string, integrationId: string) =>
    mockRegistered && pluginId === "github-delivery" && integrationId === "github"
      ? { definition: { id: "github", actions: [] } }
      : undefined,
  getIntegrationRegistryRevision: () => mockRevision,
  subscribeIntegrationRegistry: (listener: () => void) => {
    mockListeners.add(listener)
    return () => mockListeners.delete(listener)
  },
}))

import { act, renderHook, waitFor } from "@testing-library/react"

import { loadShadowReport, useShadowReport } from "./use-shadow-report"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  mockRegistered = true
})
afterAll(dbFixture.dispose)

const KNOWN = conversationTarget("lark:bot-a:oc_known")!
const BOUND = conversationTarget("lark:bot-a:oc_bound")!
const LISTED_MAIL = mailTarget("ops@example.com")!
const STRANGER = conversationTarget("lark:bot-a:oc_stranger")!

function receipt(
  root: string,
  target: OutboundTarget,
  enforced = false,
  subject: Record<string, unknown> = {}
): ActionReviewReceipt {
  const requestId = crypto.randomUUID()
  return {
    id: requestId,
    request: {
      contractVersion: 1,
      requestId,
      origin: { channel: "chat-tool", scope: "chat", id: requestId, rootSessionId: root },
      subject: {
        kind: "tool-call",
        ref: "im_send",
        targets: [toReviewTarget(target)],
        ...subject,
      },
      verdict: "ask",
      verdictExplicit: false,
      tier: "medium",
      surfaces: [],
      plan: { outcome: "draft", enforced },
      requestedAt: 1,
    },
    decision: {
      contractVersion: 1,
      requestId,
      outcome: "allow",
      authority: "policy-default",
      decidedAt: 10,
    },
  } as unknown as ActionReviewReceipt
}

describe("loadShadowReport", () => {
  it("names recipients from what the device holds, and the senders and accounts", async () => {
    const db = getDb()
    await db.actionReviewReceipts.bulkPut(
      [
        receipt("task:t1", KNOWN),
        receipt("task:t1", BOUND),
        receipt("task:t1", STRANGER),
        receipt("bot:boti_1", LISTED_MAIL),
        // Enforced plans are not shadow observations.
        receipt("task:t1", KNOWN, true),
      ].map(toReceiptRow)
    )
    await db.connectorConversationStates.put({
      conversationKey: "lark:bot-a:oc_known",
      adapterId: "bot-a",
    } as never)
    await db.sessions.put({
      id: "s1",
      title: "Ops room",
      platformBinding: { conversationKey: "lark:bot-a:oc_bound:om_thread" },
    } as never)
    await db.adapterInstances.put({ id: "bot-a", displayName: "Team bot", type: "lark" } as never)
    // The Bot's own list names the address; its runs are granted it, a task's are not.
    await db.botInstallations.put({
      id: "boti_1",
      outboundRecipients: [{ recipient: LISTED_MAIL, addedAt: 1, addedBy: "local-user" }],
    } as never)
    await db.actionReviewReceipts.put(toReceiptRow(receipt("task:t1", LISTED_MAIL)))

    const view = await loadShadowReport()
    expect(view.taskNames.get("t1")).toBe("Morning digest")
    expect(view.adapterNames.get("bot-a")).toBe("Team bot")
    expect(view.conversationTitles.get(BOUND.recipient)).toBe("Ops room")

    expect(view.report.messaging.groups.map((group) => group.sender)).toEqual([
      { kind: "task", id: "t1" },
    ])
    const [task] = view.report.messaging.groups
    expect(task.rows.map((row) => row.target.recipient).sort()).toEqual(
      [KNOWN.recipient, BOUND.recipient, LISTED_MAIL.recipient].sort()
    )
    expect(task.unrecognized).toEqual([
      expect.objectContaining({ channel: "bot-a", recipients: 1, sends: 1 }),
    ])
    expect(view.report.messaging.sends).toBe(4)
  })

  it("reports nothing when nothing was held", async () => {
    const view = await loadShadowReport()
    const empty = { groups: [], totals: {}, sends: 0 }
    expect(view.report).toEqual({ messaging: empty, github: empty, browser: empty })
  })

  it("names known repositories and offers the GitHub account the write went through", async () => {
    const db = getDb()
    const now = "2026-10-25T00:00:00.000Z"
    const account = (id: string, integrationId = "github") => ({
      id,
      pluginId: "github-delivery",
      integrationId,
      providerId: "github-pat",
      authSessionId: id,
      remoteAccountId: "octo",
      label: `Account ${id}`,
      enabled: true,
      health: "unknown",
      createdAt: now,
      updatedAt: now,
    })
    // A non-GitHub integration's account is not a GitHub list.
    await db.integrationAccounts.bulkPut([
      account("acct_ghe"),
      account("acct_jira", "jira"),
    ] as never)
    await db.agentTeams.put({ id: "team_1", name: "Release squad", config: {} } as never)
    await db.actionReviewReceipts.put(
      toReceiptRow(
        receipt("workflow-run:wr_1", KNOWN_REPO, false, {
          kind: "integration-action",
          ref: "workflow:wf_1",
          input: { integrationAccount: { pluginId: "github-delivery", accountId: "acct_ghe" } },
        })
      )
    )

    const view = await loadShadowReport()
    expect(view.accountNames).toEqual(new Map([["acct_ghe", "Account acct_ghe"]]))
    expect(view.teamNames.get("team_1")).toBe("Release squad")
    expect(view.report.messaging.sends).toBe(0)
    const [workflow] = view.report.github.groups
    expect(workflow.sender).toEqual({ kind: "workflow", id: "wr_1" })
    expect(workflow.rows).toEqual([
      expect.objectContaining({
        target: KNOWN_REPO,
        allowInto: {
          kind: "integration-account",
          pluginId: "github-delivery",
          accountId: "acct_ghe",
        },
      }),
    ])
  })

  it("reads again when a plugin registers its integration after the first read", async () => {
    mockRegistered = false
    const now = "2026-10-25T00:00:00.000Z"
    await getDb().integrationAccounts.put({
      id: "acct_ghe",
      pluginId: "github-delivery",
      integrationId: "github",
      providerId: "github-pat",
      authSessionId: "acct_ghe",
      remoteAccountId: "octo",
      label: "Work",
      enabled: true,
      health: "unknown",
      createdAt: now,
      updatedAt: now,
    } as never)
    const { result } = renderHook(() => useShadowReport())
    await waitFor(() => expect(result.current).toBeDefined())
    expect(result.current?.accountNames.size).toBe(0)
    // Settings does not boot the plugin runtime, so the report asks for it.
    expect(mockEnsureBootCapability).toHaveBeenCalledWith("plugin-runtime")

    // The plugin loads: the registry changes and the report is read again.
    mockRegistered = true
    act(() => {
      mockRevision += 1
      for (const listener of mockListeners) listener()
    })
    await waitFor(() => expect(result.current?.accountNames.get("acct_ghe")).toBe("Work"))
  })

  it("boots nothing while disabled (a paired Host's settings)", async () => {
    mockEnsureBootCapability.mockClear()
    const { result } = renderHook(() => useShadowReport(false))
    await act(async () => undefined)
    expect(result.current).toBeUndefined()
    expect(mockEnsureBootCapability).not.toHaveBeenCalled()
  })
})
