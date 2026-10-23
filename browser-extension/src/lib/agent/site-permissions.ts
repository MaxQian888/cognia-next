/**
 * The person's decision about each site an agent wants to act on
 * (ADR-0228 §7).
 *
 * On top of the browser's own `<all_urls>` grant, which is all-or-nothing, the
 * extension asks per origin the first time an operation targets it: allow
 * once (this conversation), always allow, or never. A question with the panel
 * closed raises the badge — and a notification when those are on — and waits
 * until the operation's own deadline; then it refuses with
 * `browser_site_permission_required` rather than proceeding. The question is
 * answered in the panel, inside a person's click.
 */
import { AgentOperationError } from "./protocol"
import type { StorageArea } from "./storage-area"

export const SITE_DECISIONS_KEY = "cognia.agent.siteDecisions.v1"
export const PENDING_SITE_QUESTIONS_KEY = "cognia.agent.siteQuestions.v1"

export type StandingDecision = "always" | "never"

export interface SiteQuestion {
  id: string
  session: string
  origin: string
  /** What the agent was about to do, for the person reading the question. */
  operation: string
  askedAt: number
}

export type SiteAnswer = "once" | "always" | "never"

export type AgentPermissionMessage =
  | { kind: "cognia-agent-permission"; action: "answer"; questionId: string; answer: SiteAnswer }
  | { kind: "cognia-agent-permission"; action: "forget"; origin: string }

export function isAgentPermissionMessage(value: unknown): value is AgentPermissionMessage {
  if (!value || typeof value !== "object") return false
  const message = value as Record<string, unknown>
  if (message.kind !== "cognia-agent-permission") return false
  if (message.action === "answer")
    return (
      typeof message.questionId === "string" &&
      message.questionId.length > 0 &&
      ["once", "always", "never"].includes(message.answer as string)
    )
  if (message.action !== "forget" || typeof message.origin !== "string") return false
  try {
    return originOf(message.origin) === message.origin
  } catch {
    return false
  }
}

/** The origin an operation acts on, or a refusal for anything but http(s). */
export function originOf(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new AgentOperationError("browser_page_restricted", `not a web address: ${url}`)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgentOperationError(
      "browser_page_restricted",
      `agents can only act on http and https pages, not ${parsed.protocol}`
    )
  }
  return parsed.origin
}

export interface SitePermissionDeps {
  local: StorageArea
  session: StorageArea
  now: () => number
  newId: () => string
  /** Called when a question is raised, so the badge and notification can say so. */
  onQuestion: (question: SiteQuestion) => void
  /** Whether the session already has a once-grant for the origin. */
  hasOnce: (session: string, origin: string) => Promise<boolean>
  /** Record a once-grant on the session. */
  grantOnce: (session: string, origin: string) => Promise<void>
}

export class SitePermissions {
  private questionQueue: Promise<unknown> = Promise.resolve()
  private readonly waiters = new Map<string, number>()
  private readonly retired = new Set<string>()

  constructor(private readonly deps: SitePermissionDeps) {}

  private updateQuestions<T>(
    change: (questions: SiteQuestion[]) => { questions: SiteQuestion[]; result: T }
  ): Promise<T> {
    const run = this.questionQueue.then(async () => {
      const next = change(await this.questions())
      await this.deps.session.set(PENDING_SITE_QUESTIONS_KEY, next.questions)
      return next.result
    })
    this.questionQueue = run.catch(() => undefined)
    return run
  }

  async decisions(): Promise<Record<string, StandingDecision>> {
    return (await this.deps.local.get<Record<string, StandingDecision>>(SITE_DECISIONS_KEY)) ?? {}
  }

  async setDecision(origin: string, decision: StandingDecision | null): Promise<void> {
    const decisions = await this.decisions()
    if (decision) decisions[origin] = decision
    else delete decisions[origin]
    await this.deps.local.set(SITE_DECISIONS_KEY, decisions)
  }

  async questions(): Promise<SiteQuestion[]> {
    return (await this.deps.session.get<SiteQuestion[]>(PENDING_SITE_QUESTIONS_KEY)) ?? []
  }

