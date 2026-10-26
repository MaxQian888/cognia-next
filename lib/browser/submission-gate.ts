/**
 * The browser submission gate (ADR-0239 phase 2b): every engine the host
 * hands an agent goes through here, so what its actions send to a site is
 * planned by the outbound policy (`lib/policy/action-review/plan-browser.ts`).
 *
 * **Engines with a submission signal** (local Chromium, the person's own
 * Chrome, the cloud browser: `SubmissionGuardedEngine`). The runtime's guard
 * runs in the browser category's mode: `observe` under shadow mode, `hold`
 * under enforcement. Each agent action (`act`, `pressKey`, `drag`,
 * `evaluate`, history, answering a dialog) runs while one drainer per page
 * reads what it submits, plans each report against its site (one decision per
 * site for the drainer's life, so a burst to one site asks once) and answers
 * held ones. The action returns once every question raised while it ran is
 * answered; what the page sends during the grace period after it is still
 * planned and asked about in the background. A refused submission is
 * reported to the agent as `outbound_refused` with the site.
 *
 * **Engines with none** (the embedded webview, the extension engine) and a
 * page a service worker controls in the person's own Chrome (the drain says
 * `unguarded`): an action that may submit (a click, a double click, choosing
 * an option, a drag, Enter or Space) is planned before it runs against the
 * page's own site, and runs only if allowed. Typing, filling, hovering,
 * focusing and scrolling are not planned; a page that saves as you type
 * (autosave) is a known gap.
 *
 * Shadow mode changes nothing an agent sees: every submission goes out, and
 * what enforcement would have asked about or refused is recorded.
 *
 * The gated engine never exposes the guard's own methods
 * (`configureSubmissionGuard`, `drainSubmissions`, `resolveSubmission`): only
 * this gate answers a held submission.
 */

import type { BrowserEngine } from "@/lib/browser/agent-engine"
import {
  isSubmissionGuardedEngine,
  type BrowserActionResult,
  type BrowserSubmissionGuardMode,
  type BrowserSubmissionReport,
  type SubmissionGuardedEngine,
} from "@/lib/browser/protocol"
import { capturedTurnOf as defaultCapturedTurnOf } from "@/lib/policy/action-review/captured-turns"
import { outboundFingerprint } from "@/lib/policy/action-review/outbound-targets"
import { readAppSettings, type OutboundSettingsLike } from "@/lib/policy/action-review/plan-context"
import {
  BROWSER_SUBMISSION_REFUSED_ERROR,
  browserSubmissionAnswerReceipt,
  planBrowserSubmission as defaultPlan,
  submissionSiteTarget,
  type BrowserSubmissionAsker,
  type BrowserSubmissionPlanInput,
  type BrowserSubmissionReceipt,
} from "@/lib/policy/action-review/plan-browser"
import { readOutboundAuthorizationMode } from "@/lib/policy/action-review/policy"

import {
  askAboutBrowserSubmission as defaultAsk,
  siteOf,
  type BrowserSubmissionAskContext,
} from "./submission-ask"

/** The guard's own methods, never handed to the agent. */
export const SUBMISSION_GUARD_METHODS = [
  "configureSubmissionGuard",
  "drainSubmissions",
  "resolveSubmission",
] as const

/** How long one drain waits for a report. */
const DRAIN_WAIT_MS = 1_000

/** The engine methods whose actions the gate watches. */
type GatedMethod =
  | "act"
  | "pressKey"
  | "drag"
  | "setFiles"
  | "evaluate"
  | "back"
  | "forward"
  | "reload"
  | "handleDialog"

const GATED_METHODS: ReadonlySet<string> = new Set<GatedMethod>([
  "act",
  "pressKey",
  "drag",
  // A file input's change handler may post the file at once.
  "setFiles",
  "evaluate",
  "back",
  "forward",
  "reload",
  "handleDialog",
])

/** `act` actions that may submit on an engine with no submission signal. */
const POSSIBLE_SUBMISSION_ACTIONS: ReadonlySet<string> = new Set([
  "click",
  "double_click",
  "select",
])

/** Keys that submit a form or press a button: Enter and Space, with any modifiers. */
const SUBMITTING_KEYS: ReadonlySet<string> = new Set([
  "enter",
  "numpadenter",
  "return",
  "space",
  " ",
])

export interface SubmissionGateDeps {
  settings?: () => OutboundSettingsLike | Promise<OutboundSettingsLike>
  plan?: typeof defaultPlan
  ask?: typeof defaultAsk
  recordReceipt?: (receipt: BrowserSubmissionReceipt) => Promise<void>
  capturedTurnOf?: typeof defaultCapturedTurnOf
  now?: () => number
}

