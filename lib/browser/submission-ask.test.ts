import {
  BROWSER_SUBMITTING_TOOL_TIMEOUT_MS,
  BROWSER_TOOL_DEFINITIONS,
} from "@cognia/plugin-sdk/api/browser"
import { MAX_TOOL_TIMEOUT_MS } from "@cognia/plugin-contract/lib/plugin/resilience/config"
import type { UnattendedParkDeps } from "@/lib/claude/unattended-park"
import { siteTarget, unknownSiteTarget } from "@/lib/policy/action-review/outbound-targets"
import type { BrowserSubmissionAsk } from "@/lib/policy/action-review/plan-browser"

import {
  BROWSER_SUBMISSION_ASK_MAX_MS,
  BROWSER_SUBMISSION_DIALOG_TTL_MS,
  BROWSER_SUBMISSION_TOOL_NAME,
  answerOfDecision,
  askAboutBrowserSubmission,
  askSite,
  browserSubmissionRequest,
} from "./submission-ask"

jest.mock("@/lib/execution/run-approval-outbound", () => ({
  rememberRunApprovalOutbound: jest.fn(),
  forgetRunApprovalOutbound: jest.fn(),
}))

const FORMS = siteTarget("https://forms.example.com")!
const view = { kind: "site" as const, channel: "browser", recipient: FORMS.recipient }

function ask(overrides: Partial<BrowserSubmissionAsk> = {}): BrowserSubmissionAsk {
  return {
    unattended: false,
    target: FORMS,
    review: { targets: [view], unauthorized: [view], enforced: true },
    forRequestOffered: true,
    basis: "request",
    operation: "POST",
    ownerRef: "browser:s1",
    sessionId: "s1",
    origin: { rootSessionId: "root-1", instructionEpoch: "epoch-1" },
    ...overrides,
  }
}

const context = { approvalOrigin: "plugin" as const, label: "Browser: forms.example.com" }

/** A park whose person answers with `decision`, or never (`null`: it expires). */
function parkDeps(decision: { decision: "allow" | "deny"; forRequest?: boolean } | null) {
  const calls: { awaited?: { sessionId: string; requestId: string; ttlMs: number } } = {}
  const deps: UnattendedParkDeps = {
    openRun: jest.fn(async () => undefined),
    finishRun: jest.fn(async () => undefined),
    createInterrupt: jest.fn(async () => undefined),
    expireInterrupt: jest.fn(async () => undefined),
    announce: jest.fn(async () => undefined),
    announceResolved: jest.fn(async () => undefined),
    awaitDecision: jest.fn(async (sessionId, requestId, options) => {
      calls.awaited = { sessionId, requestId, ttlMs: options.ttlMs }
      if (decision) return decision
      options.onExpire()
      return { decision: "deny" as const }
    }),
    newId: () => "run",
  }
  return { deps, calls }
}

const noDialog = () => null

describe("the question", () => {
  it("names the site, asks a person per call, and carries the recipients", () => {
    expect(askSite(ask())).toBe("https://forms.example.com")
    expect(askSite(ask({ target: unknownSiteTarget() }))).toBeNull()
    expect(browserSubmissionRequest(ask(), "s1", "q1")).toEqual({
      type: "permission_request",
      sessionId: "s1",
      requestId: "q1",
      toolUseID: "q1",
      toolName: BROWSER_SUBMISSION_TOOL_NAME,
      input: { site: "https://forms.example.com", basis: "request", operation: "POST" },
      title: "Send to https://forms.example.com",
      permissionClass: "outbound",
      outbound: ask().review,
      suppressAlwaysAllowRule: true,
      requiresPerCallApproval: true,
      defaultToNo: true,
    })
  })

  it("stays inside the action tool's budget and the runtime's hold", () => {
    expect(BROWSER_SUBMISSION_DIALOG_TTL_MS).toBeLessThan(BROWSER_SUBMISSION_ASK_MAX_MS)
    // The tools declare the most a plugin tool may, and an ask ends a minute before it.
    expect(BROWSER_SUBMITTING_TOOL_TIMEOUT_MS).toBe(MAX_TOOL_TIMEOUT_MS)
    expect(BROWSER_SUBMISSION_ASK_MAX_MS + 60_000).toBeLessThanOrEqual(
      BROWSER_SUBMITTING_TOOL_TIMEOUT_MS
    )
    expect(BROWSER_SUBMISSION_ASK_MAX_MS).toBeLessThan(30 * 60_000)
    for (const name of [
      "browser_click",
      "browser_double_click",
      "browser_type",
      "browser_fill_form",
      "browser_select",
      "browser_hover",
      "browser_focus",
      "browser_press_key",
      "browser_drag",
      "browser_evaluate",
      "browser_back",
      "browser_forward",
      "browser_reload",
      "browser_handle_dialog",
    ] as const) {
      expect(BROWSER_TOOL_DEFINITIONS[name].timeoutMs).toBe(BROWSER_SUBMITTING_TOOL_TIMEOUT_MS)
    }
  })
})

