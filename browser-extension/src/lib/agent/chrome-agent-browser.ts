/**
 * The real `chrome.*` behind {@link AgentBrowser} and {@link StorageArea}.
 *
 * Like `chrome-browser-api.ts` for capture, this is the one file in the agent
 * that touches the extension APIs, so everything an agent can make this
 * browser do is readable in one place:
 *
 *  - `tabs` + `tabGroups`: open, focus, navigate and close tabs, and keep a
 *    conversation's tabs in one "Cognia" group.
 *  - `scripting` (needs the optional `<all_urls>` host grant agent mode asks
 *    for): inject the overlay and the page hooks, and run page functions.
 *  - `tabs.captureVisibleTab`: screenshots.
 *  - `downloads` and `cookies`: optional permissions, each asked for in the
 *    panel's settings; until granted those operations refuse.
 */
import type { AgentBrowser, AgentTab, CookieRecord, DownloadRecord, ScriptWorld } from "./executor"
import { browserImageOps } from "./image-ops"
import type { StorageArea } from "./storage-area"

function toTab(tab: chrome.tabs.Tab): AgentTab {
  return {
    id: tab.id ?? -1,
    windowId: tab.windowId,
    // `pendingUrl` is what a tab that has not committed yet is loading.
    url: tab.url || tab.pendingUrl || "",
    title: tab.title ?? "",
    status: tab.status === "loading" || tab.status === "unloaded" ? tab.status : "complete",
    active: tab.active,
    groupId: tab.groupId,
  }
}

function toMillis(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

export function toDownloadRecord(item: chrome.downloads.DownloadItem): DownloadRecord {
  return {
    id: item.id,
    url: item.finalUrl || item.url,
    filename: item.filename,
    mime: item.mime,
    startTime: toMillis(item.startTime) ?? 0,
    ...(toMillis(item.endTime) !== undefined ? { endTime: toMillis(item.endTime)! } : {}),
    state: item.state as DownloadRecord["state"],
    ...(item.error ? { error: item.error } : {}),
    bytesReceived: item.bytesReceived,
    totalBytes: item.totalBytes,
    fileSize: item.fileSize,
    exists: item.exists,
  }
}

/** The URL `chrome.cookies.remove` needs to address one cookie. */
export function cookieUrl(cookie: Pick<CookieRecord, "domain" | "path" | "secure">): string {
  const host = cookie.domain.replace(/^\./, "")
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`
}

export function createChromeAgentBrowser(): AgentBrowser {
  const image = browserImageOps()
  return {
    async getTab(tabId) {
      const tab = await chrome.tabs.get(tabId).catch(() => null)
      return tab ? toTab(tab) : null
    },

    async createTab({ url, windowId, active }) {
      const tab = await chrome.tabs.create({
        url,
        active,
        ...(windowId !== undefined ? { windowId } : {}),
      })
      return toTab(tab)
    },

    async updateTab(tabId, input) {
      const tab = await chrome.tabs.update(tabId, input).catch(() => null)
      return tab ? toTab(tab) : null
    },

    async removeTab(tabId) {
      await chrome.tabs.remove(tabId)
    },

    goBack: (tabId) => chrome.tabs.goBack(tabId),
    goForward: (tabId) => chrome.tabs.goForward(tabId),
    reload: (tabId) => chrome.tabs.reload(tabId),

    async group(tabIds, groupId, windowId, checkActive) {
      checkActive?.()
      const [first, ...rest] = tabIds
      if (first === undefined) throw new Error("no tabs to group")
      const ids: [number, ...number[]] = [first, ...rest]
      if (groupId !== null) {
        // The group may have been dissolved by the person; start a new one.
        const exists = await chrome.tabGroups.get(groupId).then(
          () => true,
          () => false
        )
        checkActive?.()
        if (exists) return chrome.tabs.group({ tabIds: ids, groupId })
      }
      return chrome.tabs.group({
        tabIds: ids,
        ...(windowId !== null ? { createProperties: { windowId } } : {}),
      })
    },

    async styleGroup(groupId, title) {
      await chrome.tabGroups.update(groupId, { title, color: "blue" })
    },

    async ungroup(tabIds) {
      const [first, ...rest] = tabIds
      if (first === undefined) return
      await chrome.tabs.ungroup([first, ...rest])
    },

    async injectFile(tabId, file, world: ScriptWorld) {
      await chrome.scripting.executeScript({ target: { tabId }, files: [file], world })
    },

    async run(tabId, world, func, args) {
      const [injected] = await chrome.scripting.executeScript({
        target: { tabId },
        world,
        func: func as never,
        args: args as never,
      })
      return injected?.result as never
    },

    captureVisible: (windowId) => chrome.tabs.captureVisibleTab(windowId, { format: "png" }),

    setZoom: (tabId, zoom) => chrome.tabs.setZoom(tabId, zoom),
    getZoom: (tabId) => chrome.tabs.getZoom(tabId),

    hasPermission: (request) =>
      chrome.permissions.contains(request as chrome.permissions.Permissions),

    async searchDownloads(startedAfter) {
      // `startedAfter` is exclusive and an ISO string; one millisecond earlier
      // keeps a download started in the same millisecond as the conversation.
      const items = await chrome.downloads.search({
        startedAfter: new Date(startedAfter - 1).toISOString(),
        orderBy: ["-startTime"],
      })
      return items.map(toDownloadRecord)
    },

    cancelDownload: (id) => chrome.downloads.cancel(id),

    async deleteDownload(id, checkActive) {
      checkActive?.()
      const [item] = await chrome.downloads.search({ id })
      checkActive?.()
      if (item?.state === "in_progress") await chrome.downloads.cancel(id)
      checkActive?.()
      // The file first, then the history entry; removing a file that is
      // already gone is not an error worth reporting.
      if (item?.exists && item.state === "complete")
        await chrome.downloads.removeFile(id).catch(() => undefined)
      checkActive?.()
      await chrome.downloads.erase({ id })
    },

    async getCookies(domain) {
      const cookies = await chrome.cookies.getAll({ domain })
      return cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        ...(cookie.expirationDate !== undefined ? { expirationDate: cookie.expirationDate } : {}),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
        storeId: cookie.storeId,
      }))
    },

    async removeCookie(cookie) {
      await chrome.cookies.remove({
        url: cookieUrl(cookie),
        name: cookie.name,
        storeId: cookie.storeId,
      })
    },

    image,

    message: (key) => chrome.i18n.getMessage(key) || key,
  }
}

/** One `chrome.storage` area as a {@link StorageArea}. */
export function chromeStorageArea(areaName: "local" | "session"): StorageArea {
  const area = chrome.storage[areaName]
  return {
    async get<T>(key: string) {
      const stored = await area.get(key)
      return (stored[key] as T | undefined) ?? null
    },
    async set(key, value) {
      await area.set({ [key]: value })
    },
    async remove(key) {
      await area.remove(key)
    },
    onChange(key, listener) {
      const handler = (changes: Record<string, chrome.storage.StorageChange>, changed: string) => {
        if (changed !== areaName || !Object.hasOwn(changes, key)) return
        listener(changes[key]?.newValue ?? null)
      }
      chrome.storage.onChanged.addListener(handler)
      return () => chrome.storage.onChanged.removeListener(handler)
    },
  }
}
