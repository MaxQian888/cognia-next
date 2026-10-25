import {
  isActionReviewDecision,
  isActionReviewRequest,
} from "@cognia/agent-config-types/action-review"

import { actionReviewAuthKeyPrefix } from "@/lib/db/action-review-receipts"

import { __resetRunningBotGrantsForTesting, beginBotOutboundRun } from "./configured-grants"
import { outboundFingerprint, siteTarget, unknownSiteTarget } from "./outbound-targets"
import {
  BROWSER_SUBMISSION_REFUSED_ERROR,
  browserAskerRef,
  browserSubmissionAnswerReceipt,
  planBrowserSubmission,
  submissionSiteTarget,
  type BrowserSubmissionAsker,
  type BrowserSubmissionPlanInput,
  type PlanBrowserDeps,
} from "./plan-browser"

const FORMS = siteTarget("https://forms.example.com")!
const grant = (target: { kind: string; channel: string; recipient: string }) => ({
  recipient: target,
  addedAt: 1,
  addedBy: "local-user",
})

const enforce = (extra: Record<string, unknown> = {}) => ({
  agentPermissions: { outboundAuthorizationByCategory: { browser: "enforce" }, ...extra },
})
const shadow = { agentPermissions: {} }

function deps(
  settings: object,
  keys: Record<string, string[]> = {},
  extra: Partial<PlanBrowserDeps> = {}
): PlanBrowserDeps {
  let seq = 0
  return {
    settings: () => settings,
    listAuthKeys: async (prefix) => keys[prefix] ?? [],
    resolveSessionOrigin: async () => ({ rootSessionId: "root-1", instructionEpoch: "epoch-1" }),
    workflowRunTrigger: async () => undefined,
    now: () => 5_000,
    newRequestId: () => `n${++seq}`,
    ...extra,
  }
}

const chat: BrowserSubmissionAsker = { kind: "chat", sessionId: "s1" }
const submit = (
  asker: BrowserSubmissionAsker,
  url = "https://forms.example.com/submit",
  basis: BrowserSubmissionPlanInput["basis"] = "request"
): BrowserSubmissionPlanInput => ({ url, basis, operation: "POST", asker })

/** The query a fence or grant lookup makes, answered with `FORMS`'s key. */
function keyed(kind: "deny" | "grant"): Record<string, string[]> {
  const prefix = actionReviewAuthKeyPrefix(kind, "root-1", "epoch-1")
  return { [prefix]: [`${prefix}${outboundFingerprint(FORMS)}`] }
}

beforeEach(() => __resetRunningBotGrantsForTesting())

describe("submissionSiteTarget", () => {
  it("is the request's origin, a WebSocket counting as its http(s) site", () => {
    expect(submissionSiteTarget("https://Forms.Example.com:443/submit?q=1")).toEqual(FORMS)
    expect(submissionSiteTarget("wss://forms.example.com/socket")).toEqual(FORMS)
    expect(submissionSiteTarget("ws://127.0.0.1:4811/ws")).toEqual(
      siteTarget("http://127.0.0.1:4811")
    )
  })

  it("names no site for a page without one", () => {
    expect(submissionSiteTarget("data:text/html,x")).toEqual(unknownSiteTarget())
    expect(submissionSiteTarget("chrome-extension://abc/page.html")).toEqual(unknownSiteTarget())
    expect(submissionSiteTarget("not a url")).toEqual(unknownSiteTarget())
  })
})

describe("browserAskerRef", () => {
  it("names who drove the action", () => {
    expect(browserAskerRef(chat)).toBe("browser:s1")
    expect(browserAskerRef({ kind: "turn", sessionId: "s2", unattended: true })).toBe("browser:s2")
    expect(browserAskerRef({ kind: "workflow", workflowId: "w1", runId: "r1" })).toBe("workflow:w1")
    expect(browserAskerRef({ kind: "external-bridge", clientId: "claude" })).toBe(
      "external-bridge:claude"
    )
    expect(browserAskerRef({ kind: "plugin", pluginId: "acme" })).toBe("plugin:acme")
  })
})

