/** @jest-environment jsdom */

import "fake-indexeddb/auto"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createIntegrationAccount,
  createIntegrationSubscription,
  insertIntegrationEvent,
  pruneIntegrationRetention,
} from "@/lib/db/integrations"
import { __resetIntegrationRegistryForTesting, registerIntegrationDefinitions } from "./registry"
import { dispatchDiagnostic } from "@/lib/diagnostics/bus"
import { publishIntegrationEvent, recoverIntegrationEventProjections } from "./events"

const findMatchingWorkflows = jest.fn()
const dispatchTrigger = jest.fn()

jest.mock("@/lib/workflow/runtime/trigger-subscriptions", () => ({
  findMatchingWorkflows: (...args: unknown[]) => findMatchingWorkflows(...args),
}))
jest.mock("@/lib/workflow/runtime/trigger-bridge", () => ({
  dispatchTrigger: (...args: unknown[]) => dispatchTrigger(...args),
}))
jest.mock("@/lib/diagnostics/bus", () => ({ dispatchDiagnostic: jest.fn() }))
const refreshIssues = jest.fn()
jest.mock("@/lib/issues/github-event-refresh", () => ({
  GithubEventIssueRefresher: {
    relevant: (event: { pluginId: string; eventType: string }) =>
      event.pluginId === "github-delivery" && event.eventType.startsWith("issues."),
  },
  getGithubEventIssueRefresher: () => ({ handle: (...args: unknown[]) => refreshIssues(...args) }),
}))