export interface SubmissionGateOptions {
  /** The run gave up (a workflow run cancelled): withdraw its questions. */
  signal?: AbortSignal
}

async function defaultRecordReceipt(receipt: BrowserSubmissionReceipt): Promise<void> {
  try {
    const { projectActionReviewSettled } = await import("@/lib/policy/action-review/projection")
    await projectActionReviewSettled(receipt.request, receipt.decision)
  } catch {
    // Audit is best-effort, as at the other chokepoints.
  }
}

/** Whether a key chord submits: its last key is Enter or Space. */
export function isSubmittingKey(key: string): boolean {
  const last = key.split("+").pop() ?? key
  return SUBMITTING_KEYS.has(last === " " ? " " : last.trim().toLowerCase())
}

/**
 * The operation a possible submission is planned and asked about as: the
 * action (`click`, `double_click`, `select`, `drag`), or `press:<key>`;
 * `null` for an action that does not submit.
 */
export function possibleSubmissionOperation(method: string, args: unknown[]): string | null {
  if (method === "act") {
    const action = String(args[1] ?? "")
    return POSSIBLE_SUBMISSION_ACTIONS.has(action) ? action : null
  }
  if (method === "drag") return "drag"
  // Choosing a file may upload it at once, like a select that submits.
  if (method === "setFiles") return "set_files"
  if (method === "pressKey") {
    const key = String(args[0] ?? "")
    return isSubmittingKey(key) ? `press:${key}` : null
  }
  return null
}

/** The error a refused submission reports, naming the sites. */
export function refusedMessage(sites: readonly string[]): string {
  return sites.length > 0
    ? `${BROWSER_SUBMISSION_REFUSED_ERROR} (${sites.join(", ")})`
    : BROWSER_SUBMISSION_REFUSED_ERROR
}

function refusedError(sites: readonly string[]): Error {
  return Object.assign(new Error(refusedMessage(sites)), { code: "outbound_refused" })
}

function refusedResult(method: GatedMethod, result: unknown, sites: readonly string[]): unknown {
  if (method === "act" || method === "pressKey" || method === "drag") {
    const base = (
      result && typeof result === "object" ? result : {}
    ) as Partial<BrowserActionResult>
    return {
      ...base,
      ok: false,
      code: "outbound_refused",
      error: refusedMessage(sites),
      generation: typeof base.generation === "number" ? base.generation : 0,
    } satisfies BrowserActionResult
  }
  throw refusedError(sites)
}

/** One decision about a site, for the drainer's life. */
interface SiteDecision {
  allowed: boolean
  site: string
}

/**
 * Reads one page's submissions while an action (or its grace period) is in
 * progress, and answers them. Shared by every action on the page, so two
 * actions never drain against each other.
 */
class PageDrainer {
  private retained = 0
  private loop: Promise<void> | null = null
  private readonly sites = new Map<string, Promise<SiteDecision>>()
  private readonly pending = new Set<Promise<unknown>>()
  /** Every site refused and every navigation allowed, in order, for an action to look at. */
  readonly refused: string[] = []
  allowedNavigations = 0

  constructor(
    private readonly gate: GateCore,
    private readonly engine: SubmissionGuardedEngine,
    readonly pageId: string,
    private readonly onIdle: () => void
  ) {}

  retain(): () => void {
    this.retained += 1
    this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.retained -= 1
    }
  }

  handle(reports: readonly BrowserSubmissionReport[]): void {
    for (const report of reports) {
      const work = this.decide(report).finally(() => this.pending.delete(work))
      this.pending.add(work)
    }
  }

  /** Wait for every question raised so far. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private start(): void {
    if (this.loop) return
    this.loop = (async () => {
      try {
        for (;;) {
          const drained = await this.engine.drainSubmissions(DRAIN_WAIT_MS, this.pageId)
          this.handle(drained.reports)
          if (this.retained === 0 && !drained.windowOpen) break
        }
      } catch {
        // The page or the session went away. A held submission nobody
        // answers is refused by the runtime's own timeout.
      } finally {
        await this.settled()
        this.loop = null
        if (this.retained > 0) this.start()
        else this.onIdle()
      }
    })()
  }

  private async decide(report: BrowserSubmissionReport): Promise<void> {
    const target = submissionSiteTarget(report.url)
    const key = outboundFingerprint(target)
    let decision = this.sites.get(key)
    if (!decision) {
      decision = this.gate.decide({
        url: report.url,
        basis: "request",
        operation: report.method,
      })
      this.sites.set(key, decision)
    }
    const { allowed, site } = await decision
    if (!report.held) return
    if (!allowed) this.refused.push(site)
    else if (report.navigation) this.allowedNavigations += 1
    await this.engine
      .resolveSubmission(report.id, allowed ? "allow" : "refuse")
      .catch(() => undefined)
  }
}

/** The planning and asking one gated engine does. */
class GateCore {
  constructor(
    private readonly asker: BrowserSubmissionAsker,
    private readonly options: SubmissionGateOptions,
    private readonly deps: SubmissionGateDeps
  ) {}