describe("planBrowserSubmission — shadow mode", () => {
  it("lets every submission through and records what enforcement would have changed", async () => {
    const decision = await planBrowserSubmission(submit(chat), deps(shadow))
    expect(decision.action).toBe("proceed")
    if (decision.action !== "proceed") return
    expect(decision.receipt?.request.plan).toEqual({ outcome: "ask", enforced: false })
    expect(decision.receipt?.decision.outcome).toBe("allow")
    expect(decision.receipt?.decision.reason).toMatch(/shadow mode; enforcement would have asked/)
  })

  it("records nothing for a submission a list allows", async () => {
    const settings = { agentPermissions: { outboundSites: [grant(FORMS)] } }
    expect(await planBrowserSubmission(submit(chat), deps(settings))).toEqual({
      action: "proceed",
    })
  })

  it("enforcing messaging or GitHub never enforces the browser", async () => {
    const settings = {
      agentPermissions: {
        outboundAuthorization: "enforce",
        outboundAuthorizationByCategory: { github: "enforce" },
      },
    }
    const decision = await planBrowserSubmission(submit(chat), deps(settings))
    expect(decision.action).toBe("proceed")
  })

  it("a fenced site is still sent, recorded as what enforcement would have refused", async () => {
    const decision = await planBrowserSubmission(submit(chat), deps(shadow, keyed("deny")))
    expect(decision.action).toBe("proceed")
    if (decision.action !== "proceed") return
    expect(decision.receipt?.request.plan).toEqual({ outcome: "deny", enforced: false })
  })
})

describe("planBrowserSubmission — enforce", () => {
  it("asks the person at this computer about an unlisted site in a chat", async () => {
    const decision = await planBrowserSubmission(submit(chat), deps(enforce()))
    expect(decision).toMatchObject({
      action: "ask",
      ask: {
        unattended: false,
        target: FORMS,
        forRequestOffered: true,
        basis: "request",
        operation: "POST",
        ownerRef: "browser:s1",
        sessionId: "s1",
        origin: { rootSessionId: "root-1", instructionEpoch: "epoch-1" },
        review: {
          targets: [{ kind: "site", channel: "browser", recipient: FORMS.recipient }],
          unauthorized: [{ kind: "site", channel: "browser", recipient: FORMS.recipient }],
          enforced: true,
        },
      },
    })
  })

  it("allows a site on the global list, with a policy receipt", async () => {
    const decision = await planBrowserSubmission(
      submit(chat, "wss://forms.example.com/live"),
      deps(enforce({ outboundSites: [grant(FORMS)] }))
    )
    expect(decision.action).toBe("proceed")
    if (decision.action !== "proceed") return
    expect(decision.receipt?.decision).toMatchObject({
      outcome: "allow",
      authority: "policy-rule",
      grant: { scope: "policy", policyRef: "browser-sites" },
    })
    expect(decision.receipt?.request.subject).toEqual({
      kind: "browser-submission",
      ref: "browser:s1",
      title: "POST",
      targets: [{ channel: "browser", fingerprint: outboundFingerprint(FORMS) }],
    })
    expect(isActionReviewRequest(decision.receipt!.request)).toBe(true)
    expect(isActionReviewDecision(decision.receipt!.decision)).toBe(true)
  })

  it("allows a site a person allowed for this request", async () => {
    const decision = await planBrowserSubmission(submit(chat), deps(enforce(), keyed("grant")))
    expect(decision.action).toBe("proceed")
    if (decision.action !== "proceed") return
    expect(decision.receipt?.decision).toMatchObject({
      authority: "human",
      grant: { scope: "instruction" },
    })
  })

  it("refuses a site a person refused earlier in this request", async () => {
    const decision = await planBrowserSubmission(
      submit(chat),
      deps(enforce({ outboundSites: [grant(FORMS)] }), keyed("deny"))
    )
    expect(decision.action).toBe("refuse")
    if (decision.action !== "refuse") return
    expect(decision.receipt.decision).toMatchObject({ outcome: "deny", authority: "policy-deny" })
    expect(BROWSER_SUBMISSION_REFUSED_ERROR).toMatch(/^outbound_refused:/)
  })

  it("plans a turn in its own origin, unattended, with its lists", async () => {
    const bot = { policyRef: "bot:b1", fingerprints: [outboundFingerprint(FORMS)] }
    const allowed = await planBrowserSubmission(
      submit({
        kind: "turn",
        sessionId: "s2",
        unattended: true,
        origin: async () => ({ rootSessionId: "task:t1", instructionEpoch: "task-epoch" }),
        policyGrants: [bot],
      }),
      deps(enforce())
    )
    expect(allowed).toMatchObject({
      action: "proceed",
      receipt: { decision: { grant: { scope: "policy", policyRef: "bot:b1" } } },
    })
    const asked = await planBrowserSubmission(
      submit({ kind: "turn", sessionId: "s2", unattended: true }, "https://other.example/x"),
      deps(enforce())
    )
    expect(asked).toMatchObject({
      action: "ask",
      ask: { unattended: true, origin: { rootSessionId: "root-1" } },
    })
  })

  it("plans a workflow run in the run's origin, unattended", async () => {
    const decision = await planBrowserSubmission(
      submit({ kind: "workflow", workflowId: "w1", runId: "r1" }),
      deps(enforce())
    )
    expect(decision).toMatchObject({
      action: "ask",
      ask: {
        unattended: true,
        ownerRef: "workflow:w1",
        origin: { rootSessionId: "workflow-run:r1", instructionEpoch: "workflow-run:r1" },
        forRequestOffered: true,
      },
    })
  })

  it("asks about a bridge client's submission once, with no request to scope it to", async () => {
    const decision = await planBrowserSubmission(
      submit({ kind: "external-bridge", clientId: "claude" }),
      deps(enforce())
    )
    expect(decision).toMatchObject({
      action: "ask",
      ask: { unattended: false, forRequestOffered: false, origin: {} },
    })
  })

  it("lets a plugin reach the sites of its running handler Bot", async () => {
    const end = beginBotOutboundRun("run-1", {
      pluginId: "acme",
      installation: { id: "b1", outboundRecipients: [grant(FORMS)] as never },
    })
    const allowed = await planBrowserSubmission(
      submit({ kind: "plugin", pluginId: "acme" }),
      deps(enforce())
    )
    expect(allowed.action).toBe("proceed")
    end()
    const asked = await planBrowserSubmission(
      submit({ kind: "plugin", pluginId: "acme" }),
      deps(enforce())
    )
    expect(asked).toMatchObject({ action: "ask", ask: { unattended: true } })
  })

  it("asks per call about a page with no site", async () => {
    const decision = await planBrowserSubmission(
      submit(chat, "data:text/html,x", "possible"),
      deps(enforce({ outboundSites: [grant(FORMS)] }))
    )
    expect(decision).toMatchObject({
      action: "ask",
      ask: { target: unknownSiteTarget(), forRequestOffered: false, basis: "possible" },
    })
  })

  it("asks when planning fails, rather than sending on a failure", async () => {
    const decision = await planBrowserSubmission(
      submit(chat),
      deps(
        enforce(),
        {},
        {
          resolveSessionOrigin: async () => {
            throw new Error("db closed")
          },
        }
      )
    )
    expect(decision).toMatchObject({ action: "ask", ask: { unattended: false, origin: {} } })
    const shadowed = await planBrowserSubmission(
      submit(chat),
      deps(
        shadow,
        {},
        {
          resolveSessionOrigin: async () => {
            throw new Error("db closed")
          },
        }
      )
    )
    expect(shadowed).toEqual({ action: "proceed" })
  })
})

