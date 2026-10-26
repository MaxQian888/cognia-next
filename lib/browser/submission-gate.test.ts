import type { BrowserEngine } from "@/lib/browser/agent-engine"
import {
  isSubmissionGuardedEngine,
  type BrowserSubmissionGuardMode,
  type BrowserSubmissionReport,
} from "@/lib/browser/protocol"
import { siteTarget } from "@/lib/policy/action-review/outbound-targets"
import type {
  BrowserSubmissionAnswer,
  BrowserSubmissionAsk,
  BrowserSubmissionDecision,
  BrowserSubmissionPlanInput,
} from "@/lib/policy/action-review/plan-browser"

import {
  SUBMISSION_GUARD_METHODS,
  browserToolsAsker,
  gateBrowserEngine,
  isSubmittingKey,
  possibleSubmissionOperation,
  refusedMessage,
  type SubmissionGateDeps,
} from "./submission-gate"
import type { BrowserSubmissionAskContext } from "./submission-ask"

const FORMS = siteTarget("https://forms.example.com")!
const ENFORCE = { agentPermissions: { outboundAuthorizationByCategory: { browser: "enforce" } } }
const SHADOW = { agentPermissions: {} }

function report(overrides: Partial<BrowserSubmissionReport> = {}): BrowserSubmissionReport {
  return {
    id: "h1",
    url: "https://forms.example.com/submit",
    method: "POST",
    resourceType: "document",
    navigation: false,
    held: true,
    at: 1,
    ...overrides,
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 2))

/**
 * A Chromium engine whose runtime holds what each action submits until it is
 * resolved, the way `submission-guard.mjs` does under `hold`.
 */
function guardedEngine(
  options: {
    submits?: BrowserSubmissionReport[]
    unguarded?: boolean
    configureFails?: boolean
    drainFails?: boolean
  } = {}
) {
  let mode: BrowserSubmissionGuardMode = "off"
  let queued: BrowserSubmissionReport[] = []
  let windowOpen = false
  const waiting = new Map<string, () => void>()
  const engine = {
    backend: "local-chromium" as const,
    configureSubmissionGuard: jest.fn(async (next: BrowserSubmissionGuardMode) => {
      if (options.configureFails) throw new Error("unknown op browser.submission.configure")
      mode = next
      return { mode: next }
    }),
    drainSubmissions: jest.fn(async (waitMs = 0, pageId?: string) => {
      if (options.drainFails) throw new Error("browser_submission_drain: runtime gone")
      if (waitMs > 0) await tick()
      const reports = queued
      queued = []
      return { pageId: pageId ?? "p1", reports, windowOpen, unguarded: options.unguarded === true }
    }),
    resolveSubmission: jest.fn(async (id: string, decision: string) => {
      waiting.get(id)?.()
      return { id, decision }
    }),
    act: jest.fn(async () => {
      windowOpen = true
      const held: Promise<void>[] = []
      for (const submitted of options.submits ?? []) {
        const entry = { ...submitted, held: mode === "hold" }
        queued.push(entry)
        if (entry.held) held.push(new Promise<void>((resolve) => waiting.set(entry.id, resolve)))
      }
      await Promise.all(held)
      windowOpen = false
      return { ok: true, error: null, generation: 3 }
    }),
    pressKey: jest.fn(async () => ({ ok: true, error: null, generation: 3 })),
    setFiles: jest.fn(async () => ({ ok: true, error: null, generation: 3 })),
    evaluate: jest.fn(async () => ({ ok: true, value: 1 })),
    getPage: jest.fn(async () => ({ url: "https://forms.example.com/page", title: "Form" })),
    waitForLoad: jest.fn(async () => undefined),
    snapshot: jest.fn(async function (this: unknown) {
      return { self: this }
    }),
  }
  return engine
}

/** The embedded webview: no submission signal. */
function plainEngine() {
  return {
    backend: "embedded" as const,
    act: jest.fn(async () => ({ ok: true, error: null, generation: 1 })),
    pressKey: jest.fn(async () => ({ ok: true, error: null, generation: 1 })),
    drag: jest.fn(async () => ({ ok: true, error: null, generation: 1 })),
    evaluate: jest.fn(async () => ({ ok: true, value: 1 })),
    getPage: jest.fn(async () => ({ url: "https://forms.example.com/page", title: "Form" })),
    waitForLoad: jest.fn(async () => undefined),
  }
}

const asEngine = (engine: object) => engine as unknown as BrowserEngine

function ask(input: BrowserSubmissionPlanInput): BrowserSubmissionAsk {
  const view = { kind: "site" as const, channel: "browser", recipient: FORMS.recipient }
  return {
    unattended: false,
    target: FORMS,
    review: { targets: [view], unauthorized: [view], enforced: true },
    forRequestOffered: true,
    basis: input.basis,
    operation: input.operation,
    ownerRef: "browser:s1",
    sessionId: "s1",
    origin: {},
  }
}