  async mode(): Promise<"shadow" | "enforce"> {
    const settings = await (this.deps.settings ?? readAppSettings)()
    return readOutboundAuthorizationMode(settings, "browser")
  }

  /** The asker the policy sees: a chat with a captured turn running plans as that turn. */
  private resolvedAsker(): BrowserSubmissionAsker {
    if (this.asker.kind !== "chat") return this.asker
    const turn = (this.deps.capturedTurnOf ?? defaultCapturedTurnOf)(this.asker.sessionId)
    if (!turn) return this.asker
    const policy = turn.outboundPolicy
    return {
      kind: "turn",
      sessionId: this.asker.sessionId,
      unattended: policy.unattended,
      ...(policy.origin ? { origin: policy.origin } : {}),
      ...(policy.policyGrants ? { policyGrants: policy.policyGrants } : {}),
    }
  }

  private record(receipt: BrowserSubmissionReceipt | undefined): void {
    if (!receipt) return
    void (this.deps.recordReceipt ?? defaultRecordReceipt)(receipt).catch(() => undefined)
  }

  /** Plan one submission and, when the policy asks, ask a person. */
  async decide(input: Omit<BrowserSubmissionPlanInput, "asker">): Promise<SiteDecision> {
    const asker = this.resolvedAsker()
    const decision = await (this.deps.plan ?? defaultPlan)({ ...input, asker })
    const site =
      siteOf(submissionSiteTarget(input.url)) ?? (input.url || "a page with no web address")
    switch (decision.action) {
      case "proceed":
        this.record(decision.receipt)
        return { allowed: true, site }
      case "refuse":
        this.record(decision.receipt)
        return { allowed: false, site }
      case "ask": {
        const context: BrowserSubmissionAskContext = {
          approvalOrigin: "plugin",
          label: `Browser: ${siteOf(decision.ask.target) ?? "page with no web address"}`,
          ...(this.options.signal ? { signal: this.options.signal } : {}),
        }
        const answer = await (this.deps.ask ?? defaultAsk)(decision.ask, context)
        this.record(
          browserSubmissionAnswerReceipt(decision.ask, answer, this.deps.now?.() ?? Date.now())
        )
        return { allowed: answer.kind === "allowed", site }
      }
    }
  }
}

const configuredModes = new WeakMap<object, BrowserSubmissionGuardMode>()

/**
 * Set the runtime guard's mode, once per engine and mode. False when the
 * runtime cannot guard (an older Host): the gate then decides before the
 * action, as for an engine with no submission signal.
 */
async function ensureGuardMode(
  engine: SubmissionGuardedEngine,
  mode: BrowserSubmissionGuardMode
): Promise<boolean> {
  if (configuredModes.get(engine) === mode) return true
  try {
    await engine.configureSubmissionGuard(mode)
    configuredModes.set(engine, mode)
    return true
  } catch {
    configuredModes.delete(engine)
    return false
  }
}

