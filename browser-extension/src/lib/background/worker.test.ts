import type {
  BrowserContextSubmissionSummaryV1,
  BrowserSubmissionStatus,
} from "@cognia/companion-client"

import type { AgentBrowser } from "../agent/executor"
import { PENDING_SITE_QUESTIONS_KEY } from "../agent/site-permissions"
import type { SocketLike } from "../agent/socket-client"
import { memoryStorageArea } from "../agent/storage-area"
import { SESSION_KEYS, STORAGE_KEYS } from "../browser-api"
import type { HostClient } from "../client"
import { STATUS_SNAPSHOT_KEY } from "./status-tracker"
import { STATUS_ALARM, createWorker } from "./worker"

const pairing = {
  baseUrl: "http://127.0.0.1:27891",
  tenantId: "t",
  deviceId: "d",
  extensionOrigin: "chrome-extension://x",
  pairedAt: 1,
}

function item(
  submissionId: string,
  status: BrowserSubmissionStatus,
  extra: Partial<BrowserContextSubmissionSummaryV1> = {}
): BrowserContextSubmissionSummaryV1 {
  return {
    submissionId,
    title: `Task ${submissionId}`,
    sourceHost: "example.com",
    captureMode: "metadata",
    status,
    submittedAt: 1,
    updatedAt: 1,
    deepLink: "",
    ...extra,
  }
}