describe("Integration event publication", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    __resetIntegrationRegistryForTesting()
    findMatchingWorkflows.mockReset()
    dispatchTrigger.mockReset()
    findMatchingWorkflows.mockReturnValue([{ workflowId: "wf-1", nodeId: "trigger-1", params: {} }])
    dispatchTrigger.mockResolvedValue(undefined)
  })

  async function setup() {
    registerIntegrationDefinitions({
      pluginId: "example-delivery",
      definitions: [
        {
          id: "example",
          label: "Example",
          authStrategies: [],
          resourceKinds: ["issue"],
          eventTypes: [
            {
              id: "issue.updated",
              label: "Issue updated",
              resourceKinds: ["issue"],
            },
          ],
          actions: [],
          inboxProjections: [
            {
              id: "issue-thread",
              label: "Issue thread",
              eventTypes: ["issue.updated"],
              threadKeyPointer: "/issue/id",
              titlePointer: "/issue/title",
              bodyPointer: "/comment/body",
              urlPointer: "/issue/url",
            },
          ],
        },
      ],
      handlers: {},
    })
    const account = await createIntegrationAccount("example-delivery", {
      integrationId: "example",
      providerId: "example-oauth",
      authSessionId: "opaque",
      remoteAccountId: "acct",
      label: "Example",
    })
    const subscription = await createIntegrationSubscription("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      resourceKind: "issue",
      resourceId: "EX-1",
      eventTypes: ["issue.updated"],
      inboxProjectionId: "issue-thread",
    })
    return { account, subscription }
  }

  it("fans a normalized event to Workflow and a host-owned Inbox thread once", async () => {
    const { account, subscription } = await setup()
    const event = {
      schemaVersion: 1 as const,
      id: "event-1",
      pluginId: "example-delivery",
      integrationId: "example",
      accountId: account.id,
      deliveryId: "delivery-1",
      eventType: "issue.updated",
      resource: { kind: "issue", id: "EX-1" },
      occurredAt: "2026-07-28T00:00:00.000Z",
      receivedAt: "2026-07-28T00:00:01.000Z",
      payload: {
        issue: { id: "EX-1", title: "Fix the integration", url: "https://example.test/EX-1" },
        comment: { body: "Ready for review" },
      },
    }

    await expect(publishIntegrationEvent("example-delivery", event)).resolves.toEqual({
      inserted: true,
      // No Bot is installed in this fixture. Zero is the honest count, not a
      // sign the Bot plane was skipped.
      botDeliveries: 0,
      workflowDispatches: 1,
      inboxProjections: 1,
    })
    await expect(publishIntegrationEvent("example-delivery", event)).resolves.toEqual({
      inserted: false,
      workflowDispatches: 0,
      inboxProjections: 0,
      botDeliveries: 0,
    })

    expect(findMatchingWorkflows).toHaveBeenCalledWith("trigger.integration.event", {
      pluginId: "example-delivery",
      integrationId: "example",
      accountId: account.id,
      eventType: "issue.updated",
      resourceKind: "issue",
      resourceId: "EX-1",
    })
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowId: "wf-1",
        triggerId: "trigger-1",
        kind: "trigger.integration.event",
        payload: expect.objectContaining({ subscriptionId: subscription.id }),
        // The run is keyed on the delivery, not on when it arrived.
        occurrenceKey: `example-delivery:example:${account.id}:delivery-1`,
      })
    )

    const sessions = await getDb().sessions.toArray()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({
      title: "Fix the integration",
      integrationBinding: {
        pluginId: "example-delivery",
        integrationId: "example",
        accountId: account.id,
        projectionId: "issue-thread",
        threadKey: "EX-1",
      },
    })
    const messages = await getDb().messages.where("sessionId").equals(sessions[0].id).toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Ready for review\n\nhttps://example.test/EX-1" },
    ])
  })

  it("dispatches each Workflow trigger once when multiple subscriptions match", async () => {
    const { account, subscription } = await setup()
    const second = await createIntegrationSubscription("example-delivery", {
      integrationId: "example",
      accountId: account.id,
      resourceKind: "issue",
      resourceId: "EX-1",
      eventTypes: ["issue.updated"],
      inboxProjectionId: "issue-thread",
    })

    await publishIntegrationEvent("example-delivery", {
      schemaVersion: 1,
      id: "event-many-subscriptions",
      pluginId: "example-delivery",
      integrationId: "example",
      accountId: account.id,
      deliveryId: "delivery-many-subscriptions",
      eventType: "issue.updated",
      resource: { kind: "issue", id: "EX-1" },
      occurredAt: "2026-07-28T00:00:00.000Z",
      receivedAt: "2026-07-28T00:00:01.000Z",
      payload: {
        issue: { id: "EX-1", title: "Fix duplicate dispatches" },
        comment: { body: null },
      },
    })

    expect(dispatchTrigger).toHaveBeenCalledTimes(1)
    const subscriptionIds = [subscription.id, second.id].sort()
    expect(dispatchTrigger).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          subscriptionId: subscriptionIds[0],
          subscriptionIds,
        }),
      })
    )
    const messages = await getDb().messages.toArray()
    expect(messages).toHaveLength(1)
    expect(messages[0].parts).toEqual([{ type: "text", text: "Fix duplicate dispatches" }])
  })

  describe("GitHub pull request conversation", () => {
    async function setupThreads() {
      registerIntegrationDefinitions({
        pluginId: "github-delivery",
        definitions: [
          {
            id: "github",
            label: "GitHub",
            authStrategies: [],
            resourceKinds: ["repository"],
            eventTypes: [
              "pull_request.opened",
              "pull_request_review_comment.created",
              "issue_comment.created",
            ].map((id) => ({ id, label: id, resourceKinds: ["repository"] })),
            actions: [],
            inboxProjections: [
              {
                id: "pull-request-thread",
                label: "PR",
                eventTypes: ["pull_request.opened", "pull_request_review_comment.created"],
                threadKeyPointer: "/pull_request/number",
                titlePointer: "/pull_request/title",
                bodyFallbackPointers: ["/comment/body", "/review/body"],
                bodyPointer: "/pull_request/body",
                urlFallbackPointers: ["/comment/html_url"],
                urlPointer: "/pull_request/html_url",
              },
              {
                id: "issue-comment-thread",
                label: "Comments",
                eventTypes: ["issue_comment.created"],
                threadKeyPointer: "/issue/number",
                titlePointer: "/issue/title",
                bodyPointer: "/comment/body",
                urlPointer: "/comment/html_url",
                threadAlias: {
                  whenPointer: "/issue/pull_request",
                  projectionId: "pull-request-thread",
                },
              },
            ],
          },
        ],
        handlers: {},
      })
      const account = await createIntegrationAccount("github-delivery", {
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "octocat",
      })
      for (const [eventTypes, inboxProjectionId] of [
        [["pull_request.opened", "pull_request_review_comment.created"], "pull-request-thread"],
        [["issue_comment.created"], "issue-comment-thread"],
      ] as const) {
        await createIntegrationSubscription("github-delivery", {
          integrationId: "github",
          accountId: account.id,
          eventTypes: [...eventTypes],
          inboxProjectionId,
        })
      }
      return account
    }

    function github(
      accountId: string,
      id: string,
      eventType: string,
      payload: Record<string, unknown>
    ) {
      return {
        schemaVersion: 1 as const,
        id,
        pluginId: "github-delivery",
        integrationId: "github",
        accountId,
        deliveryId: id,
        eventType,
        resource: { kind: "repository", id: "acme/app" },
        occurredAt: "2026-07-28T00:00:00.000Z",
        receivedAt: "2026-07-28T00:00:01.000Z",
        payload,
      }
    }

    it("keeps a PR's line comments and conversation comments in the PR's one thread", async () => {
      const account = await setupThreads()
      const pr = { number: 5, title: "Add retries", body: "PR description", html_url: "pr-url" }
      await publishIntegrationEvent(
        "github-delivery",
        github(account.id, "e1", "pull_request.opened", { pull_request: pr })
      )
      await publishIntegrationEvent(
        "github-delivery",
        github(account.id, "e2", "pull_request_review_comment.created", {
          pull_request: pr,
          comment: { body: "nit: rename", html_url: "line-url" },
        })
      )
      await publishIntegrationEvent(
        "github-delivery",
        github(account.id, "e3", "issue_comment.created", {
          issue: { number: 5, title: "Add retries", pull_request: { url: "x" } },
          comment: { body: "LGTM", html_url: "comment-url" },
        })
      )
      // A plain issue with the same number is a different conversation.
      await publishIntegrationEvent(
        "github-delivery",
        github(account.id, "e4", "issue_comment.created", {
          issue: { number: 6, title: "Bug" },
          comment: { body: "Repro attached", html_url: "issue-url" },
        })
      )

      const sessions = await getDb().sessions.toArray()
      expect(sessions.map((s) => s.integrationBinding?.projectionId).sort()).toEqual([
        "issue-comment-thread",
        "pull-request-thread",
      ])
      const prThread = sessions.find(
        (s) => s.integrationBinding?.projectionId === "pull-request-thread"
      )!
      const texts = (await getDb().messages.where("sessionId").equals(prThread.id).toArray()).map(
        (m) => (m.parts[0] as { text: string }).text
      )
      expect(texts.sort()).toEqual(
        ["LGTM\n\ncomment-url", "PR description\n\npr-url", "nit: rename\n\nline-url"].sort()
      )
    })
  })

  describe("issue board refresh", () => {
    async function setupGithub() {
      registerIntegrationDefinitions({
        pluginId: "github-delivery",
        definitions: [
          {
            id: "github",
            label: "GitHub",
            authStrategies: [],
            resourceKinds: ["repository"],
            eventTypes: [
              { id: "issues.closed", label: "Issue closed", resourceKinds: ["repository"] },
            ],
            actions: [],
          },
        ],
        handlers: {},
      })
      return createIntegrationAccount("github-delivery", {
        integrationId: "github",
        providerId: "github-pat",
        authSessionId: "opaque",
        remoteAccountId: "octocat",
        label: "octocat",
      })
    }

    function closed(accountId: string, id = "gh-1") {
      return {
        schemaVersion: 1 as const,
        id,
        pluginId: "github-delivery",
        integrationId: "github",
        accountId,
        deliveryId: id,
        eventType: "issues.closed",
        resource: { kind: "repository", id: "acme/app" },
        occurredAt: "2026-07-28T00:00:00.000Z",
        receivedAt: "2026-07-28T00:00:01.000Z",
        payload: { action: "closed", issue: { number: 7 } },
      }
    }

    beforeEach(() => refreshIssues.mockReset())

    it("hands a GitHub issue event to the board refresher", async () => {
      const account = await setupGithub()
      const event = closed(account.id)
      await publishIntegrationEvent("github-delivery", event)
      expect(refreshIssues).toHaveBeenCalledWith(event)
    })

    it("still delivers the event when the board refresh throws", async () => {
      const account = await setupGithub()
      refreshIssues.mockRejectedValue(new Error("dexie closed"))
      await expect(
        publishIntegrationEvent("github-delivery", closed(account.id, "gh-2"))
      ).resolves.toMatchObject({ inserted: true, workflowDispatches: 1 })
    })

    it("does not refresh for other integrations", async () => {
      const { account } = await setup()
      await publishIntegrationEvent("example-delivery", {
        schemaVersion: 1 as const,
        id: "event-x",
        pluginId: "example-delivery",
        integrationId: "example",
        accountId: account.id,
        deliveryId: "delivery-x",
        eventType: "issue.updated",
        resource: { kind: "issue", id: "EX-1" },
        occurredAt: "2026-07-28T00:00:00.000Z",
        receivedAt: "2026-07-28T00:00:01.000Z",
        payload: {},
      })
      expect(refreshIssues).not.toHaveBeenCalled()
    })
  })

  describe("projection recovery", () => {
    function issueEvent(accountId: string, id: string) {
      return {
        schemaVersion: 1 as const,
        id,
        pluginId: "example-delivery",
        integrationId: "example",
        accountId,
        deliveryId: `delivery-${id}`,
        eventType: "issue.updated",
        resource: { kind: "issue", id: "EX-1" },
        occurredAt: "2026-07-28T00:00:00.000Z",
        receivedAt: "2026-07-28T00:00:01.000Z",
        payload: {
          issue: { id: "EX-1", title: "Recover me" },
          comment: { body: `body ${id}` },
        },
      }
    }

    const FAR_FUTURE = Date.now() + 24 * 60 * 60 * 1000

    it("settles a fully projected event and treats a redelivery as a duplicate", async () => {
      const { account } = await setup()
      await publishIntegrationEvent("example-delivery", issueEvent(account.id, "ok"))
      const row = await getDb().integrationEvents.get("ok")
      expect(row).toMatchObject({ projectionState: "complete", projectionAttempts: 0 })
      expect(row?.projectionDueAt).toBeUndefined()
    })

    it("records a throwing consumer instead of losing the event, then finishes it", async () => {
      const { account } = await setup()
      dispatchTrigger.mockRejectedValueOnce(new Error("workflow store closed"))

      await expect(
        publishIntegrationEvent("example-delivery", issueEvent(account.id, "wf-fail"))
      ).resolves.toMatchObject({
        inserted: true,
        inboxProjections: 1,
        pendingSteps: ["workflow"],
      })
      // Reported, not swallowed: the old best-effort path dropped this silently.
      expect(dispatchDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "workflow store closed",
          meta: expect.objectContaining({
            extra: expect.objectContaining({ step: "workflow", eventId: "wf-fail" }),
          }),
        }),
        { kind: "background" }
      )
      const pending = await getDb().integrationEvents.get("wf-fail")
      expect(pending).toMatchObject({ projectionState: "pending", projectionAttempts: 1 })
      expect(pending?.projection?.steps.workflow).toMatchObject({ status: "pending" })
      expect(pending?.projection?.steps.inbox).toEqual({ status: "complete" })

      // A redelivery before the backoff passes does not race the recovery.
      await expect(
        publishIntegrationEvent("example-delivery", issueEvent(account.id, "wf-fail"))
      ).resolves.toEqual({
        inserted: false,
        workflowDispatches: 0,
        inboxProjections: 0,
        botDeliveries: 0,
      })

      await expect(recoverIntegrationEventProjections({ now: FAR_FUTURE })).resolves.toBe(1)
      expect(dispatchTrigger).toHaveBeenCalledTimes(2)
      expect(await getDb().integrationEvents.get("wf-fail")).toMatchObject({
        projectionState: "complete",
      })
      // The inbox step had already finished: recovery did not post it twice.
      expect(await getDb().messages.count()).toBe(1)
    })

    it("resumes an event whose process died before recording the outcome", async () => {
      const { account } = await setup()
      // Exactly what a crash right after the insert leaves behind.
      await insertIntegrationEvent(issueEvent(account.id, "crash"), 0)

      await expect(recoverIntegrationEventProjections({ now: FAR_FUTURE })).resolves.toBe(1)
      expect(dispatchTrigger).toHaveBeenCalledTimes(1)
      expect(await getDb().messages.count()).toBe(1)
      expect(await getDb().integrationEvents.get("crash")).toMatchObject({
        projectionState: "complete",
      })
    })

    it("resumes on a redelivery once the lease of a dead pass has expired", async () => {
      const { account } = await setup()
      await insertIntegrationEvent(issueEvent(account.id, "redeliver"), 0)
      await expect(
        publishIntegrationEvent("example-delivery", issueEvent(account.id, "redeliver"))
      ).resolves.toMatchObject({ inserted: false, resumed: true, workflowDispatches: 1 })
    })

    it("deadletters an event whose consumer keeps failing", async () => {
      const { account } = await setup()
      dispatchTrigger.mockRejectedValue(new Error("permanently broken"))
      await publishIntegrationEvent("example-delivery", issueEvent(account.id, "dead"))
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await recoverIntegrationEventProjections({ now: FAR_FUTURE * (attempt + 2) })
      }
      const row = await getDb().integrationEvents.get("dead")
      expect(row).toMatchObject({ projectionState: "deadletter", projectionAttempts: 5 })
      // A deadlettered row is not picked up again.
      await expect(recoverIntegrationEventProjections({ now: FAR_FUTURE * 10 })).resolves.toBe(0)
    })

    it("never prunes an event whose projections are unfinished", async () => {
      const { account } = await setup()
      dispatchTrigger.mockRejectedValueOnce(new Error("later"))
      await publishIntegrationEvent("example-delivery", issueEvent(account.id, "keep"))
      await publishIntegrationEvent("example-delivery", issueEvent(account.id, "drop"))
      const later = Date.parse("2026-07-28T00:00:01.000Z") + 31 * 24 * 60 * 60 * 1000
      await expect(pruneIntegrationRetention(later)).resolves.toMatchObject({ events: 1 })
      expect(await getDb().integrationEvents.get("keep")).toBeDefined()
      expect(await getDb().integrationEvents.get("drop")).toBeUndefined()
    })

    it("never re-projects a legacy row written before tracking existed", async () => {
      const { account } = await setup()
      await getDb().integrationEvents.add(issueEvent(account.id, "legacy"))
      await expect(
        publishIntegrationEvent("example-delivery", issueEvent(account.id, "legacy"))
      ).resolves.toMatchObject({ inserted: false, workflowDispatches: 0 })
      await expect(recoverIntegrationEventProjections({ now: FAR_FUTURE })).resolves.toBe(0)
      expect(dispatchTrigger).not.toHaveBeenCalled()
    })
  })
})
