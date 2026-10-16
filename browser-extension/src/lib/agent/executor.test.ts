import {
  GROUP_TITLE,
  OVERLAY_FILE,
  PAGE_HOOKS_FILE,
  createAgentExecutor,
  type AgentBrowser,
  type AgentTab,
  type CookieRecord,
  type DownloadRecord,
} from "./executor"
import {
  mainEvaluate,
  mainHooksCall,
  mainSetDialogPolicy,
  pageAct,
  pageActingBar,
  pageElementRect,
  pageHas,
  pageScrollMetrics,
  pageScrollTo,
  pageSnapshot,
  pageStorage,
} from "./page-functions"
import { SessionStore } from "./sessions"
import { SITE_DECISIONS_KEY, SitePermissions } from "./site-permissions"
import { memoryStorageArea } from "./storage-area"

type Handler = (tabId: number, args: unknown[]) => unknown

function harness(
  options: { decisions?: Record<string, "always" | "never">; permissions?: string[] } = {}
) {
  let clock = 10_000
  let nextTab = 100
  const tabs = new Map<number, AgentTab>()
  const injected: [number, string, string][] = []
  const removed: number[] = []
  const ungrouped: number[][] = []
  const styled: [number, string][] = []
  const captures: number[] = []
  const handlers = new Map<unknown, Handler>()
  const ran: { func: unknown; tabId: number; world: string; args: unknown[] }[] = []
  const downloads: DownloadRecord[] = []
  const cookies: CookieRecord[] = []
  const removedCookies: string[] = []
  let failInject = false

  const addTab = (tab: Partial<AgentTab> & { url: string }): AgentTab => {
    const full: AgentTab = {
      id: tab.id ?? ++nextTab,
      windowId: tab.windowId ?? 1,
      url: tab.url,
      title: tab.title ?? `title of ${tab.url}`,
      status: tab.status ?? "complete",
      active: tab.active ?? false,
      groupId: tab.groupId ?? -1,
    }
    tabs.set(full.id, full)
    return full
  }

  const browser: AgentBrowser = {
    getTab: async (id) => (tabs.has(id) ? { ...tabs.get(id)! } : null),
    createTab: async ({ url, windowId, active }) =>
      addTab({ url, windowId: windowId ?? 1, active }),
    updateTab: async (id, input) => {
      const tab = tabs.get(id)
      if (!tab) return null
      if (input.url) tab.url = input.url
      if (input.active !== undefined) tab.active = input.active
      return { ...tab }
    },
    removeTab: async (id) => {
      removed.push(id)
      tabs.delete(id)
    },
    goBack: async () => undefined,
    goForward: async () => undefined,
    reload: async () => undefined,
    group: async (ids, groupId) => {
      const id = groupId ?? 7
      for (const tabId of ids) {
        const tab = tabs.get(tabId)
        if (tab) tab.groupId = id
      }
      return id
    },
    styleGroup: async (groupId, title) => {
      styled.push([groupId, title])
    },
    ungroup: async (ids) => {
      ungrouped.push(ids)
    },
    injectFile: async (tabId, file, world) => {
      if (failInject) throw new Error("Cannot access contents of the page")
      injected.push([tabId, file, world])
    },
    run: async (tabId, world, func, args) => {
      ran.push({ func, tabId, world, args })
      const handler = handlers.get(func)
      return (handler ? handler(tabId, args) : undefined) as never
    },
    captureVisible: async () => {
      captures.push(clock)
      return "data:image/png;base64,SHOT"
    },
    setZoom: async () => undefined,
    getZoom: async () => 1.5,
    hasPermission: async (request) =>
      (request.permissions ?? []).every((permission) =>
        (options.permissions ?? []).includes(permission)
      ),
    searchDownloads: async (startedAfter) =>
      downloads.filter((item) => item.startTime >= startedAfter),
    cancelDownload: async (id) => {
      const item = downloads.find((entry) => entry.id === id)
      if (item) {
        item.state = "interrupted"
        item.error = "USER_CANCELED"
      }
    },
    deleteDownload: async () => undefined,
    getCookies: async (domain) => cookies.filter((cookie) => cookie.domain.endsWith(domain)),
    removeCookie: async (cookie) => {
      removedCookies.push(cookie.name)
    },
    image: {
      size: async () => ({ width: 800, height: 600 }),
      crop: async (_url, rect) => `crop:${rect.x},${rect.y},${rect.width},${rect.height}`,
      stitch: async (urls, width, heights) => `stitch:${urls.length}:${width}:${heights.join("+")}`,
    },
    message: (key) => `msg:${key}`,
  }

  const sessionArea = memoryStorageArea()
  const localArea = memoryStorageArea()
  void localArea.set(SITE_DECISIONS_KEY, options.decisions ?? {})
  const sessions = new SessionStore(sessionArea)
  const permissions = new SitePermissions({
    local: localArea,
    session: memoryStorageArea(),
    now: () => clock,
    newId: () => "q1",
    onQuestion: () => undefined,
    hasOnce: async (session, origin) =>
      ((await sessions.get(session))?.onceOrigins ?? []).includes(origin),
    grantOnce: async () => undefined,
  })
  const executor = createAgentExecutor({
    browser,
    sessions,
    permissions,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  })
  const run = (op: string, args: Record<string, unknown> = {}, deadlineMs = 30_000) =>
    executor.execute(op as never, { session: "s1", ...args }, deadlineMs)

  return {
    run,
    executor,
    tabs,
    addTab,
    injected,
    removed,
    ungrouped,
    styled,
    captures,
    handlers,
    ran,
    downloads,
    cookies,
    removedCookies,
    sessions,
    failInject: () => {
      failInject = true
    },
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const ALWAYS = { "https://example.com": "always" as const }

describe("createAgentExecutor", () => {
  it("opens the first page in a new, shown tab inside the Cognia group, and prepares it", async () => {
    const h = harness({ decisions: ALWAYS })
    await expect(h.run("navigate", { url: "https://example.com/a" })).resolves.toEqual({
      ok: true,
      error: null,
    })
    const [tab] = [...h.tabs.values()]
    expect(tab).toMatchObject({ url: "https://example.com/a", active: true, groupId: 7 })
    expect(h.styled).toEqual([[7, GROUP_TITLE]])
    expect(h.injected).toEqual([
      [tab!.id, OVERLAY_FILE, "ISOLATED"],
      [tab!.id, PAGE_HOOKS_FILE, "MAIN"],
    ])
    const bar = h.ran.find((call) => call.func === pageActingBar)
    expect(bar?.args[0]).toMatchObject({ session: "s1", takenOver: false })
    expect((bar?.args[0] as { labels: { stop: string } }).labels.stop).toBe("msg:agentBarStop")
    const stored = await h.sessions.get("s1")
    expect(stored).toMatchObject({
      tabIds: [tab!.id],
      ownedTabIds: [tab!.id],
      activeTabId: tab!.id,
    })
  })

  it("claims the tab the conversation started on without owning it", async () => {
    const h = harness({ decisions: ALWAYS })
    const start = h.addTab({ id: 5, url: "https://example.com/start", active: true })
    h.handlers.set(pageSnapshot, () => ({ ok: true, snapshot: { tree: "x" } }))
    await expect(h.run("snapshot", { startTabId: start.id })).resolves.toEqual({ tree: "x" })
    expect(await h.sessions.get("s1")).toMatchObject({
      tabIds: [5],
      ownedTabIds: [],
      activeTabId: 5,
    })
    // finalize closes only what it opened, and lets the claimed tab go.
    await expect(h.run("finalize_tabs")).resolves.toEqual({ closed: 0 })
    expect(h.removed).toEqual([])
    expect(h.ungrouped).toEqual([[5]])
    expect(await h.sessions.get("s1")).toBeNull()
  })

  it("does not claim a start tab that is not a web page", async () => {
    const h = harness({ decisions: ALWAYS })
    h.addTab({ id: 5, url: "chrome://settings" })
    await expect(h.run("get_page", { startTabId: 5 })).rejects.toMatchObject({
      code: "browser_page_not_found",
    })
  })

  it("refuses a site the person blocked, before touching the tab", async () => {
    const h = harness({ decisions: { "https://blocked.test": "never" } })
    await expect(h.run("navigate", { url: "https://blocked.test/" })).rejects.toMatchObject({
      code: "browser_site_blocked",
    })
    expect(h.tabs.size).toBe(0)
  })

  it("refuses non-web addresses", async () => {
    const h = harness()
    await expect(h.run("navigate", { url: "file:///etc/passwd" })).rejects.toMatchObject({
      code: "browser_page_restricted",
    })
  })

  it("waits for a decision until the deadline, then refuses", async () => {
    const h = harness()
    await expect(h.run("navigate", { url: "https://new.test/" }, 1_000)).rejects.toMatchObject({
      code: "browser_site_permission_required",
    })
  })

  it("refuses everything but reads while the person has taken over", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    await h.sessions.updateSession("s1", 0, (s) => ({ ...s, takeover: true }))
    await expect(h.run("act", { ref: "r1", action: "click" })).rejects.toMatchObject({
      code: "browser_user_takeover",
    })
    await expect(h.run("get_page")).resolves.toMatchObject({ url: "https://example.com/" })
  })

  it("reports a dialog the action raised, answered without blocking", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    let dialogs = 0
    h.handlers.set(mainHooksCall, (_tab, [method]) =>
      method === "lastDialog"
        ? dialogs === 0
          ? null
          : { type: "confirm", message: "Sure?", at: 1 }
        : null
    )
    h.handlers.set(pageAct, (_tab, args) => {
      dialogs += 1
      return { ok: true, args }
    })
    const outcome = await h.run("act", {
      ref: "r1",
      action: "click",
      args: { modifiers: ["Shift"] },
    })
    expect(outcome).toMatchObject({
      ok: true,
      args: ["r1", "click", '{"modifiers":["Shift"]}'],
      dialogPending: false,
      dialog: { type: "confirm", message: "Sure?", defaultValue: "" },
    })
  })

  it("maps press_key, scroll and handle_dialog onto the page", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    h.handlers.set(pageAct, (_tab, args) => ({ args }))
    await expect(h.run("press_key", { key: "Enter" })).resolves.toEqual({
      args: ["", "key", '{"key":"Enter"}'],
    })
    // The frame's own `session` and `startTabId` are not scroll arguments.
    await expect(h.run("scroll", { reference: "r2", deltaY: 300, startTabId: 1 })).resolves.toEqual(
      {
        args: ["r2", "scroll", '{"deltaY":300}'],
      }
    )
    await h.run("handle_dialog", { accept: true, promptText: "yes" })
    expect(h.ran.find((call) => call.func === mainSetDialogPolicy)?.args).toEqual([
      { accept: true, promptText: "yes" },
    ])
  })

  it("runs evaluate in the page's own world", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    h.handlers.set(mainEvaluate, (_tab, [expression]) => ({ ok: true, value: expression }))
    await expect(h.run("evaluate", { expression: "1+1" })).resolves.toEqual({
      ok: true,
      value: "1+1",
    })
    expect(h.ran.find((call) => call.func === mainEvaluate)?.world).toBe("MAIN")
  })

  it("says why a page cannot be reached", async () => {
    const h = harness({ decisions: ALWAYS })
    h.addTab({ id: 9, url: "https://example.com/" })
    h.failInject()
    await expect(h.run("snapshot", { startTabId: 9 })).rejects.toMatchObject({
      code: "browser_page_unreachable",
    })
  })

  it("lists, activates and closes the conversation's pages, never closing a borrowed tab", async () => {
    const h = harness({ decisions: ALWAYS })
    h.addTab({ id: 5, url: "https://example.com/start" })
    await h.run("get_page", { startTabId: 5 })
    const created = (await h.run("create_page", { url: "https://example.com/two" })) as {
      id: string
    }
    expect(created).toMatchObject({ url: "https://example.com/two", active: true })
    const pages = (await h.run("list_pages")) as { id: string; active: boolean }[]
    expect(pages.map((page) => [page.id, page.active])).toEqual([
      ["5", false],
      [created.id, true],
    ])
    await h.run("activate_page", { pageId: "5" })
    expect(await h.run("get_page")).toMatchObject({ url: "https://example.com/start" })
    await h.run("close_page", { pageId: "5" })
    expect(h.removed).toEqual([])
    expect(h.ungrouped).toContainEqual([5])
    await h.run("close_page", { pageId: created.id })
    expect(h.removed).toEqual([Number(created.id)])
    await expect(h.run("activate_page", { pageId: "999" })).rejects.toMatchObject({
      code: "browser_page_not_found",
    })
  })

  it("waits for text until it appears, and reports a timeout", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    let checks = 0
    h.handlers.set(pageHas, () => ++checks >= 3)
    await expect(
      h.run("wait_for_text", { text: "Done", options: { timeoutMs: 5_000 } })
    ).resolves.toEqual({
      ok: true,
      timedOut: false,
    })
    h.handlers.set(pageHas, () => false)
    await expect(
      h.run("wait_for_text", { text: "Never", options: { timeoutMs: 1_000 } })
    ).resolves.toEqual({
      ok: false,
      timedOut: true,
    })
  })

  it("waits for network quiet across the idle window", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    const states = [
      { pending: 2, completed: 0 },
      { pending: 0, completed: 2 },
      { pending: 0, completed: 2 },
      { pending: 0, completed: 2 },
      { pending: 0, completed: 2 },
    ]
    h.handlers.set(mainHooksCall, () => states.shift() ?? { pending: 0, completed: 2 })
    await expect(
      h.run("wait_for_network_idle", { options: { idleMs: 500, timeoutMs: 10_000 } })
    ).resolves.toEqual({ ok: true, timedOut: false })
  })

  it("captures the viewport, an element and the whole page", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    await expect(h.run("screenshot")).resolves.toMatchObject({
      bytes: "SHOT",
      width: 800,
      height: 600,
    })

    h.handlers.set(pageElementRect, () => ({ x: 10, y: 20, width: 30, height: 40, dpr: 2 }))
    await expect(
      h.run("screenshot", { options: { scope: "element", ref: "r1" } })
    ).resolves.toMatchObject({
      bytes: "crop:20,40,60,80",
      width: 60,
      height: 80,
    })
    h.handlers.set(pageElementRect, () => null)
    await expect(
      h.run("screenshot", { options: { scope: "element", ref: "gone" } })
    ).rejects.toMatchObject({
      code: "browser_stale_ref",
    })

    h.handlers.set(pageScrollMetrics, () => ({
      scrollHeight: 2_500,
      viewportHeight: 1_000,
      viewportWidth: 500,
      scrollY: 40,
      dpr: 1,
    }))
    // The last segment can only scroll to 1500: the bottom 500 rows are new.
    h.handlers.set(pageScrollTo, (_tab, [y]) => Math.min(Number(y), 1_500))
    const before = h.captures.length
    const full = await h.run("screenshot", { options: { scope: "fullPage" } })
    expect(full).toMatchObject({ bytes: "stitch:3:500:1000+1000+500", width: 500, height: 2_500 })
    const spacing = h.captures.slice(before)
    expect(spacing[1]! - spacing[0]!).toBeGreaterThanOrEqual(500)
    // Scrolled back to where the person left it.
    expect(h.ran.filter((call) => call.func === pageScrollTo).at(-1)?.args).toEqual([40])
  })

  it("keeps cookie values in the browser and needs the cookies permission", async () => {
    const without = harness({ decisions: ALWAYS })
    await without.run("navigate", { url: "https://example.com/" })
    await expect(without.run("list_cookies")).rejects.toMatchObject({
      code: "browser_permission_required",
    })

    const h = harness({ decisions: ALWAYS, permissions: ["cookies"] })
    await h.run("navigate", { url: "https://example.com/" })
    h.cookies.push({
      name: "sid",
      value: "secret",
      domain: ".example.com",
      path: "/",
      secure: true,
      httpOnly: true,
      storeId: "0",
    })
    const listed = (await h.run("list_cookies")) as Record<string, unknown>[]
    expect(listed).toEqual([
      {
        name: "sid",
        domain: ".example.com",
        path: "/",
        expires: null,
        secure: true,
        httpOnly: true,
        size: 9,
      },
    ])
    expect(JSON.stringify(listed)).not.toContain("secret")
    await expect(h.run("clear_cookies")).resolves.toEqual({ removed: 1 })
    expect(h.removedCookies).toEqual(["sid"])
  })

  it("lists and cancels only this conversation's downloads", async () => {
    const h = harness({ decisions: ALWAYS, permissions: ["downloads"] })
    await h.run("navigate", { url: "https://example.com/" })
    const started = (await h.sessions.get("s1"))!.startedAt
    const base = {
      url: "https://example.com/f",
      mime: "application/pdf",
      bytesReceived: 10,
      totalBytes: 100,
      fileSize: 0,
      exists: false,
    }
    h.downloads.push({
      ...base,
      id: 1,
      filename: "/tmp/old.pdf",
      startTime: started - 1,
      state: "complete",
    })
    h.downloads.push({
      ...base,
      id: 2,
      filename: "/tmp/new.pdf",
      startTime: started + 1,
      state: "in_progress",
    })
    const listed = (await h.run("downloads")) as { id: string; filename: string; state: string }[]
    expect(listed.map((item) => [item.id, item.filename, item.state])).toEqual([
      ["2", "new.pdf", "in_progress"],
    ])
    await expect(h.run("cancel_download", { downloadId: "2" })).resolves.toMatchObject({
      state: "cancelled",
    })
    await expect(h.run("cancel_download", { downloadId: "1" })).rejects.toMatchObject({
      code: "browser_download_not_found",
    })
  })

  it("reads and writes page storage", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    h.handlers.set(pageStorage, (_tab, [action]) =>
      action === "get"
        ? { ok: true, origin: "https://example.com", entries: [{ key: "a", value: "1" }] }
        : { ok: true }
    )
    await expect(h.run("get_storage", { area: "session" })).resolves.toEqual({
      area: "session",
      origin: "https://example.com",
      entries: [{ key: "a", value: "1" }],
    })
    await expect(h.run("set_storage", { key: "a", value: "2" })).resolves.toEqual({
      ok: true,
      error: null,
    })
  })

  it("clamps zoom and reports what the browser applied", async () => {
    const h = harness({ decisions: ALWAYS })
    await h.run("navigate", { url: "https://example.com/" })
    await expect(h.run("set_zoom", { zoom: 9 })).resolves.toEqual({
      ok: true,
      error: null,
      zoom: 1.5,
    })
  })

  it("refuses a malformed frame and an operation it does not implement", async () => {
    const h = harness()
    await expect(h.executor.execute("get_page", {}, 1_000)).rejects.toMatchObject({
      code: "malformed",
    })
    await expect(h.run("__unknown__")).rejects.toMatchObject({ code: "browser_operation_unknown" })
  })
})