  /**
   * Resolve once the person allows `origin` for `session`, or refuse.
   *
   * A standing "never" refuses at once; "always" or a once-grant passes at once.
   * Otherwise one question is raised (joined, not duplicated, if the same
   * session already asked about the same origin) and awaited until `deadline`.
   */
  async ensureAllowed(
    session: string,
    url: string,
    operation: string,
    deadline: number,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted()
    const origin = originOf(url)
    const standing = (await this.decisions())[origin]
    if (standing === "never") {
      throw new AgentOperationError(
        "browser_site_blocked",
        `you have blocked agents from acting on ${origin}`
      )
    }
    if (standing === "always" || (await this.deps.hasOnce(session, origin))) return

    let question: SiteQuestion | undefined
    let registered = false
    const leave = (cancelled: boolean) => {
      if (!registered || !question) return
      registered = false
      const count = (this.waiters.get(question.id) ?? 1) - 1
      if (count > 0) this.waiters.set(question.id, count)
      else {
        this.waiters.delete(question.id)
        if (cancelled) this.retired.add(question.id)
      }
    }
    const aborted = () => leave(true)
    try {
      const created = await this.updateQuestions((questions) => {
        signal?.throwIfAborted()
        const existing = questions.find(
          (entry) =>
            entry.session === session && entry.origin === origin && !this.retired.has(entry.id)
        )
        question = existing ?? {
          id: this.deps.newId(),
          session,
          origin,
          operation,
          askedAt: this.deps.now(),
        }
        this.waiters.set(question.id, (this.waiters.get(question.id) ?? 0) + 1)
        registered = true
        signal?.addEventListener("abort", aborted, { once: true })
        return { questions: existing ? questions : [...questions, question], result: !existing }
      })
      if (created) this.deps.onQuestion(question!)
      signal?.throwIfAborted()
      await this.awaitAnswer(question!, deadline, signal)
    } finally {
      signal?.removeEventListener("abort", aborted)
      leave(signal?.aborted ?? false)
      if (question && this.retired.has(question.id)) {
        const id = question.id
        await this.updateQuestions((questions) => ({
          questions: questions.filter((entry) => entry.id !== id),
          result: undefined,
        }))
        this.retired.delete(id)
      }
    }
  }

  private awaitAnswer(
    question: SiteQuestion,
    deadline: number,
    signal?: AbortSignal
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (outcome: "allowed" | "blocked" | "timeout" | "cancelled") => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stopQuestions()
        stopDecisions()
        signal?.removeEventListener("abort", aborted)
        if (outcome === "allowed") resolve()
        else if (outcome === "cancelled") reject(signal?.reason)
        else if (outcome === "blocked") {
          reject(
            new AgentOperationError(
              "browser_site_blocked",
              `you have blocked agents from acting on ${question.origin}`
            )
          )
        } else {
          reject(
            new AgentOperationError(
              "browser_site_permission_required",
              `waiting for you to allow ${question.origin} in the Cognia side panel`
            )
          )
        }
      }
      const aborted = () => finish("cancelled")
      const check = async () => {
        const standing = (await this.decisions())[question.origin]
        if (standing === "never") return finish("blocked")
        if (standing === "always") return finish("allowed")
        if (await this.deps.hasOnce(question.session, question.origin)) return finish("allowed")
        const stillAsked = (await this.questions()).some((entry) => entry.id === question.id)
        // Answered "never" for this session only removes the question without
        // a grant; treat a vanished, ungranted question as a refusal.
        if (!stillAsked) finish("blocked")
      }
      const stopQuestions = this.deps.session.onChange(PENDING_SITE_QUESTIONS_KEY, () => {
        void check()
      })
      const stopDecisions = this.deps.local.onChange(SITE_DECISIONS_KEY, () => {
        void check()
      })
      const timer = setTimeout(() => finish("timeout"), Math.max(0, deadline - this.deps.now()))
      signal?.addEventListener("abort", aborted, { once: true })
      if (signal?.aborted) aborted()
      void check()
    })
  }

  /**
   * Record the person's answer — called from the panel, in their click.
   * "once" grants this conversation only; "always" and "never" stand.
   */
  async answer(questionId: string, answer: SiteAnswer): Promise<void> {
    const questions = await this.questions()
    const question = questions.find((entry) => entry.id === questionId)
    if (!question) return
    if (answer === "once") await this.deps.grantOnce(question.session, question.origin)
    else await this.setDecision(question.origin, answer)
    // Every question about the same origin is settled by one standing answer.
    await this.updateQuestions((current) => ({
      questions: current.filter((entry) =>
        answer === "once" ? entry.id !== questionId : entry.origin !== question.origin
      ),
      result: undefined,
    }))
  }

  /** Drop a session's questions — when it ends or is taken over. */
  async dropQuestions(session: string, checkActive?: () => void): Promise<void> {
    await this.updateQuestions((questions) => {
      checkActive?.()
      return {
        questions: questions.filter((entry) => entry.session !== session),
        result: undefined,
      }
    })
  }
}