const flush = async () => {
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function harness(options: { paired?: boolean; canNotify?: boolean } = {}) {
  const local = memoryStorageArea()
  const session = memoryStorageArea()
  let items: BrowserContextSubmissionSummaryV1[] = []
  let listFails = false
  const pages: Record<
    string,
    { items: BrowserContextSubmissionSummaryV1[]; nextPageToken?: string }
  > = {}
  const cancelled: string[] = []
  const badges: { text: string; tone: string }[] = []
  const notifications: { id: string; title: string; message: string }[] = []
  const alarms = new Set<string>()
  const sockets: string[] = []
  const client = {
    list: jest.fn(async (options: { pageToken?: string } = {}) => {
      if (listFails) throw new Error("offline")
      if (options.pageToken) return pages[options.pageToken] ?? { items: [] }
      return pages.first ?? { items }
    }),
    cancel: jest.fn(async (id: string) => {
      cancelled.push(id)
      return {}
    }),
    socketTicket: jest.fn(async () => ({ ticket: "tk", expiresIn: 30 })),
    invalidate: jest.fn(),
  } as unknown as HostClient
  if (options.paired !== false) void local.set(STORAGE_KEYS.pairing, pairing)
  const worker = createWorker({
    local,
    session,
    loadClient: async () => client,
    browser: { message: (key: string) => key, run: async () => true } as unknown as AgentBrowser,
    createSocket: (url) => {
      sockets.push(url)
      return {
        readyState: 0,
        send: () => undefined,
        close: () => undefined,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      } satisfies SocketLike
    },
    setBadge: async (badge) => {
      badges.push(badge)
    },
    canNotify: async () => options.canNotify ?? true,
    notify: async (id, title, message) => {
      notifications.push({ id, title, message })
    },
    ensureAlarm: async (name) => {
      alarms.add(name)
    },
    clearAlarm: async (name) => {
      alarms.delete(name)
    },
    extensionVersion: "1.0.0",
    message: (key, subs) => (subs ? `${key}(${subs.join(",")})` : key),
    now: () => 5_000,
    random: () => 0.5,
    newId: () => "q1",
    sleep: async () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
  })
  return {
    worker,
    local,
    session,
    client,
    cancelled,
    badges,
    notifications,
    alarms,
    sockets,
    pages,
    setItems: (next: BrowserContextSubmissionSummaryV1[]) => {
      items = next
    },
    failList: (fail: boolean) => {
      listFails = fail
    },
  }
}

describe("createWorker", () => {
  it("does nothing on the network while unpaired, and clears the badge", async () => {
    const h = harness({ paired: false })
    await h.worker.start()
    expect(h.client.list).not.toHaveBeenCalled()
    expect(h.badges.at(-1)).toEqual({ text: "", tone: "none" })
    expect(h.alarms.size).toBe(0)
    expect(h.sockets).toEqual([])
  })

  it("polls while work is running with the panel closed, and opens the socket for hints", async () => {
    const h = harness()
    h.setItems([item("a", "running"), item("b", "needs_input")])
    await h.worker.start()
    await flush()
    expect(h.badges.at(-1)).toEqual({ text: "2", tone: "attention" })
    expect(h.alarms.has(STATUS_ALARM)).toBe(true)
    expect(h.sockets).toEqual(["ws://127.0.0.1:27891/ws/browser-companion?ticket=tk"])

    h.setItems([item("a", "completed"), item("b", "completed")])
    await h.worker.onAlarm(STATUS_ALARM)
    expect(h.alarms.has(STATUS_ALARM)).toBe(false)
    expect(h.badges.at(-1)).toEqual({ text: "", tone: "none" })
  })

  it("notifies transitions only when allowed and the panel is closed", async () => {
    const h = harness()
    await h.local.set(STORAGE_KEYS.preferences, { notifications: true })
    h.setItems([item("a", "running")])
    await h.worker.start()
    h.setItems([item("a", "completed")])
    await h.worker.onAlarm(STATUS_ALARM)
    expect(h.notifications).toEqual([
      { id: "cognia:submission:a", title: "notifyCompleted", message: "Task a" },
    ])

    h.worker.panelOpened()
    h.setItems([item("a", "completed"), item("b", "needs_input")])
    await h.worker.refreshNow()
    expect(h.notifications).toHaveLength(1)
  })

  it("stays quiet without the notifications preference or permission", async () => {
    const off = harness()
    off.setItems([item("a", "running")])
    await off.worker.start()
    off.setItems([item("a", "failed")])
    await off.worker.onAlarm(STATUS_ALARM)
    expect(off.notifications).toEqual([])

    const denied = harness({ canNotify: false })
    await denied.local.set(STORAGE_KEYS.preferences, { notifications: true })
    denied.setItems([item("a", "running")])
    await denied.worker.start()
    denied.setItems([item("a", "failed")])
    await denied.worker.onAlarm(STATUS_ALARM)
    expect(denied.notifications).toEqual([])
  })

  it("keeps the alarm and the badge when the Host is unreachable", async () => {
    const h = harness()
    h.setItems([item("a", "running")])
    await h.worker.start()
    const badges = h.badges.length
    h.failList(true)
    await h.worker.onAlarm(STATUS_ALARM)
    expect(h.alarms.has(STATUS_ALARM)).toBe(true)
    expect(h.badges).toHaveLength(badges)
  })

  it("leaves polling to an open panel and resumes it when the panel closes", async () => {
    const h = harness()
    h.setItems([item("a", "running")])
    await h.worker.start()
    h.worker.panelOpened()
    await flush()
    expect(h.alarms.has(STATUS_ALARM)).toBe(false)
    h.worker.panelClosed()
    await flush()
    expect(h.alarms.has(STATUS_ALARM)).toBe(true)
  })

  it("shows ! for a waiting site decision", async () => {
    const h = harness()
    await h.worker.start()
    await h.session.set(PENDING_SITE_QUESTIONS_KEY, [
      { id: "q", session: "s", origin: "https://a.test", operation: "act", askedAt: 1 },
    ])
    await h.worker.onQuestionsChange()
    expect(h.badges.at(-1)).toEqual({ text: "!", tone: "attention" })
  })

  it("keeps the socket while agent mode is on, and drops it when nothing wants it", async () => {
    const h = harness()
    await h.worker.start()
    await flush()
    expect(h.sockets).toHaveLength(0)
    await h.worker.onLocalChange(STORAGE_KEYS.preferences, { agentMode: true })
    await flush()
    expect(h.sockets).toHaveLength(1)
    await h.worker.onLocalChange(STORAGE_KEYS.preferences, { agentMode: false })
    expect(await h.session.get(SESSION_KEYS.socketState)).toEqual({ kind: "stopped" })
  })

  it("forgets the old Host when the pairing changes", async () => {
    const h = harness()
    await h.worker.start()
    await h.session.set(STATUS_SNAPSHOT_KEY, { primed: true, statuses: { a: "running" } })
    await h.local.set(STORAGE_KEYS.pairing, { ...pairing, deviceId: "d2" })
    await h.worker.onLocalChange(STORAGE_KEYS.pairing, null)
    expect(h.client.invalidate).toHaveBeenCalled()
    expect(await h.session.get(STATUS_SNAPSHOT_KEY)).toEqual({ primed: true, statuses: {} })
    await h.local.remove(STORAGE_KEYS.pairing)
    await h.worker.onLocalChange(STORAGE_KEYS.pairing, null)
    expect(h.worker.state().paired).toBe(false)
  })

  it("cancels the conversation's live task when the bar's Stop is pressed, searching a second page", async () => {
    const h = harness()
    h.pages.first = { items: [item("old", "completed", { sessionId: "s1" })], nextPageToken: "50" }
    h.pages["50"] = { items: [item("live", "running", { sessionId: "s1" })] }
    await h.worker.start()
    await h.worker.runtime.sessions.updateSession("s1", 5_000, (s) => ({ ...s, tabIds: [3] }))
    await h.worker.runtime.control(
      { kind: "cognia-agent-control", session: "s1", action: "stop" },
      3
    )
    expect(h.cancelled).toEqual(["live"])
  })

  it("reads notification ids back", () => {
    const h = harness()
    expect(h.worker.notificationTarget("cognia:submission:a:b")).toEqual({
      kind: "submission",
      id: "a:b",
    })
    expect(h.worker.notificationTarget("cognia:site:q1")).toEqual({ kind: "site", id: "q1" })
    expect(h.worker.notificationTarget("other")).toBeNull()
    expect(h.worker.notificationTarget("cognia:weird:x")).toBeNull()
  })
})
