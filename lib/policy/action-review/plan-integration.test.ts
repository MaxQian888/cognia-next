import {
  isActionReviewDecision,
  isActionReviewRequest,
} from "@cognia/agent-config-types/action-review"

import { actionReviewAuthKeyPrefix } from "@/lib/db/action-review-receipts"

import {
  __resetAuthorizedToolCallsForTesting,
  authorizeOutboundToolCall,
  beginOutboundToolExecution,
  rememberPlannedOutboundToolCall,
} from "./authorized-tool-calls"
import { __resetRunningBotGrantsForTesting, beginBotOutboundRun } from "./configured-grants"
import { outboundFingerprint, repositoryTarget, unknownGithubTarget } from "./outbound-targets"
import {
  botEventOriginThread,
  heldJobAnswerReceipt,
  integrationOutboundReview,
  planIntegrationWrite,
  type IntegrationAuthorization,
  type PlanIntegrationDeps,
} from "./plan-integration"

const PR_12 = repositoryTarget("acme/web", 12)!
const PR_13 = repositoryTarget("acme/web", 13)!
const REPO = repositoryTarget("acme/web")!
const OTHER_REPO = repositoryTarget("acme/api", 4)!

const enforce = { agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } } }
const messagingOnly = { agentPermissions: { outboundAuthorization: "enforce" } }
const shadow = { agentPermissions: {} }

function deps(
  settings: object,
  keys: Record<string, string[]> = {},
  extra: Partial<PlanIntegrationDeps> = {}
): PlanIntegrationDeps {
  let seq = 0
  return {
    settings: () => settings,
    listAuthKeys: async (prefix) => keys[prefix] ?? [],
    resolveSessionOrigin: async () => ({
      rootSessionId: "root-1",
      instructionEpoch: "epoch-1",
      originThread: PR_12,
    }),
    botRunEvent: async () => ({
      resource: { kind: "repository", id: "acme/web" },
      payload: { pull_request: { number: 12 } },
    }),
    workflowRunTrigger: async () => undefined,
    now: () => 5_000,
    newRequestId: () => `n${++seq}`,
    ...extra,
  }
}

const write = (
  targets: Parameters<typeof planIntegrationWrite>[0]["targets"],
  authorization: IntegrationAuthorization
) => ({ targets, operation: "github.commentPr", authorization })

const installation = { id: "boti_1", humanRevision: 2 }

beforeEach(() => {
  __resetAuthorizedToolCallsForTesting()
  __resetRunningBotGrantsForTesting()
})

describe("botEventOriginThread", () => {
  it("is the event's repository on its pull request, else its issue", () => {
    expect(
      botEventOriginThread({
        resource: { kind: "repository", id: "Acme/Web" },
        payload: { pull_request: { number: 12 }, issue: { number: 3 } },
      })
    ).toEqual(PR_12)
    expect(
      botEventOriginThread({
        resource: { kind: "repository", id: "acme/web" },
        payload: { issue: { number: "13" } },
      })
    ).toEqual(PR_13)
  })

  it("names the account's host for a GitHub Enterprise event", () => {
    expect(
      botEventOriginThread(
        { resource: { kind: "repository", id: "acme/web" }, payload: { issue: { number: 1 } } },
        "ghe.corp.io"
      )
    ).toEqual(repositoryTarget("ghe.corp.io/acme/web", 1))
  })

  it("is undefined for an event about no single PR or issue", () => {
    expect(botEventOriginThread(undefined)).toBeUndefined()
    expect(
      botEventOriginThread({ resource: { kind: "repository", id: "acme/web" }, payload: {} })
    ).toBeUndefined()
    expect(
      botEventOriginThread({
        resource: { kind: "installation", id: "9" },
        payload: { issue: { number: 1 } },
      })
    ).toBeUndefined()
    expect(
      botEventOriginThread({
        resource: { kind: "repository", id: "acme/web" },
        payload: { issue: { number: -1 } },
      })
    ).toBeUndefined()
  })
})

