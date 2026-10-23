/**
 * The service worker's job, as one testable unit (ADR-0228 §4–7).
 *
 * The worker used to do almost nothing, because MV3 reclaims it at will. It
 * now owns three things only a worker can:
 *
 *  - **Status while the panel is closed.** A one-minute `chrome.alarms` poll
 *    while any task can still change on its own, plus the device socket's
 *    hints when it is open; the toolbar badge, and opt-in notifications.
 *  - **The device socket**, open while something wants it: agent mode, a
 *    conversation holding tabs, or an open panel.
 *  - **The agent**: operation frames, the in-page bar's buttons, new-tab
 *    links and closed tabs.
 *
 * Everything it must remember across wake-ups is in `chrome.storage`; the
 * module state here is a cache that `start()` rebuilds.
 */
import {
  isTerminalBrowserSubmissionStatus,
  type BrowserContextSubmissionSummaryV1,
} from "@cognia/companion-client"
import { AGENT_PROFILE } from "../agent/protocol"

import { createAgentRuntime, type AgentRuntime } from "../agent/agent-runtime"
import type { AgentBrowser } from "../agent/executor"
import {
  PENDING_SITE_QUESTIONS_KEY,
  type SiteQuestion,
  type AgentPermissionMessage,
} from "../agent/site-permissions"
import {
  browserCompanionSocketUrl,
  createSocketClient,
  type SocketClient,
  type SocketLike,
  type SocketState,
} from "../agent/socket-client"
import type { StorageArea } from "../agent/storage-area"
import { SESSION_KEYS, STORAGE_KEYS } from "../browser-api"
import type { HostClient, PairingRecord } from "../client"
import { parsePreferences, type ExtensionPreferences } from "../preferences"
import {
  EMPTY_SNAPSHOT,
  STATUS_SNAPSHOT_KEY,
  badgeFor,
  countStatuses,
  diffStatuses,
  notificationMessageKey,
  shouldKeepPolling,
  type Badge,
  type StatusSnapshot,
} from "./status-tracker"

export const STATUS_ALARM = "cognia-status-poll"
export { PANEL_PORT } from "../browser-api"
export const STATUS_POLL_MINUTES = 1
/** Rows read per status poll; the badge counts within the newest of them. */
export const STATUS_PAGE_SIZE = 50
/** Notification ids carry what they are about, so a click knows where to go. */
export const NOTIFICATION_PREFIX = "cognia:"