/** Deps whose policy decides `decision` and whose person answers `answer`. */
function deps(
  settings: object,
  decision: "proceed" | "ask" | "refuse",
  answer: BrowserSubmissionAnswer = { kind: "allowed" }
) {
  const plan = jest.fn(
    async (input: BrowserSubmissionPlanInput): Promise<BrowserSubmissionDecision> => {
      if (decision === "ask") return { action: "ask", ask: ask(input) }
      if (decision === "refuse")
        return { action: "refuse", receipt: { request: {}, decision: {} } as never }
      return { action: "proceed" }
    }
  )
  const askPerson = jest.fn(
    async (_ask: BrowserSubmissionAsk, _context: BrowserSubmissionAskContext) => answer
  )
  const recordReceipt = jest.fn(async () => undefined)
  const gateDeps: SubmissionGateDeps = {
    settings: () => settings,
    plan,
    ask: askPerson,
    recordReceipt,
    capturedTurnOf: () => undefined,
    now: () => 7,
  }
  return { gateDeps, plan, askPerson, recordReceipt }
}

const chat = { kind: "chat" as const, sessionId: "s1" }

describe("possible submissions", () => {
  it("counts clicks, choosing an option, drags, Enter and Space, never typing or hovering", () => {
    expect(possibleSubmissionOperation("act", ["r1", "click", {}])).toBe("click")
    expect(possibleSubmissionOperation("act", ["r1", "double_click", {}])).toBe("double_click")
    expect(possibleSubmissionOperation("act", ["r1", "select", { value: "x" }])).toBe("select")
    expect(possibleSubmissionOperation("drag", ["a", "b"])).toBe("drag")
    // Choosing a file may upload it at once.
    expect(possibleSubmissionOperation("setFiles", ["r1", ["a.pdf"]])).toBe("set_files")
    expect(possibleSubmissionOperation("pressKey", ["Enter"])).toBe("press:Enter")
    expect(possibleSubmissionOperation("pressKey", ["ctrl+Enter"])).toBe("press:ctrl+Enter")
    expect(possibleSubmissionOperation("pressKey", ["Space"])).toBe("press:Space")
    for (const action of ["type", "fill", "hover", "focus"]) {
      expect(possibleSubmissionOperation("act", ["r1", action, {}])).toBeNull()
    }
    expect(possibleSubmissionOperation("pressKey", ["Tab"])).toBeNull()
    expect(possibleSubmissionOperation("evaluate", ["1"])).toBeNull()
    expect(isSubmittingKey("shift+ ")).toBe(true)
    expect(isSubmittingKey("a")).toBe(false)
  })

  it("names the refused sites for the agent", () => {
    expect(refusedMessage(["https://forms.example.com"])).toMatch(
      /^outbound_refused: .*\(https:\/\/forms\.example\.com\)$/
    )
  })
})

describe("browserToolsAsker", () => {
  it("tells a chat, a bridge client and a call with no session apart", () => {
    expect(browserToolsAsker("cognia-browser-tools", "s1")).toEqual(chat)
    expect(browserToolsAsker("cognia-browser-tools", "external-bridge:browser:claude")).toEqual({
      kind: "external-bridge",
      clientId: "claude",
    })
    expect(browserToolsAsker("cognia-browser-tools", undefined)).toEqual({
      kind: "plugin",
      pluginId: "cognia-browser-tools",
    })
  })
})