describe("planIntegrationWrite", () => {
  describe("plugin", () => {
    const plugin = { kind: "plugin", pluginId: "p1" } as const

    it("parks a write nothing authorized, with the card's recipients", async () => {
      const decision = await planIntegrationWrite(write([PR_13], plugin), deps(enforce))
      expect(decision).toMatchObject({
        action: "park",
        outbound: { ownerRef: "plugin:p1" },
        review: integrationOutboundReview([PR_13], [PR_13], true),
      })
      if (decision.action !== "park") throw new Error("expected a park")
      expect(isActionReviewRequest(decision.receipt.request)).toBe(true)
      expect(isActionReviewDecision(decision.receipt.decision)).toBe(true)
      expect(decision.receipt.request).toMatchObject({
        requestId: "integration:n1",
        origin: { channel: "github-delivery", scope: "github", headless: true },
        subject: {
          kind: "integration-action",
          ref: "plugin:p1",
          title: "github.commentPr",
          targets: [{ channel: "github", fingerprint: outboundFingerprint(PR_13) }],
        },
        plan: { outcome: "park", enforced: true },
      })
      expect(decision.receipt.decision).toMatchObject({
        outcome: "deny",
        authority: "policy-default",
      })
      // The receipt never names the repository.
      expect(JSON.stringify(decision.receipt)).not.toContain("acme")
    })

    it("is covered by one of the plugin's running, authorized calls", async () => {
      rememberPlannedOutboundToolCall({
        sessionId: "s1",
        requestId: "req_1",
        toolUseId: "toolu_1",
        toolName: "integration__p1__github__commentPr",
        fingerprints: [outboundFingerprint(REPO)],
      })
      authorizeOutboundToolCall("s1", "req_1", { authority: "human", grant: { scope: "once" } })
      beginOutboundToolExecution("s1", "toolu_1", "plugin:p1")
      await expect(planIntegrationWrite(write([PR_13], plugin), deps(enforce))).resolves.toEqual({
        action: "proceed",
        outbound: { ownerRef: "plugin:p1" },
        authorizedBy: { receiptId: "req_1", authority: "human", grantScope: "once" },
      })
      // Another repository, or another plugin, is not covered.
      await expect(
        planIntegrationWrite(write([PR_13, OTHER_REPO], plugin), deps(enforce))
      ).resolves.toMatchObject({ action: "park" })
      await expect(
        planIntegrationWrite(write([PR_13], { kind: "plugin", pluginId: "p2" }), deps(enforce))
      ).resolves.toMatchObject({ action: "park" })
    })

    it("borrows no running handler Bot's list: a Bot's write names its run through binding", async () => {
      const end = beginBotOutboundRun("run-1", {
        pluginId: "p1",
        installation: {
          id: "boti_1",
          outboundRecipients: [
            {
              recipient: { kind: "repository", channel: "github", recipient: REPO.recipient },
              addedAt: 1,
              addedBy: "local-user",
            },
          ],
        },
      })
      await expect(
        planIntegrationWrite(write([PR_13], plugin), deps(enforce))
      ).resolves.toMatchObject({ action: "park" })
      end()
    })

    it("never grants a write whose repository could not be named", async () => {
      await expect(
        planIntegrationWrite(write([unknownGithubTarget()], plugin), deps(enforce))
      ).resolves.toMatchObject({ action: "park" })
    })
  })

  describe("tool-call", () => {
    const call = { kind: "tool-call", pluginId: "p1", sessionId: "s1" } as const

    function allowCall(sessionId: string, fingerprints: string[]) {
      rememberPlannedOutboundToolCall({
        sessionId,
        requestId: "req_1",
        toolUseId: "toolu_1",
        toolName: "integration__p1__github__commentPr",
        fingerprints,
      })
      authorizeOutboundToolCall(sessionId, "req_1", {
        authority: "human",
        grant: { scope: "once" },
      })
      beginOutboundToolExecution(sessionId, "toolu_1", "plugin:p1")
    }

    it("proceeds on the session's authorized call of the plugin", async () => {
      allowCall("s1", [outboundFingerprint(REPO)])
      await expect(planIntegrationWrite(write([PR_13], call), deps(enforce))).resolves.toEqual({
        action: "proceed",
        outbound: {
          ownerRef: "tool-call:s1",
          rootSessionId: "root-1",
          instructionEpoch: "epoch-1",
        },
        authorizedBy: { receiptId: "req_1", authority: "human", grantScope: "once" },
      })
    })

    it("does not ride on another session's call", async () => {
      allowCall("s2", [outboundFingerprint(REPO)])
      await expect(
        planIntegrationWrite(write([PR_13], call), deps(enforce))
      ).resolves.toMatchObject({
        action: "park",
        outbound: { ownerRef: "tool-call:s1", rootSessionId: "root-1" },
      })
    })

    it("still writes on the PR the session came from", async () => {
      await expect(planIntegrationWrite(write([PR_12], call), deps(enforce))).resolves.toEqual({
        action: "proceed",
        outbound: {
          ownerRef: "tool-call:s1",
          rootSessionId: "root-1",
          instructionEpoch: "epoch-1",
        },
        authorizedBy: { authority: "policy-default" },
      })
    })

    it("proceeds without a receipt in shadow mode when the host has no record of the call", async () => {
      await expect(planIntegrationWrite(write([PR_13], call), deps(shadow))).resolves.toEqual({
        action: "proceed",
        outbound: { ownerRef: "tool-call:s1" },
      })
    })

    it("is covered by an instruction grant a person gave in the request", async () => {
      const prefix = actionReviewAuthKeyPrefix("grant", "root-1", "epoch-1")
      const keys = { [prefix]: [`${prefix}${outboundFingerprint(REPO)}`] }
      await expect(
        planIntegrationWrite(write([PR_13], call), deps(enforce, keys))
      ).resolves.toMatchObject({
        action: "proceed",
        authorizedBy: { authority: "human", grantScope: "instruction" },
      })
    })

    it("refuses a repository a person refused for the request, PR or not", async () => {
      const prefix = actionReviewAuthKeyPrefix("deny", "root-1", "epoch-1")
      const keys = { [prefix]: [`${prefix}${outboundFingerprint(REPO)}`] }
      const decision = await planIntegrationWrite(write([PR_12], call), deps(enforce, keys))
      expect(decision).toMatchObject({
        action: "deny",
        receipt: {
          request: { plan: { outcome: "deny", enforced: true } },
          decision: { outcome: "deny", authority: "policy-deny" },
        },
      })
    })
  })

  describe("bot", () => {
    it("proceeds on a person's approval, with a human receipt under enforcement", async () => {
      const bot = { kind: "bot", installation, runId: "run_bot_1", decidedBy: "person" } as const
      await expect(planIntegrationWrite(write([PR_13], bot), deps(enforce))).resolves.toMatchObject(
        {
          action: "proceed",
          outbound: { ownerRef: "bot:boti_1", rootSessionId: "bot:boti_1" },
          authorizedBy: { receiptId: "integration:n1", authority: "human", grantScope: "once" },
          receipt: {
            decision: { outcome: "allow", authority: "human", actor: { kind: "local-user" } },
          },
        }
      )
      await expect(planIntegrationWrite(write([PR_13], bot), deps(shadow))).resolves.toEqual({
        action: "proceed",
        outbound: expect.objectContaining({ ownerRef: "bot:boti_1" }),
        authorizedBy: { authority: "human", grantScope: "once" },
      })
    })

    describe("approved by its policy", () => {
      const bot = { kind: "bot", installation, runId: "run_bot_1", decidedBy: "policy" } as const

      it("replies on the PR the event came from", async () => {
        await expect(planIntegrationWrite(write([PR_12], bot), deps(enforce))).resolves.toEqual({
          action: "proceed",
          outbound: {
            ownerRef: "bot:boti_1",
            rootSessionId: "bot:boti_1",
            instructionEpoch: expect.any(String),
          },
          authorizedBy: { authority: "policy-default" },
        })
      })

      it("parks a write to another PR, unless the installation lists the repository", async () => {
        await expect(
          planIntegrationWrite(write([PR_13], bot), deps(enforce))
        ).resolves.toMatchObject({ action: "park" })
        const listed = {
          ...bot,
          installation: {
            ...installation,
            outboundRecipients: [
              {
                recipient: {
                  kind: "repository" as const,
                  channel: "github",
                  recipient: REPO.recipient,
                },
                addedAt: 1,
                addedBy: "local-user" as const,
              },
            ],
          },
        }
        await expect(
          planIntegrationWrite(write([PR_13], listed), deps(enforce))
        ).resolves.toMatchObject({
          action: "proceed",
          authorizedBy: { grantScope: "policy", policyRef: "bot:boti_1" },
        })
      })

      it("reaches its installation's repository scope, which a person-approved write does not need", async () => {
        const scoped = { ...bot, scopeRepository: "acme/web" }
        await expect(
          planIntegrationWrite(write([PR_13], scoped), deps(enforce))
        ).resolves.toMatchObject({
          action: "proceed",
          authorizedBy: { grantScope: "policy", policyRef: "bot-scope:boti_1" },
        })
        await expect(
          planIntegrationWrite(write([OTHER_REPO], scoped), deps(enforce))
        ).resolves.toMatchObject({ action: "park" })
      })

      it("has no origin thread when its event was about no PR or issue", async () => {
        await expect(
          planIntegrationWrite(
            write([PR_12], bot),
            deps(enforce, {}, { botRunEvent: async () => undefined })
          )
        ).resolves.toMatchObject({ action: "park" })
      })
    })
  })

  describe("workflow", () => {
    it("plans in the run's own origin", async () => {
      const decision = await planIntegrationWrite(
        write([PR_13], { kind: "workflow", workflowId: "wf_1", runId: "wr_1" }),
        deps(enforce)
      )
      expect(decision).toMatchObject({
        action: "park",
        outbound: {
          ownerRef: "workflow:wf_1",
          rootSessionId: "workflow-run:wr_1",
          instructionEpoch: "workflow-run:wr_1",
        },
      })
    })
  })

  describe("job", () => {
    const job = (covers: (typeof PR_12)[]) =>
      ({
        kind: "job",
        jobId: "job_1",
        outbound: { ownerRef: "plugin:p1", rootSessionId: "root-9", instructionEpoch: "e9" },
        covers,
      }) as const

    it("covers a request to the repository the job was planned for", async () => {
      // The Issue Loop, planned for issue 7, opens its pull request.
      await expect(
        planIntegrationWrite(write([REPO], job([repositoryTarget("acme/web", 7)!])), deps(enforce))
      ).resolves.toEqual({
        action: "proceed",
        outbound: { ownerRef: "plugin:p1", rootSessionId: "root-9", instructionEpoch: "e9" },
      })
    })

    it("plans a request elsewhere in the job's origin, with its issue as the origin thread", async () => {
      await expect(
        planIntegrationWrite(write([OTHER_REPO], job([PR_12])), deps(enforce))
      ).resolves.toMatchObject({
        action: "park",
        outbound: { ownerRef: "plugin:p1", rootSessionId: "root-9" },
      })
      // A job that was planned for nothing covers nothing.
      await expect(
        planIntegrationWrite(write([PR_12], job([])), deps(enforce))
      ).resolves.toMatchObject({ action: "park" })
    })

    it("never covers an unknown target", async () => {
      await expect(
        planIntegrationWrite(write([unknownGithubTarget()], job([REPO])), deps(enforce))
      ).resolves.toMatchObject({ action: "park" })
    })
  })

  describe("lists a person wrote for the account", () => {
    const account = { pluginId: "github-delivery", accountId: "acct_1" }
    const action = {
      actionId: "commentPr",
      operationId: "github.commentPr",
      risk: "write",
    } as const
    const accountList = async () => [
      { policyRef: "integration-account:acct_1", fingerprints: [outboundFingerprint(REPO)] },
    ]

    it("grants an unattended write, asking with the account, the action and the run", async () => {
      const githubGrants = jest.fn(accountList)
      const decision = await planIntegrationWrite(
        {
          ...write([PR_13], { kind: "workflow", workflowId: "wf_1", runId: "wr_1" }),
          host: "github.com",
          account,
          action,
        },
        deps(enforce, {}, { githubGrants })
      )
      expect(decision).toMatchObject({
        action: "proceed",
        authorizedBy: { grantScope: "policy", policyRef: "integration-account:acct_1" },
      })
      expect(githubGrants).toHaveBeenCalledWith({
        account,
        operation: { ...action, workflowId: "wf_1" },
        host: "github.com",
      })
    })

    it("names the account on the receipt, so the shadow report can offer its list", async () => {
      const decision = await planIntegrationWrite(
        {
          ...write([OTHER_REPO], { kind: "workflow", workflowId: "wf_1", runId: "wr_1" }),
          account,
        },
        deps(shadow, {}, { githubGrants: async () => [] })
      )
      expect(decision.receipt?.request.subject.input).toEqual({ integrationAccount: account })
      // Without an account the receipt names none.
      const bare = await planIntegrationWrite(
        write([OTHER_REPO], { kind: "workflow", workflowId: "wf_1", runId: "wr_1" }),
        deps(shadow, {}, { githubGrants: async () => [] })
      )
      expect(bare.receipt?.request.subject.input).toBeUndefined()
    })

    it("passes a tool call's session, and no operation for a raw request", async () => {
      const githubGrants = jest.fn(async () => [])
      await planIntegrationWrite(
        { ...write([OTHER_REPO], { kind: "tool-call", pluginId: "p", sessionId: "s1" }), account },
        deps(enforce, {}, { githubGrants })
      )
      expect(githubGrants).toHaveBeenLastCalledWith({ account })
      await planIntegrationWrite(
        {
          ...write([OTHER_REPO], { kind: "tool-call", pluginId: "p", sessionId: "s1" }),
          account,
          action,
        },
        deps(enforce, {}, { githubGrants })
      )
      expect(githubGrants).toHaveBeenLastCalledWith({
        account,
        operation: { ...action, sessionId: "s1" },
      })
    })

    it("reads no list without an account", async () => {
      const githubGrants = jest.fn(accountList)
      await expect(
        planIntegrationWrite(write([PR_13], { kind: "plugin", pluginId: "p" }), {
          ...deps(enforce),
          githubGrants,
        })
      ).resolves.toMatchObject({ action: "park" })
      expect(githubGrants).not.toHaveBeenCalled()
    })
  })

  describe("team-delivery", () => {
    const team = (
      extra: Partial<Extract<IntegrationAuthorization, { kind: "team-delivery" }>> = {}
    ) =>
      ({
        kind: "team-delivery",
        teamId: "team_1",
        runId: "run_1",
        decidedBy: "run",
        ...extra,
      }) as const

    it("parks an unconsented publish in the team run's own request, reading every account's list", async () => {
      const githubGrants = jest.fn(async () => [])
      const decision = await planIntegrationWrite(
        { ...write([REPO], team()), host: "github.com" },
        deps(enforce, {}, { githubGrants })
      )
      expect(decision).toMatchObject({
        action: "park",
        outbound: {
          ownerRef: "agent-team:team_1",
          rootSessionId: "agent-team-run:run_1",
          instructionEpoch: "agent-team-run:run_1",
        },
      })
      expect(githubGrants).toHaveBeenCalledWith({ host: "github.com" })
    })

    it("publishes to the team's consented repositories, in the creating session's request", async () => {
      const decision = await planIntegrationWrite(
        write(
          [REPO],
          team({
            sessionId: "chat-1",
            policyGrants: [
              { policyRef: "team-delivery:team_1", fingerprints: [outboundFingerprint(REPO)] },
            ],
          })
        ),
        deps(enforce, {}, { githubGrants: async () => [] })
      )
      expect(decision).toMatchObject({
        action: "proceed",
        outbound: { rootSessionId: "root-1", instructionEpoch: "epoch-1" },
        authorizedBy: { grantScope: "policy", policyRef: "team-delivery:team_1" },
      })
      // The chat's PR is not where the publish goes, so it is no origin thread.
      expect(
        await planIntegrationWrite(
          write([PR_12], team({ sessionId: "chat-1" })),
          deps(enforce, {}, { githubGrants: async () => [] })
        )
      ).toMatchObject({ action: "park" })
    })

    it("records a person's approval as theirs, for the publish or the request", async () => {
      await expect(
        planIntegrationWrite(write([REPO], team({ decidedBy: "person" })), deps(enforce))
      ).resolves.toMatchObject({
        action: "proceed",
        authorizedBy: { authority: "human", grantScope: "once" },
        receipt: { decision: { outcome: "allow", authority: "human" } },
      })
      await expect(
        planIntegrationWrite(
          write([REPO], team({ decidedBy: "person", forRequest: true })),
          deps(enforce)
        )
      ).resolves.toMatchObject({ authorizedBy: { grantScope: "instruction" } })
    })

    it("refuses a repository a person refused for the request", async () => {
      const prefix = actionReviewAuthKeyPrefix(
        "deny",
        "agent-team-run:run_1",
        "agent-team-run:run_1"
      )
      const decision = await planIntegrationWrite(
        write([REPO], team()),
        deps(
          enforce,
          { [prefix]: [`${prefix}${outboundFingerprint(REPO)}`] },
          { githubGrants: async () => [] }
        )
      )
      expect(decision.action).toBe("deny")
    })
  })

  describe("person", () => {
    it("lets a person's own write through under enforcement, recorded as theirs", async () => {
      const githubGrants = jest.fn(async () => [])
      const decision = await planIntegrationWrite(
        write([REPO], { kind: "person", surface: "stack-panel" }),
        deps(enforce, {}, { githubGrants })
      )
      expect(decision).toMatchObject({
        action: "proceed",
        outbound: { ownerRef: "person:stack-panel" },
        authorizedBy: { authority: "human", grantScope: "once" },
      })
      expect(decision.receipt?.decision).toMatchObject({
        outcome: "allow",
        authority: "human",
        actor: { kind: "local-user" },
      })
      // No list is consulted: the click is the authorization.
      expect(githubGrants).not.toHaveBeenCalled()
    })

    it("files the receipt under the session the click belongs to", async () => {
      const decision = await planIntegrationWrite(
        write([REPO], { kind: "person", surface: "thread-pr", sessionId: "chat-1" }),
        deps(enforce)
      )
      expect(decision).toMatchObject({
        action: "proceed",
        outbound: { rootSessionId: "root-1", instructionEpoch: "epoch-1" },
      })
      expect(decision.receipt?.request.origin).toMatchObject({ sessionId: "chat-1" })
    })
  })

  describe("modes", () => {
    const plugin = { kind: "plugin", pluginId: "p1" } as const

    it("only records in shadow mode what enforcement would have held", async () => {
      const decision = await planIntegrationWrite(write([PR_13], plugin), deps(shadow))
      expect(decision).toMatchObject({
        action: "proceed",
        outbound: { ownerRef: "plugin:p1" },
        receipt: {
          request: { plan: { outcome: "park", enforced: false } },
          decision: { outcome: "allow", authority: "policy-default" },
        },
      })
      if (decision.action !== "proceed") throw new Error("expected proceed")
      expect(decision.receipt?.decision.reason).toMatch(/shadow mode.*held it for a person/)
    })

    it("records a fence in shadow mode without refusing", async () => {
      const prefix = actionReviewAuthKeyPrefix("deny", "root-1", "epoch-1")
      const keys = { [prefix]: [`${prefix}${outboundFingerprint(REPO)}`] }
      const decision = await planIntegrationWrite(
        write([PR_13], { kind: "tool-call", pluginId: "p1", sessionId: "s1" }),
        deps(shadow, keys)
      )
      // In shadow mode the host has no record of the call, so nothing is planned.
      expect(decision).toEqual({ action: "proceed", outbound: { ownerRef: "tool-call:s1" } })
      const workflow = await planIntegrationWrite(
        write([PR_13], { kind: "workflow", workflowId: "wf", runId: "wr" }),
        deps(shadow, {
          [actionReviewAuthKeyPrefix("deny", "workflow-run:wr", "workflow-run:wr")]: [
            `${actionReviewAuthKeyPrefix("deny", "workflow-run:wr", "workflow-run:wr")}${outboundFingerprint(REPO)}`,
          ],
        })
      )
      expect(workflow).toMatchObject({
        action: "proceed",
        receipt: { request: { plan: { outcome: "deny", enforced: false } } },
      })
    })

    it("is not enforced by enforcing messaging", async () => {
      await expect(
        planIntegrationWrite(write([PR_13], plugin), deps(messagingOnly))
      ).resolves.toMatchObject({ action: "proceed" })
    })

    it("holds under enforcement when planning fails, and changes nothing in shadow mode", async () => {
      const flow = { kind: "workflow", workflowId: "wf", runId: "wr" } as const
      const failing = { listAuthKeys: async () => Promise.reject(new Error("db down")) }
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
      await expect(
        planIntegrationWrite(write([PR_13], flow), deps(enforce, {}, failing))
      ).resolves.toMatchObject({ action: "park" })
      await expect(
        planIntegrationWrite(write([PR_13], flow), deps(shadow, {}, failing))
      ).resolves.toEqual({
        action: "proceed",
        outbound: expect.objectContaining({ ownerRef: "workflow:wf" }),
      })
      warn.mockRestore()
    })
  })
})