export interface WorkerDeps {
  local: StorageArea
  session: StorageArea
  /** The paired Host's client, or null when this browser is not paired. */
  loadClient(pairing: PairingRecord): Promise<HostClient | null>
  browser: AgentBrowser
  createSocket(url: string): SocketLike
  setBadge(badge: Badge): Promise<void>
  /** Whether the optional `notifications` permission is granted. */
  canNotify(): Promise<boolean>
  notify(id: string, title: string, message: string): Promise<void>
  ensureAlarm(name: string, periodMinutes: number): Promise<void>
  clearAlarm(name: string): Promise<void>
  extensionVersion: string
  panelUrl: string
  message(key: string, substitutions?: string[]): string
  now(): number
  random(): number
  newId(): string
  sleep(ms: number): Promise<void>
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

/** What the hello tells the Host this build implements. */
export const EXTENSION_FEATURES = [AGENT_PROFILE, "status-hints-v1"]

export function createWorker(deps: WorkerDeps) {
  let pairing: PairingRecord | null = null
  let client: HostClient | null = null
  let preferences: ExtensionPreferences = parsePreferences(null)
  let panelPorts = 0
  let keepPolling = false
  let refreshing: Promise<void> | null = null
  let refreshAgain = false
  let permissionChanges: Promise<unknown> = Promise.resolve()

  const runtime: AgentRuntime = createAgentRuntime({
    browser: deps.browser,
    local: deps.local,
    session: deps.session,
    now: deps.now,
    sleep: deps.sleep,
    newId: deps.newId,
    onQuestion: (question) => void announceQuestion(question),
    cancelConversation: (sessionId) => cancelConversation(sessionId),
  })

  const socket: SocketClient = createSocketClient({
    issueTicket: async () => {
      if (!client) throw Object.assign(new Error("not paired"), { code: "not_paired" })
      return (await client.socketTicket()).ticket
    },
    socketUrl: (ticket) => browserCompanionSocketUrl(pairing?.baseUrl ?? "", ticket),
    createSocket: deps.createSocket,
    execute: (operation, args, deadlineMs, signal) =>
      runtime.execute(operation, args, deadlineMs, signal),
    canExecute: () => preferences.agentMode,
    extensionVersion: deps.extensionVersion,
    features: EXTENSION_FEATURES,
    onStatusHint: () => {
      void deps.session.set(SESSION_KEYS.statusHint, deps.now())
      void refreshStatus()
    },
    onDrive: () => undefined,
    onState: (state: SocketState) => {
      void deps.session.set(SESSION_KEYS.socketState, state)
    },
    now: deps.now,
    random: deps.random,
    setTimeout: deps.setTimeout,
    clearTimeout: deps.clearTimeout,
    setInterval: deps.setInterval,
    clearInterval: deps.clearInterval,
  })

  async function questionCount(): Promise<number> {
    return ((await deps.session.get<SiteQuestion[]>(PENDING_SITE_QUESTIONS_KEY)) ?? []).length
  }

  async function wantsNotification(): Promise<boolean> {
    return preferences.notifications && (await deps.canNotify())
  }

  async function announceQuestion(question: SiteQuestion): Promise<void> {
    await refreshBadgeOnly()
    if (!(await wantsNotification())) return
    const host = (() => {
      try {
        return new URL(question.origin).host
      } catch {
        return question.origin
      }
    })()
    await deps
      .notify(
        `${NOTIFICATION_PREFIX}site:${question.id}`,
        deps.message("notifySiteQuestionTitle"),
        deps.message("notifySiteQuestion", [host])
      )
      .catch(() => undefined)
  }

  let lastCounts = { running: 0, needsInput: 0 }

  async function refreshBadgeOnly(): Promise<void> {
    await deps.setBadge(badgeFor(lastCounts, await questionCount())).catch(() => undefined)
  }

  async function readStatus(): Promise<void> {
    if (!client) {
      lastCounts = { running: 0, needsInput: 0 }
      keepPolling = false
      await refreshBadgeOnly()
      return
    }
    let items: BrowserContextSubmissionSummaryV1[]
    try {
      items = (await client.list({ limit: STATUS_PAGE_SIZE })).items
    } catch {
      // Host down or unreachable: keep the alarm, so the badge recovers when
      // it is back, and leave the last badge rather than blanking it.
      keepPolling = true
      return
    }
    lastCounts = countStatuses(items)
    keepPolling = shouldKeepPolling(items)
    await refreshBadgeOnly()

    const snapshot = (await deps.session.get<StatusSnapshot>(STATUS_SNAPSHOT_KEY)) ?? EMPTY_SNAPSHOT
    const { transitions, next } = diffStatuses(snapshot, items)
    await deps.session.set(STATUS_SNAPSHOT_KEY, next)
    // The open panel shows these itself; a notification on top is noise.
    if (transitions.length === 0 || panelPorts > 0 || !(await wantsNotification())) return
    for (const transition of transitions) {
      await deps
        .notify(
          `${NOTIFICATION_PREFIX}submission:${transition.item.submissionId}`,
          deps.message(notificationMessageKey(transition.to)),
          transition.item.title || transition.item.sourceHost
        )
        .catch(() => undefined)
    }
  }

  /** One read at a time; a hint during a read schedules exactly one more. */
  function refreshStatus(): Promise<void> {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      try {
        do {
          refreshAgain = false
          await readStatus()
        } while (refreshAgain)
        await reconcile()
      } finally {
        refreshing = null
      }
    })()
    return refreshing
  }

  /** Start or stop the alarm and the socket to match what is wanted now. */
  async function reconcile(): Promise<void> {
    // The alarm covers the panel-closed case only; an open panel polls itself.
    if (client && keepPolling && panelPorts === 0) {
      await deps.ensureAlarm(STATUS_ALARM, STATUS_POLL_MINUTES)
    } else {
      await deps.clearAlarm(STATUS_ALARM)
    }
    const wanted =
      client !== null &&
      (preferences.agentMode || panelPorts > 0 || keepPolling || (await runtime.hasSessions()))
    if (wanted) socket.start()
    else socket.stop()
  }

  async function loadPairing(): Promise<void> {
    const next = await deps.local.get<PairingRecord>(STORAGE_KEYS.pairing)
    const changed =
      (next?.deviceId ?? null) !== (pairing?.deviceId ?? null) ||
      (next?.baseUrl ?? null) !== (pairing?.baseUrl ?? null)
    if (!changed && (client || !next)) return
    client?.invalidate()
    socket.stop()
    pairing = next
    client = next ? await deps.loadClient(next).catch(() => null) : null
    await deps.session.set(STATUS_SNAPSHOT_KEY, EMPTY_SNAPSHOT)
  }

  /**
   * Stop on the in-page bar: cancel the Host task acting in that conversation.
   * The list is the only index from conversation to submission this device
   * may read, so the newest non-terminal match is the one acting.
   */
  async function cancelConversation(sessionId: string): Promise<void> {
    if (!client) return
    let pageToken: string | undefined
    for (let page = 0; page < 2; page++) {
      const result = await client
        .list({ limit: 50, ...(pageToken ? { pageToken } : {}) })
        .catch(() => null)
      if (!result) return
      const match = result.items.find(
        (item) => item.sessionId === sessionId && !isTerminalBrowserSubmissionStatus(item.status)
      )
      if (match) {
        await client.cancel(match.submissionId).catch(() => undefined)
        void refreshStatus()
        return
      }
      if (!result.nextPageToken) return
      pageToken = result.nextPageToken
    }
  }

  return {
    runtime,
    socket,

    onPermissionMessage(
      message: AgentPermissionMessage,
      senderUrl: string | undefined
    ): Promise<boolean> {
      // Extension content scripts share runtime.id, so require the actual panel URL.
      if (senderUrl?.split(/[?#]/)[0] !== deps.panelUrl) return Promise.resolve(false)
      const run = permissionChanges.then(async () => {
        if (message.action === "answer")
          await runtime.permissions.answer(message.questionId, message.answer)
        else await runtime.permissions.setDecision(message.origin, null)
        return true
      })
      permissionChanges = run.catch(() => undefined)
      return run
    },

    /** Every wake-up: rebuild the cache from storage, then reconcile. */
    async start(): Promise<void> {
      preferences = parsePreferences(await deps.local.get(STORAGE_KEYS.preferences))
      await loadPairing()
      await refreshStatus()
    },

    async onAlarm(name: string): Promise<void> {
      if (name !== STATUS_ALARM) return
      await refreshStatus()
    },

    /** A local storage key changed: pairing or preferences. */
    async onLocalChange(key: string, value: unknown): Promise<void> {
      if (key === STORAGE_KEYS.preferences) {
        const before = preferences
        preferences = parsePreferences(value)
        if (!preferences.agentMode) socket.cancelOperations("browser_agent_mode_disabled")
        if (before.agentMode !== preferences.agentMode && preferences.agentMode) socket.retryNow()
        await reconcile()
      } else if (key === STORAGE_KEYS.pairing) {
        await loadPairing()
        await refreshStatus()
      }
    },

    /** Site questions changed (asked, answered, dropped): the badge follows. */
    async onQuestionsChange(): Promise<void> {
      await refreshBadgeOnly()
    },

    panelOpened(): void {
      panelPorts += 1
      void reconcile()
    },

    panelClosed(): void {
      panelPorts = Math.max(0, panelPorts - 1)
      // A fresh read now, so the alarm resumes if work is still running.
      void refreshStatus()
    },

    /** The submission a notification is about, if it is about one. */
    notificationTarget(id: string): { kind: "submission" | "site"; id: string } | null {
      if (!id.startsWith(NOTIFICATION_PREFIX)) return null
      const [kind, ...rest] = id.slice(NOTIFICATION_PREFIX.length).split(":")
      const target = rest.join(":")
      if ((kind === "submission" || kind === "site") && target) return { kind, id: target }
      return null
    },

    /** The panel asked for an immediate refresh (a submit just landed). */
    refreshNow: () => refreshStatus(),

    /** Whether the socket should be kept; exposed for tests. */
    state: () => ({ paired: client !== null, panelPorts, keepPolling, preferences }),
  }
}

export type Worker = ReturnType<typeof createWorker>