describe("browserSubmissionAnswerReceipt", () => {
  async function ask(asker: BrowserSubmissionAsker = chat) {
    const decision = await planBrowserSubmission(submit(asker), deps(enforce()))
    if (decision.action !== "ask") throw new Error("expected an ask")
    return decision.ask
  }

  it("records an allow for this request as an instruction grant on the request", async () => {
    const receipt = browserSubmissionAnswerReceipt(
      await ask(),
      { kind: "allowed", forRequest: true },
      9
    )
    expect(receipt.request.origin).toMatchObject({
      channel: "browser-submission",
      rootSessionId: "root-1",
      instructionEpoch: "epoch-1",
    })
    expect(receipt.request.plan).toEqual({ outcome: "ask", enforced: true })
    expect(receipt.decision).toMatchObject({
      outcome: "allow",
      authority: "human",
      grant: { scope: "instruction" },
      actor: { kind: "local-user" },
      decidedAt: 9,
    })
  })

  it("an allow for this request with no request to scope it to is once", async () => {
    const receipt = browserSubmissionAnswerReceipt(
      await ask({ kind: "external-bridge", clientId: "claude" }),
      { kind: "allowed", forRequest: true }
    )
    expect(receipt.decision.grant).toEqual({ scope: "once" })
  })

  it("records a person's refusal as a human deny, which fences the site", async () => {
    const receipt = browserSubmissionAnswerReceipt(await ask(), {
      kind: "refused",
      actor: "device",
    })
    expect(receipt.decision).toMatchObject({
      outcome: "deny",
      authority: "human",
      actor: { kind: "device" },
    })
  })

  it("a parked question's answers are recorded as parked", async () => {
    const receipt = browserSubmissionAnswerReceipt(
      await ask({ kind: "workflow", workflowId: "w1", runId: "r1" }),
      { kind: "allowed" }
    )
    expect(receipt.request.plan).toEqual({ outcome: "park", enforced: true })
    expect(receipt.request.origin.headless).toBe(true)
    expect(receipt.decision.grant).toEqual({ scope: "once" })
  })

  it("nobody answering or nobody to ask refuses without a person's authority", async () => {
    const expired = browserSubmissionAnswerReceipt(await ask(), { kind: "expired" })
    expect(expired.decision).toMatchObject({ outcome: "expired", authority: "timeout" })
    const unavailable = browserSubmissionAnswerReceipt(await ask(), {
      kind: "unavailable",
      reason: "the run ended",
    })
    expect(unavailable.decision).toMatchObject({ outcome: "deny", authority: "system" })
    expect(unavailable.decision.reason).toContain("the run ended")
  })
})
