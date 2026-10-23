/**
 * The agent, assembled for the service worker (ADR-0228 §6–7).
 *
 * One place joins the stores, the site decisions and the executor, and owns
 * what arrives from outside an operation frame: the person pressing Stop /
 * Take over / Resume on the in-page bar, a page opening a link in a new tab
 * while the agent acts in it, and the browser closing a tab.
 *
 * Messages are trusted only as far as their sender: a control for a
 * conversation is honoured only from a tab that conversation holds, so one
 * page cannot stop or resume the agent in another.
 */
import { createAgentExecutor, GROUP_TITLE, type AgentBrowser } from "./executor"
import { pageActingBar } from "./page-functions"
import { AgentOperationError, operationBudgetMs, type AgentOperation } from "./protocol"
import { SessionStore, sessionForTab, withTab, withoutTab, type AgentSession } from "./sessions"
import { SitePermissions, type SiteQuestion } from "./site-permissions"
import type { StorageArea } from "./storage-area"

export interface AgentRuntimeDeps {
  browser: AgentBrowser
  /** `chrome.storage.local`: standing site decisions. */
  local: StorageArea
  /** `chrome.storage.session`: conversations and pending questions. */
  session: StorageArea
  now: () => number
  sleep: (ms: number) => Promise<void>
  newId: () => string
  onQuestion: (question: SiteQuestion) => void
  /** Cancel the Host task acting in this conversation (Stop on the bar). */
  cancelConversation: (sessionId: string) => Promise<void>
}

export type AgentControlAction = "stop" | "takeover" | "resume"

export interface AgentControlMessage {
  kind: "cognia-agent-control"
  session: string
  action: AgentControlAction
}

export interface AgentOpenTabMessage {
  kind: "cognia-agent-open-tab"
  url: string
}

export function isAgentControlMessage(value: unknown): value is AgentControlMessage {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.kind === "cognia-agent-control" &&
    typeof record.session === "string" &&
    (record.action === "stop" || record.action === "takeover" || record.action === "resume")
  )
}

export function isAgentOpenTabMessage(value: unknown): value is AgentOpenTabMessage {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return record.kind === "cognia-agent-open-tab" && typeof record.url === "string"
}

/**
 * The conversations and the site decisions over two storage areas, wired so a
 * once-grant is recorded on the conversation. The worker is the sole writer;
 * the panel sends its permission decisions back to that worker.
 */
export function createAgentStores(deps: {
  local: StorageArea
  session: StorageArea
  now: () => number
  newId: () => string
  onQuestion: (question: SiteQuestion) => void
}) {
  const { now } = deps
  const sessions = new SessionStore(deps.session)
  const permissions = new SitePermissions({
    local: deps.local,
    session: deps.session,
    now,
    newId: deps.newId,
    onQuestion: deps.onQuestion,
    hasOnce: async (sessionId, origin) =>
      ((await sessions.get(sessionId))?.onceOrigins ?? []).includes(origin),
    grantOnce: async (sessionId, origin) => {
      await sessions.updateSession(sessionId, now(), (current) => ({
        ...current,
        onceOrigins: current.onceOrigins.includes(origin)
          ? current.onceOrigins
          : [...current.onceOrigins, origin],
      }))
    },
  })
  return { sessions, permissions }
}