describe("gateBrowserEngine", () => {
  it("never hands out the guard's own methods, and passes the rest through", async () => {
    const engine = guardedEngine()
    const gated = gateBrowserEngine(asEngine(engine), chat, {}, deps(SHADOW, "proceed").gateDeps)
    for (const method of SUBMISSION_GUARD_METHODS) {
      expect((gated as unknown as Record<string, unknown>)[method]).toBeUndefined()
      expect(method in gated).toBe(false)
    }
    expect(isSubmissionGuardedEngine(gated)).toBe(false)
    expect(gated.backend).toBe("local-chromium")
    await expect(gated.snapshot()).resolves.toEqual({ self: engine })
    expect(gateBrowserEngine(asEngine(engine), chat)).toBe(gated)
    expect(gateBrowserEngine(asEngine(engine), { kind: "chat", sessionId: "s2" })).not.toBe(gated)
  })

  describe("on an engine with a submission signal", () => {
    it("observes under shadow mode: the action is unchanged, its submission planned", async () => {
      const engine = guardedEngine({ submits: [report()] })
      const { gateDeps, plan, askPerson } = deps(SHADOW, "proceed")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toEqual({
        ok: true,
        error: null,
        generation: 3,
      })
      expect(engine.configureSubmissionGuard).toHaveBeenCalledWith("observe")
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(plan).toHaveBeenCalledWith({
        url: "https://forms.example.com/submit",
        basis: "request",
        operation: "POST",
        asker: chat,
      })
      expect(askPerson).not.toHaveBeenCalled()
      expect(engine.resolveSubmission).not.toHaveBeenCalled()
    })

    it("holds under enforcement, asks, and lets the allowed submission go", async () => {
      const engine = guardedEngine({ submits: [report({ navigation: true })] })
      const { gateDeps, askPerson, recordReceipt } = deps(ENFORCE, "ask", {
        kind: "allowed",
        forRequest: true,
      })
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toMatchObject({ ok: true })
      expect(engine.configureSubmissionGuard).toHaveBeenCalledWith("hold")
      expect(askPerson).toHaveBeenCalledTimes(1)
      expect(askPerson.mock.calls[0][1]).toMatchObject({
        approvalOrigin: "plugin",
        label: "Browser: https://forms.example.com",
      })
      expect(engine.resolveSubmission).toHaveBeenCalledWith("h1", "allow")
      // The page navigates once allowed: the gate waits for it to load.
      expect(engine.waitForLoad).toHaveBeenCalled()
      // The person's answer is recorded, an allow for this request as an instruction grant.
      await Promise.resolve()
      expect(recordReceipt).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: expect.objectContaining({
            authority: "human",
            grant: { scope: "instruction" },
          }),
        })
      )
    })

    it("refuses what a person refused and tells the agent which site", async () => {
      const engine = guardedEngine({ submits: [report()] })
      const { gateDeps } = deps(ENFORCE, "ask", { kind: "refused" })
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toEqual({
        ok: false,
        error: refusedMessage(["https://forms.example.com"]),
        code: "outbound_refused",
        generation: 3,
      })
      expect(engine.resolveSubmission).toHaveBeenCalledWith("h1", "refuse")
      expect(engine.waitForLoad).not.toHaveBeenCalled()
    })

    it("asks once about a burst to one site", async () => {
      const engine = guardedEngine({
        submits: [
          report({ id: "h1" }),
          report({ id: "h2", method: "PUT" }),
          report({ id: "h3", url: "wss://forms.example.com/s", method: "WS" }),
        ],
      })
      const { gateDeps, askPerson, plan } = deps(ENFORCE, "ask")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await gated.act("r1", "click", {})
      expect(plan).toHaveBeenCalledTimes(1)
      expect(askPerson).toHaveBeenCalledTimes(1)
      expect(engine.resolveSubmission.mock.calls).toEqual([
        ["h1", "allow"],
        ["h2", "allow"],
        ["h3", "allow"],
      ])
    })

    it("reports a refused submission of an evaluated expression as an error", async () => {
      const engine = guardedEngine()
      engine.evaluate.mockImplementation(async () => {
        await engine.act()
        return { ok: true, value: 1 }
      })
      const own = guardedEngine({ submits: [report()] })
      engine.act = own.act
      engine.drainSubmissions = own.drainSubmissions
      engine.resolveSubmission = own.resolveSubmission
      engine.configureSubmissionGuard = own.configureSubmissionGuard
      const { gateDeps } = deps(ENFORCE, "refuse")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.evaluate("document.forms[0].submit()")).rejects.toMatchObject({
        code: "outbound_refused",
      })
    })

    it("decides before acting on a page its service worker hides from the guard", async () => {
      const engine = guardedEngine({ unguarded: true })
      const { gateDeps, plan } = deps(ENFORCE, "refuse")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toMatchObject({
        code: "outbound_refused",
      })
      expect(engine.act).not.toHaveBeenCalled()
      expect(plan).toHaveBeenCalledWith({
        url: "https://forms.example.com/page",
        basis: "possible",
        operation: "click",
        asker: chat,
      })
    })

    it("decides before acting when the runtime cannot guard", async () => {
      const engine = guardedEngine({ configureFails: true })
      const { gateDeps, plan } = deps(ENFORCE, "refuse")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.pressKey("Enter")).resolves.toMatchObject({ code: "outbound_refused" })
      expect(engine.pressKey).not.toHaveBeenCalled()
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ operation: "press:Enter" }))
      // A key that does not submit just runs.
      await expect(gated.pressKey("Tab")).resolves.toMatchObject({ ok: true })
    })

    it("lets the action run under shadow mode when the guard cannot report", async () => {
      const engine = guardedEngine({ drainFails: true })
      const { gateDeps, plan } = deps(SHADOW, "refuse")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toMatchObject({ ok: true })
      expect(engine.act).toHaveBeenCalledTimes(1)
      expect(plan).not.toHaveBeenCalled()
    })

    it("decides before acting under enforcement when the guard cannot report", async () => {
      const engine = guardedEngine({ drainFails: true })
      const { gateDeps, plan } = deps(ENFORCE, "refuse")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toMatchObject({
        code: "outbound_refused",
      })
      expect(engine.act).not.toHaveBeenCalled()
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ operation: "click" }))
      // An action that cannot submit still runs.
      await expect(gated.act("r1", "hover", {})).resolves.toMatchObject({ ok: true })
    })

    it("watches what choosing a file submits", async () => {
      const engine = guardedEngine()
      const { gateDeps } = deps(ENFORCE, "proceed")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.setFiles("r1", ["a.pdf"])).resolves.toMatchObject({ ok: true })
      expect(engine.drainSubmissions).toHaveBeenCalled()
      expect(engine.setFiles).toHaveBeenCalledWith("r1", ["a.pdf"])
    })

    it("configures the guard once per mode", async () => {
      const engine = guardedEngine()
      let settings: object = SHADOW
      const { gateDeps } = deps(SHADOW, "proceed")
      const gated = gateBrowserEngine(
        asEngine(engine),
        chat,
        {},
        { ...gateDeps, settings: () => settings }
      )
      await gated.act("r1", "click", {})
      await gated.act("r1", "click", {})
      settings = ENFORCE
      await gated.act("r1", "click", {})
      expect(engine.configureSubmissionGuard.mock.calls).toEqual([["observe"], ["hold"]])
    })
  })

  describe("on an engine with no submission signal", () => {
    it("plans a click before it runs, against the page's own site", async () => {
      const engine = plainEngine()
      const { gateDeps, plan, askPerson } = deps(ENFORCE, "ask", { kind: "refused" })
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toEqual({
        ok: false,
        code: "outbound_refused",
        error: refusedMessage(["https://forms.example.com"]),
        generation: 0,
      })
      expect(engine.act).not.toHaveBeenCalled()
      expect(plan).toHaveBeenCalledWith({
        url: "https://forms.example.com/page",
        basis: "possible",
        operation: "click",
        asker: chat,
      })
      expect(askPerson).toHaveBeenCalledTimes(1)
    })

    it("runs an allowed action, and never plans typing, hovering or evaluating", async () => {
      const engine = plainEngine()
      const { gateDeps, plan } = deps(ENFORCE, "ask")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.drag("a", "b")).resolves.toMatchObject({ ok: true })
      expect(plan).toHaveBeenCalledTimes(1)
      await gated.act("r1", "type", { text: "hi" })
      await gated.act("r1", "hover", {})
      await gated.evaluate("1")
      await gated.pressKey("a")
      expect(plan).toHaveBeenCalledTimes(1)
      expect(engine.act).toHaveBeenCalledTimes(2)
    })

    it("lets every action run under shadow mode", async () => {
      const engine = plainEngine()
      const { gateDeps, askPerson } = deps(SHADOW, "proceed")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await expect(gated.act("r1", "click", {})).resolves.toMatchObject({ ok: true })
      expect(askPerson).not.toHaveBeenCalled()
    })

    it("asks about a page that cannot say where it is as a page with no site", async () => {
      const engine = plainEngine()
      engine.getPage.mockRejectedValueOnce(new Error("no page"))
      const { gateDeps, plan } = deps(ENFORCE, "proceed")
      const gated = gateBrowserEngine(asEngine(engine), chat, {}, gateDeps)
      await gated.act("r1", "click", {})
      expect(plan).toHaveBeenCalledWith(expect.objectContaining({ url: "" }))
    })
  })

  it("plans a chat as the turn a runner drives in it", async () => {
    const engine = plainEngine()
    const { gateDeps, plan } = deps(ENFORCE, "proceed")
    const origin = { rootSessionId: "task:t1", instructionEpoch: "e" }
    const gated = gateBrowserEngine(
      asEngine(engine),
      chat,
      {},
      {
        ...gateDeps,
        capturedTurnOf: () => ({ turnId: "t1", outboundPolicy: { unattended: true, origin } }),
      }
    )
    await gated.act("r1", "click", {})
    expect(plan).toHaveBeenCalledWith(
      expect.objectContaining({
        asker: { kind: "turn", sessionId: "s1", unattended: true, origin },
      })
    )
  })

  it("withdraws a run's questions with its signal", async () => {
    const engine = plainEngine()
    const controller = new AbortController()
    const { gateDeps, askPerson } = deps(ENFORCE, "ask", {
      kind: "unavailable",
      reason: "cancelled",
    })
    const gated = gateBrowserEngine(
      asEngine(engine),
      { kind: "workflow", workflowId: "w1", runId: "r1" },
      { signal: controller.signal },
      gateDeps
    )
    await gated.act("r1", "click", {})
    expect(askPerson.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
  })
})