function gatedEngine(engine: BrowserEngine, core: GateCore): BrowserEngine {
  const guarded = isSubmissionGuardedEngine(engine) ? engine : null
  const drainers = new Map<string, PageDrainer>()

  const drainerFor = (pageId: string): PageDrainer => {
    let drainer = drainers.get(pageId)
    if (!drainer) {
      drainer = new PageDrainer(core, guarded!, pageId, () => {
        if (drainers.get(pageId) === drainer) drainers.delete(pageId)
      })
      drainers.set(pageId, drainer)
    }
    return drainer
  }

  /** Plan an action that may submit before it runs; the refused sites, or none. */
  const planPossible = async (operation: string): Promise<string[]> => {
    let url = ""
    try {
      url = (await engine.getPage()).url ?? ""
    } catch {
      // A page that cannot say where it is has no site: asked per call.
    }
    const { allowed, site } = await core.decide({ url, basis: "possible", operation })
    return allowed ? [] : [site]
  }

  const run = async (method: GatedMethod, args: unknown[]): Promise<unknown> => {
    const call = () => (engine[method] as (...a: unknown[]) => Promise<unknown>).apply(engine, args)
    const enforce = (await core.mode()) === "enforce"
    const possible = possibleSubmissionOperation(method, args)

    if (!guarded || !(await ensureGuardMode(guarded, enforce ? "hold" : "observe"))) {
      if (!possible) return call()
      const refused = await planPossible(possible)
      return refused.length > 0 ? refusedResult(method, undefined, refused) : call()
    }

    let first: Awaited<ReturnType<SubmissionGuardedEngine["drainSubmissions"]>>
    try {
      first = await guarded.drainSubmissions(0)
    } catch {
      // The guard cannot report for this action. Shadow mode only observes,
      // so the action runs as it would have; enforcement decides before it.
      if (!enforce || !possible) return call()
      const refused = await planPossible(possible)
      return refused.length > 0 ? refusedResult(method, undefined, refused) : call()
    }
    const drainer = drainerFor(first.pageId)
    drainer.handle(first.reports)
    if (first.unguarded && possible) {
      const refused = await planPossible(possible)
      if (refused.length > 0) return refusedResult(method, undefined, refused)
    }
    const refusedBefore = drainer.refused.length
    const navigationsBefore = drainer.allowedNavigations
    const release = drainer.retain()
    let result: unknown
    try {
      result = await call()
    } finally {
      release()
    }
    // A question raised while the action ran is answered before it returns.
    await drainer.settled()
    const refused = drainer.refused.slice(refusedBefore)
    if (refused.length > 0) return refusedResult(method, result, [...new Set(refused)])
    if (drainer.allowedNavigations > navigationsBefore) {
      // The page navigates once the person allowed it, after the action itself returned.
      await engine.waitForLoad({ timeoutMs: 8_000 }).catch(() => undefined)
    }
    return result
  }

  return new Proxy(engine, {
    get(target, property) {
      if ((SUBMISSION_GUARD_METHODS as readonly PropertyKey[]).includes(property)) return undefined
      if (typeof property === "string" && GATED_METHODS.has(property)) {
        return (...args: unknown[]) => run(property as GatedMethod, args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === "function" ? value.bind(target) : value
    },
    has(target, property) {
      if ((SUBMISSION_GUARD_METHODS as readonly PropertyKey[]).includes(property)) return false
      return Reflect.has(target, property)
    },
  })
}

const gated = new WeakMap<BrowserEngine, Map<string, BrowserEngine>>()

function askerKey(asker: BrowserSubmissionAsker): string {
  switch (asker.kind) {
    case "chat":
      return `chat:${asker.sessionId}`
    case "turn":
      return `turn:${asker.sessionId}`
    case "workflow":
      return `workflow:${asker.workflowId}:${asker.runId}`
    case "external-bridge":
      return `external-bridge:${asker.clientId}`
    case "plugin":
      // Each handler Bot run lends its own sites, so it gets its own gate.
      return asker.botRunId
        ? `plugin:${asker.pluginId}:run:${asker.botRunId}`
        : `plugin:${asker.pluginId}`
  }
}

/**
 * The engine an agent drives, through the gate, for `asker`. The same engine
 * and asker give the same gated engine, so a facade built over it is reused.
 */
export function gateBrowserEngine(
  engine: BrowserEngine,
  asker: BrowserSubmissionAsker,
  options: SubmissionGateOptions = {},
  deps: SubmissionGateDeps = {}
): BrowserEngine {
  const byAsker = gated.get(engine) ?? new Map<string, BrowserEngine>()
  gated.set(engine, byAsker)
  const key = askerKey(asker)
  const existing = byAsker.get(key)
  if (existing) return existing
  const wrapped = gatedEngine(engine, new GateCore(asker, options, deps))
  byAsker.set(key, wrapped)
  return wrapped
}

/** The sidecar session id the External Bridge drives the browser tools under (`bridgeBrowserSessionId`). */
const BRIDGE_SESSION_PREFIX = "external-bridge:browser:"

/** Who drives the built-in browser tools' call, from its chat session. */
export function browserToolsAsker(
  pluginId: string,
  chatSessionId: string | undefined
): BrowserSubmissionAsker {
  if (chatSessionId?.startsWith(BRIDGE_SESSION_PREFIX)) {
    return { kind: "external-bridge", clientId: chatSessionId.slice(BRIDGE_SESSION_PREFIX.length) }
  }
  if (chatSessionId) return { kind: "chat", sessionId: chatSessionId }
  return { kind: "plugin", pluginId }
}