export function createAgentRuntime(deps: AgentRuntimeDeps) {
  const { browser, now } = deps
  const { sessions, permissions } = createAgentStores(deps)
  const pending = new Map<AbortController, string>()
  // Close the gap between the control click and its asynchronous storage write.
  const pausing = new Set<string>()
  const controls = new Map<string, Promise<unknown>>()
  const pauseRequests = new Map<string, number>()
  function cancelSession(sessionId: string, code: string) {
    for (const [controller, session] of pending) {
      if (session === sessionId)
        controller.abort(new AgentOperationError(code, "The person stopped browser execution"))
    }
  }

  function barState(current: AgentSession) {
    return {
      session: current.id,
      takenOver: current.takeover,
      labels: {
        acting: browser.message("agentBarActing"),
        paused: browser.message("agentBarPaused"),
        stop: browser.message("agentBarStop"),
        takeOver: browser.message("agentBarTakeOver"),
        resume: browser.message("agentBarResume"),
      },
    }
  }

  async function paintBars(current: AgentSession, visible: boolean) {
    for (const tabId of current.tabIds) {
      await browser
        .run(tabId, "ISOLATED", pageActingBar, [visible ? barState(current) : null])
        .catch(() => undefined)
    }
  }

  /** Whether `tabId` belongs to the conversation the message names. */
  async function owns(sessionId: string, tabId: number | undefined): Promise<AgentSession | null> {
    if (tabId === undefined) return null
    const current = await sessions.get(sessionId)
    return current && current.tabIds.includes(tabId) ? current : null
  }

  return {
    sessions,
    permissions,

    async execute(
      operation: AgentOperation,
      args: Record<string, unknown>,
      deadlineMs: number,
      signal?: AbortSignal
    ) {
      signal?.throwIfAborted()
      if (typeof args.session === "string" && pausing.has(args.session)) {
        throw new AgentOperationError(
          "browser_user_takeover",
          "The person paused browser execution"
        )
      }
      const controller = new AbortController()
      const budget = operationBudgetMs(deadlineMs)
      const expiresAt = now() + budget
      const checkActive = () => {
        if (now() >= expiresAt)
          controller.abort(
            new AgentOperationError(
              "browser_operation_timeout",
              "The browser operation deadline expired"
            )
          )
        controller.signal.throwIfAborted()
      }
      const abort = () => controller.abort(signal?.reason)
      signal?.addEventListener("abort", abort, { once: true })
      pending.set(controller, typeof args.session === "string" ? args.session : "")
      try {
        const executor = createAgentExecutor({
          browser,
          sessions,
          permissions,
          now,
          sleep: deps.sleep,
          signal: controller.signal,
          checkActive,
        })
        const value = await executor.execute(operation, args, budget)
        checkActive()
        return value
      } finally {
        signal?.removeEventListener("abort", abort)
        pending.delete(controller)
      }
    },

    /** The in-page bar's buttons. Answers whether the message was honoured. */
    control(message: AgentControlMessage, senderTabId: number | undefined): Promise<boolean> {
      let registeredPause = false
      let persistedPause = false
      const verified = owns(message.session, senderTabId).then((current) => {
        if (current && message.action !== "resume") {
          registeredPause = true
          pauseRequests.set(current.id, (pauseRequests.get(current.id) ?? 0) + 1)
          pausing.add(current.id)
          cancelSession(
            current.id,
            message.action === "stop" ? "browser_operation_cancelled" : "browser_user_takeover"
          )
        }
        return current
      })
      // Preserve click order through storage, bar painting and Stop cleanup.
      // A newer Resume must not expose work to an older Stop's cleanup.
      const run = (controls.get(message.session) ?? Promise.resolve())
        .then(async () => {
          const current = await verified
          if (!current) return false
          switch (message.action) {
            case "stop": {
              const next = await sessions.updateSession(current.id, now(), (s) => ({
                ...s,
                takeover: true,
              }))
              persistedPause = true
              // Keep Resume available; delayed Host frames cannot restart a stopped turn.
              await paintBars(next, true)
              await permissions.dropQuestions(current.id)
              await deps.cancelConversation(current.id)
              return true
            }
            case "takeover": {
              const next = await sessions.updateSession(current.id, now(), (s) => ({
                ...s,
                takeover: true,
              }))
              persistedPause = true
              // Nothing will act until the person resumes, so nothing should be
              // waiting on their answer either.
              await permissions.dropQuestions(current.id)
              await paintBars(next, true)
              return true
            }
            case "resume": {
              const next = await sessions.updateSession(current.id, now(), (s) => ({
                ...s,
                takeover: false,
              }))
              if (!pauseRequests.has(current.id)) pausing.delete(current.id)
              await paintBars(next, true)
              return true
            }
          }
        })
        .finally(() => {
          if (!registeredPause) return
          const remaining = (pauseRequests.get(message.session) ?? 1) - 1
          if (remaining > 0) pauseRequests.set(message.session, remaining)
          else {
            pauseRequests.delete(message.session)
            if (persistedPause) pausing.delete(message.session)
          }
        })
      const tail = run.catch(() => undefined)
      controls.set(message.session, tail)
      void tail.then(() => {
        if (controls.get(message.session) === tail) controls.delete(message.session)
      })
      return run
    },

    /**
     * A page the agent is acting in opened a link in a new tab. It opens — it
     * is the person's page, and the link would have opened anyway — in the
     * background, inside the conversation's group, so the agent can find it
     * with `list_pages` without it stealing the person's view.
     */
    async openTab(message: AgentOpenTabMessage, senderTabId: number | undefined): Promise<boolean> {
      if (senderTabId === undefined) return false
      const current = sessionForTab(await sessions.all(), senderTabId)
      if (!current) return false
      let url: URL
      try {
        url = new URL(message.url)
      } catch {
        return false
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return false
      const tab = await browser.createTab({
        url: url.toString(),
        active: false,
        ...(current.windowId !== null ? { windowId: current.windowId } : {}),
      })
      const keepActive = current.activeTabId
      const next = await sessions.updateSession(current.id, now(), (s) => ({
        ...withTab(s, tab.id, { owned: true, windowId: tab.windowId }),
        // A tab the page opened is not where the agent was working.
        activeTabId: keepActive,
      }))
      try {
        const groupId = await browser.group([tab.id], next.groupId, next.windowId ?? tab.windowId)
        if (next.groupId !== groupId) {
          await browser.styleGroup(groupId, GROUP_TITLE)
          await sessions.updateSession(current.id, now(), (s) => ({ ...s, groupId }))
        }
      } catch {
        // Another window; the tab still belongs to the conversation.
      }
      return true
    },

    /** The browser closed a tab; forget it wherever it was held. */
    async tabRemoved(tabId: number): Promise<void> {
      await sessions.update((all) => {
        let changed = false
        const next = { ...all }
        for (const [id, current] of Object.entries(all)) {
          if (current.tabIds.includes(tabId)) {
            next[id] = withoutTab(current, tabId)
            changed = true
          }
        }
        return { sessions: changed ? next : all, result: undefined }
      })
    },

    /** Whether any conversation is holding tabs — the socket is wanted then. */
    async hasSessions(): Promise<boolean> {
      return Object.keys(await sessions.all()).length > 0
    },
  }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>
