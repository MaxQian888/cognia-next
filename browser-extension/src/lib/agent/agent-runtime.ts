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
import { type AgentOperation } from "./protocol"
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
 * once-grant is recorded on the conversation. Shared by the worker (which
 * asks) and the side panel (which answers, inside the person's click).
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
  const executor = createAgentExecutor({ browser, sessions, permissions, now, sleep: deps.sleep })

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

    execute(operation: AgentOperation, args: Record<string, unknown>, deadlineMs: number) {
      return executor.execute(operation, args, deadlineMs)
    },

    /** The in-page bar's buttons. Answers whether the message was honoured. */
    async control(message: AgentControlMessage, senderTabId: number | undefined): Promise<boolean> {
      const current = await owns(message.session, senderTabId)
      if (!current) return false
      switch (message.action) {
        case "stop": {
          // Stop cancels the turn; the tabs stay where they are for the
          // person to look at, and the bar goes because nothing is acting.
          await paintBars(current, false)
          await permissions.dropQuestions(current.id)
          await sessions.updateSession(current.id, now(), (s) => ({ ...s, takeover: false }))
          await deps.cancelConversation(current.id)
          return true
        }
        case "takeover": {
          const next = await sessions.updateSession(current.id, now(), (s) => ({
            ...s,
            takeover: true,
          }))
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
          await paintBars(next, true)
          return true
        }
      }
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