describe("answerOfDecision", () => {
  it("reads a responder's decision as a person's answer only when a person gave it", () => {
    expect(answerOfDecision({ decision: "allow", forRequest: true })).toEqual({
      kind: "allowed",
      forRequest: true,
    })
    expect(
      answerOfDecision({
        decision: "allow",
        attribution: { authority: "human", actor: { kind: "connector-user" } },
      })
    ).toEqual({ kind: "allowed", actor: "connector-user" })
    expect(answerOfDecision({ decision: "deny" })).toEqual({ kind: "refused" })
    expect(
      answerOfDecision({
        decision: "deny",
        attribution: { authority: "human", actor: { kind: "device" } },
      })
    ).toEqual({ kind: "refused", actor: "device" })
    expect(answerOfDecision({ decision: "deny", attribution: { authority: "timeout" } })).toEqual({
      kind: "expired",
    })
    expect(
      answerOfDecision({
        decision: "deny",
        message: "session closed",
        attribution: { authority: "system" },
      })
    ).toEqual({ kind: "unavailable", reason: "session closed" })
  })
})

describe("askAboutBrowserSubmission", () => {
  it("asks a captured turn's own person, holding its wall clock", async () => {
    const resume = jest.fn()
    const respond = jest.fn(async () => ({ decision: "allow" as const, forRequest: true }))
    const requestOutboundAsk = jest.fn()
    const answer = await askAboutBrowserSubmission(ask({ unattended: true }), context, {
      capturedTurnOf: () => ({
        turnId: "t1",
        outboundPolicy: { unattended: true },
        respond,
        holdWallClock: () => resume,
      }),
      requestOutboundAsk,
      newId: () => "n1",
    })
    expect(answer).toEqual({ kind: "allowed", forRequest: true })
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s1",
        requestId: "browser-submission:n1",
        toolName: BROWSER_SUBMISSION_TOOL_NAME,
      })
    )
    expect(resume).toHaveBeenCalledTimes(1)
    expect(requestOutboundAsk).not.toHaveBeenCalled()
  })

  it("a turn's responder that throws refuses without a person's authority", async () => {
    const answer = await askAboutBrowserSubmission(ask(), context, {
      capturedTurnOf: () => ({
        turnId: "t1",
        outboundPolicy: { unattended: false },
        respond: async () => {
          throw new Error("card failed")
        },
      }),
    })
    expect(answer).toEqual({ kind: "unavailable", reason: "card failed" })
  })

  it("a turn's person who never answers expires at the ask's limit", async () => {
    jest.useFakeTimers()
    try {
      const asked = askAboutBrowserSubmission(ask(), context, {
        capturedTurnOf: () => ({
          turnId: "t1",
          outboundPolicy: { unattended: false },
          respond: () => new Promise(() => undefined),
        }),
      })
      await Promise.resolve()
      jest.advanceTimersByTime(BROWSER_SUBMISSION_ASK_MAX_MS)
      await expect(asked).resolves.toEqual({ kind: "expired" })
    } finally {
      jest.useRealTimers()
    }
  })

  it.each([
    ["once", { kind: "allowed" }],
    ["request", { kind: "allowed", forRequest: true }],
    ["refuse", { kind: "refused" }],
    ["expired", { kind: "expired" }],
    ["withdrawn", { kind: "unavailable", reason: "the action was cancelled" }],
  ] as const)("asks a desktop chat's person on the dialog: %s", async (result, expected) => {
    const requestOutboundAsk = jest.fn(() => Promise.resolve(result))
    const answer = await askAboutBrowserSubmission(ask(), context, {
      capturedTurnOf: () => undefined,
      requestOutboundAsk,
    })
    expect(answer).toEqual(expected)
    expect(requestOutboundAsk).toHaveBeenCalledWith(
      {
        site: "https://forms.example.com",
        basis: "request",
        operation: "POST",
        asker: "chat",
        forRequestOffered: true,
      },
      { ttlMs: BROWSER_SUBMISSION_DIALOG_TTL_MS }
    )
  })

  it("names a bridge client on the dialog", async () => {
    const requestOutboundAsk = jest.fn(() => Promise.resolve("once" as const))
    await askAboutBrowserSubmission(
      ask({ ownerRef: "external-bridge:claude", forRequestOffered: false }),
      context,
      { capturedTurnOf: () => undefined, requestOutboundAsk }
    )
    expect(requestOutboundAsk).toHaveBeenCalledWith(
      expect.objectContaining({ asker: "external-bridge", forRequestOffered: false }),
      expect.anything()
    )
  })

  it("parks an attended question when no dialog can show it, and an unattended one always", async () => {
    for (const unattended of [false, true]) {
      const { deps, calls } = parkDeps({ decision: "allow" })
      const answer = await askAboutBrowserSubmission(ask({ unattended }), context, {
        capturedTurnOf: () => undefined,
        requestOutboundAsk: noDialog,
        park: { deps },
        newId: () => "n1",
      })
      expect(answer).toEqual({ kind: "allowed" })
      expect(calls.awaited).toEqual({
        sessionId: "s1",
        requestId: "browser-submission:n1",
        ttlMs: BROWSER_SUBMISSION_ASK_MAX_MS,
      })
      expect(deps.announce).toHaveBeenCalledWith(
        expect.objectContaining({ type: "tool_approval" }),
        { origin: "plugin", permissionClass: "outbound" }
      )
      expect(deps.finishRun).toHaveBeenCalledWith("unattended:s1:run", "completed", undefined)
    }
  })

  it("files a sessionless question under its asker", async () => {
    const { deps, calls } = parkDeps({ decision: "deny" })
    const answer = await askAboutBrowserSubmission(
      ask({ unattended: true, sessionId: undefined, ownerRef: "workflow:w1" }),
      context,
      { requestOutboundAsk: noDialog, park: { deps } }
    )
    expect(answer).toEqual({ kind: "refused", actor: "device" })
    expect(calls.awaited?.sessionId).toBe("browser-submission:workflow:w1")
  })

  it("a parked question nobody answers expires", async () => {
    const { deps } = parkDeps(null)
    const answer = await askAboutBrowserSubmission(ask({ unattended: true }), context, {
      capturedTurnOf: () => undefined,
      park: { deps },
    })
    expect(answer).toEqual({ kind: "expired" })
    expect(deps.finishRun).toHaveBeenCalledWith("unattended:s1:run", "cancelled", undefined)
  })

  it("asks nobody for an action already cancelled", async () => {
    const controller = new AbortController()
    controller.abort()
    const requestOutboundAsk = jest.fn()
    const answer = await askAboutBrowserSubmission(
      ask(),
      { ...context, signal: controller.signal },
      { requestOutboundAsk }
    )
    expect(answer).toEqual({ kind: "unavailable", reason: "the action was cancelled" })
    expect(requestOutboundAsk).not.toHaveBeenCalled()
  })
})