describe("heldJobAnswerReceipt", () => {
  const outbound = { ownerRef: "bot:boti_1", rootSessionId: "bot:boti_1", instructionEpoch: "e1" }

  it("records a person's approval for one write, or for the request", () => {
    const once = heldJobAnswerReceipt({
      outbound,
      targets: [PR_13],
      operation: "github.commentPr",
      answer: "approved",
      now: 7,
    })
    expect(once.decision).toMatchObject({
      outcome: "allow",
      authority: "human",
      grant: { scope: "once" },
      actor: { kind: "local-user" },
      decidedAt: 7,
    })
    expect(once.request.origin).toMatchObject({
      rootSessionId: "bot:boti_1",
      instructionEpoch: "e1",
    })
    const forRequest = heldJobAnswerReceipt({
      outbound,
      targets: [PR_13],
      operation: "github.commentPr",
      answer: "approved",
      forRequest: true,
    })
    expect(forRequest.decision.grant).toEqual({ scope: "instruction" })
    // A write whose repository could not be named is only ever allowed once.
    expect(
      heldJobAnswerReceipt({
        outbound,
        targets: [unknownGithubTarget()],
        operation: "POST",
        answer: "approved",
        forRequest: true,
      }).decision.grant
    ).toEqual({ scope: "once" })
  })

  it("records a person's refusal, which fences", () => {
    const denied = heldJobAnswerReceipt({
      outbound,
      targets: [PR_13],
      operation: "github.commentPr",
      answer: "denied",
    })
    expect(denied.decision).toMatchObject({ outcome: "deny", authority: "human" })
    expect(denied.decision.grant).toBeUndefined()
    expect(isActionReviewDecision(denied.decision)).toBe(true)
  })
})
