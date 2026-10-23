/**
 * Runs the Host's browser operations in this browser (ADR-0228 §6–7).
 *
 * One call per operation frame. Every operation names the conversation it is
 * for (`session`); the executor keeps that conversation's tabs, refuses while
 * the person has taken over, asks the person before the first action on each
 * site, and runs the page work through the overlay and the page hooks. The
 * values it returns are the shapes `BrowserEngine` promises
 * (`lib/browser/agent-engine.ts`), because the Host hands them straight to the
 * browser tools.
 *
 * The browser itself sits behind {@link AgentBrowser}, so this whole module
 * runs under Jest against a fake; `chrome-agent-browser.ts` is the real one.
 */
import {
  mainEvaluate,
  mainHooksCall,
  mainSetDialogPolicy,
  pageAct,
  pageOverlayAbi,
  pageActingBar,
  pageDrag,
  pageElementRect,
  pageFind,
  pageHas,
  pageScrollMetrics,
  pageScrollTo,
  pageSetFiles,
  pageSnapshot,
  pageStopLoading,
  pageStorage,
} from "./page-functions"
import { MAX_CANVAS_SIDE } from "./image-ops"
import { AgentOperationError, OVERLAY_ABI, type AgentOperation } from "./protocol"
import { withTab, withoutTab, type AgentSession, type SessionStore } from "./sessions"
import { originOf, type SitePermissions } from "./site-permissions"

export interface AgentTab {
  id: number
  windowId: number
  url: string
  title: string
  status: "loading" | "complete" | "unloaded"
  active: boolean
  groupId: number
}

export type ScriptWorld = "ISOLATED" | "MAIN"

export interface DownloadRecord {
  id: number
  url: string
  filename: string
  mime: string
  startTime: number
  endTime?: number
  state: "in_progress" | "interrupted" | "complete"
  error?: string
  bytesReceived: number
  totalBytes: number
  fileSize: number
  exists: boolean
}

export interface CookieRecord {
  name: string
  value: string
  domain: string
  path: string
  expirationDate?: number
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  storeId: string
}

export interface AgentBrowser {
  getTab(tabId: number): Promise<AgentTab | null>
  createTab(input: { url: string; windowId?: number; active: boolean }): Promise<AgentTab>
  updateTab(tabId: number, input: { url?: string; active?: boolean }): Promise<AgentTab | null>
  removeTab(tabId: number): Promise<void>
  goBack(tabId: number): Promise<void>
  goForward(tabId: number): Promise<void>
  reload(tabId: number): Promise<void>
  /** Group tabs (into `groupId` when given) and return the group id. */
  group(
    tabIds: number[],
    groupId: number | null,
    windowId: number | null,
    checkActive?: () => void
  ): Promise<number>
  /** Title and colour a group as Cognia's. */
  styleGroup(groupId: number, title: string): Promise<void>
  ungroup(tabIds: number[]): Promise<void>
  injectFile(tabId: number, file: string, world: ScriptWorld): Promise<void>
  run<A extends unknown[], R>(
    tabId: number,
    world: ScriptWorld,
    func: (...args: A) => R,
    args: A
  ): Promise<Awaited<R>>
  /** The visible area of a window's active tab, as a PNG data URL. */
  captureVisible(windowId: number): Promise<string>
  setZoom(tabId: number, zoom: number): Promise<void>
  getZoom(tabId: number): Promise<number>
  hasPermission(request: { permissions?: string[]; origins?: string[] }): Promise<boolean>
  searchDownloads(startedAfter: number): Promise<DownloadRecord[]>
  cancelDownload(id: number): Promise<void>
  deleteDownload(id: number, checkActive?: () => void): Promise<void>
  getCookies(domain: string): Promise<CookieRecord[]>
  removeCookie(cookie: CookieRecord): Promise<void>
  image: {
    size(dataUrl: string): Promise<{ width: number; height: number }>
    /** Crop in device pixels; answers base64 PNG without the data-URL prefix. */
    crop(
      dataUrl: string,
      rect: { x: number; y: number; width: number; height: number }
    ): Promise<string>
    /** Stack captures top to bottom, keeping `heights` rows of each. */
    stitch(dataUrls: string[], width: number, heights: number[]): Promise<string>
  }
  /** A localized message, for the in-page bar. */
  message(key: string): string
}

export interface ExecutorDeps {
  browser: AgentBrowser
  sessions: SessionStore
  permissions: SitePermissions
  now: () => number
  sleep: (ms: number) => Promise<void>
  signal?: AbortSignal
  checkActive?: () => void
}

/** The overlay bundle and the main-world hooks, as WXT emits them. */
export const OVERLAY_FILE = "/agent-overlay.js"
export const PAGE_HOOKS_FILE = "/page-hooks.js"

/** The group title the conversation's tabs live under. */
export const GROUP_TITLE = "Cognia"

/** Operations allowed while the person has taken over: reads of what is open. */
const ALLOWED_DURING_TAKEOVER: readonly AgentOperation[] = ["get_page", "list_pages"]

/** Chrome refuses more than two visible-tab captures a second. */
const CAPTURE_SPACING_MS = 550
const MAX_FULL_PAGE_SEGMENTS = 20
const POLL_MS = 250

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string") {
    throw new AgentOperationError("malformed", `${key} is required`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function pageIdOf(args: Record<string, unknown>): number {
  const raw = args.pageId
  const id = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN
  if (!Number.isInteger(id)) throw new AgentOperationError("malformed", "pageId is required")
  return id
}

function stripDataUrl(dataUrl: string): string {
  return dataUrl.replace(/^data:[^,]*,/, "")
}

function isWebUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

export function createAgentExecutor(deps: ExecutorDeps) {
  const { sessions, permissions, now, signal } = deps
  const checkActive = () => {
    signal?.throwIfAborted()
    deps.checkActive?.()
  }
  // Every browser boundary is guarded, including calls reached after an await
  // in helpers (permissions, injection, polling, captures and cookie loops).
  // An API call already sent to Chrome cannot be recalled; no later call may
  // start after revocation, and its result must not cross the revoked socket.
  const browser =
    signal || deps.checkActive
      ? new Proxy(deps.browser, {
          get(target, key, receiver) {
            const member = Reflect.get(target, key, receiver)
            if (typeof member !== "function") return member
            return (...args: unknown[]) => {
              checkActive()
              const result = Reflect.apply(member, target, args)
              if (result instanceof Promise)
                return result.then((value: unknown) => {
                  checkActive()
                  return value
                })
              return result
            }
          },
        })
      : deps.browser
  const sleep = async (ms: number) => {
    checkActive()
    await deps.sleep(ms)
    checkActive()
  }

  async function session(id: string): Promise<AgentSession> {
    return (
      (await sessions.get(id)) ?? (await sessions.updateSession(id, now(), (s) => s, checkActive))
    )
  }

  /** Bring the tab into the conversation's group, creating the group once. */
  async function groupTab(current: AgentSession, tab: AgentTab): Promise<AgentSession> {
    try {
      const groupId = await browser.group(
        [tab.id],
        current.groupId,
        current.windowId ?? tab.windowId,
        checkActive
      )
      if (current.groupId !== groupId) await browser.styleGroup(groupId, GROUP_TITLE)
      return await sessions.updateSession(
        current.id,
        now(),
        (s) => ({ ...s, groupId }),
        checkActive
      )
    } catch {
      // A tab in another window cannot join the group; it still belongs to the
      // conversation, just ungrouped.
      return current
    }
  }

  /** Claim the tab the conversation started on, the first time it is seen. */
  async function claimStartTab(current: AgentSession, startTabId: unknown): Promise<AgentSession> {
    if (current.tabIds.length > 0 || typeof startTabId !== "number") return current
    const tab = await browser.getTab(startTabId)
    if (!tab || !isWebUrl(tab.url)) return current
    const claimed = await sessions.updateSession(
      current.id,
      now(),
      (s) => withTab(s, tab.id, { owned: false, windowId: tab.windowId }),
      checkActive
    )
    return groupTab(claimed, tab)
  }

  async function activeTab(current: AgentSession): Promise<AgentTab> {
    if (current.activeTabId !== null) {
      const tab = await browser.getTab(current.activeTabId)
      if (tab) return tab
      await sessions.updateSession(
        current.id,
        now(),
        (s) => withoutTab(s, current.activeTabId!),
        checkActive
      )
    }
    throw new AgentOperationError(
      "browser_page_not_found",
      "No page is open in this conversation yet; navigate first."
    )
  }

  async function openTab(current: AgentSession, url: string): Promise<AgentTab> {
    const first = current.tabIds.length === 0
    const tab = await browser.createTab({
      url,
      ...(current.windowId !== null ? { windowId: current.windowId } : {}),
      // The first tab is shown so the person can watch; later ones open quietly.
      active: first,
    })
    const updated = await sessions.updateSession(
      current.id,
      now(),
      (s) => withTab(s, tab.id, { owned: true, windowId: tab.windowId }),
      checkActive
    )
    await groupTab(updated, tab)
    return tab
  }

  async function waitForComplete(tabId: number, deadline: number): Promise<AgentTab | null> {
    for (;;) {
      const tab = await browser.getTab(tabId)
      if (!tab) return null
      if (tab.status === "complete") return tab
      if (now() >= deadline) return tab
      await sleep(POLL_MS)
    }
  }

  /** Overlay + page hooks + the acting bar, idempotent per document. */
  async function prepare(current: AgentSession, tab: AgentTab): Promise<void> {
    if (!isWebUrl(tab.url)) {
      throw new AgentOperationError(
        "browser_page_restricted",
        "This page cannot be acted on: only http and https pages can."
      )
    }
    try {
      await browser.injectFile(tab.id, OVERLAY_FILE, "ISOLATED")
      const abi = await browser.run(tab.id, "ISOLATED", pageOverlayAbi, [])
      if (abi !== OVERLAY_ABI) {
        throw new AgentOperationError(
          "browser_overlay_incompatible",
          "Reload this page before allowing browser actions: its overlay ABI is incompatible"
        )
      }
      await browser.injectFile(tab.id, PAGE_HOOKS_FILE, "MAIN")
    } catch (error) {
      signal?.throwIfAborted()
      if (error instanceof AgentOperationError) throw error
      throw new AgentOperationError(
        "browser_page_unreachable",
        `The extension could not reach this page: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    await showBar(current, tab.id)
  }

  async function showBar(current: AgentSession, tabId: number): Promise<void> {
    await browser
      .run(tabId, "ISOLATED", pageActingBar, [
        {
          session: current.id,
          takenOver: current.takeover,
          labels: {
            acting: browser.message("agentBarActing"),
            paused: browser.message("agentBarPaused"),
            stop: browser.message("agentBarStop"),
            takeOver: browser.message("agentBarTakeOver"),
            resume: browser.message("agentBarResume"),
          },
        },
      ])
      .catch(() => undefined)
  }

  /** The tab an operation acts on, allowed by the person and ready. */
  async function pageFor(
    current: AgentSession,
    operation: string,
    deadline: number
  ): Promise<AgentTab> {
    const tab = await activeTab(current)
    await permissions.ensureAllowed(current.id, tab.url, operation, deadline, signal)
    await prepare(current, tab)
    return tab
  }

  async function act(
    tab: AgentTab,
    ref: string,
    action: string,
    actionArgs: Record<string, unknown>
  ) {
    const before = await browser.run(tab.id, "MAIN", mainHooksCall, ["lastDialog"])
    const result = record(
      await browser.run(tab.id, "ISOLATED", pageAct, [ref, action, JSON.stringify(actionArgs)])
    )
    const after = record(await browser.run(tab.id, "MAIN", mainHooksCall, ["lastDialog"]))
    // A dialog the action raised was answered without blocking (page-hooks);
    // say which, so the agent is not surprised by its outcome.
    if (after.at !== undefined && JSON.stringify(after) !== JSON.stringify(before)) {
      return {
        ...result,
        dialogPending: false,
        dialog: {
          type: after.type,
          message: after.message,
          defaultValue: after.defaultValue ?? "",
        },
      }
    }
    return result
  }

  async function waitUntil(
    deadline: number,
    interval: number,
    check: () => Promise<boolean>
  ): Promise<{ ok: boolean; timedOut: boolean }> {
    for (;;) {
      if (await check()) return { ok: true, timedOut: false }
      if (now() >= deadline) return { ok: false, timedOut: true }
      await sleep(Math.max(50, interval))
    }
  }

  async function screenshot(
    current: AgentSession,
    tab: AgentTab,
    options: Record<string, unknown>
  ) {
    // A capture is of a window's visible tab, so the tab has to be in front.
    if (!tab.active) await browser.updateTab(tab.id, { active: true })
    const scope =
      options.scope === "fullPage" || options.scope === "element" ? options.scope : "viewport"
    const capturedAt = now()
    if (scope === "element") {
      const ref = typeof options.ref === "string" ? options.ref : ""
      const rect = await browser.run(tab.id, "ISOLATED", pageElementRect, [ref])
      if (!rect) throw new AgentOperationError("browser_stale_ref", `unknown ref: ${ref}`)
      await sleep(100)
      const shot = await browser.captureVisible(tab.windowId)
      const crop = {
        x: Math.max(0, Math.round(rect.x * rect.dpr)),
        y: Math.max(0, Math.round(rect.y * rect.dpr)),
        width: Math.max(1, Math.round(rect.width * rect.dpr)),
        height: Math.max(1, Math.round(rect.height * rect.dpr)),
      }
      return {
        bytes: await browser.image.crop(shot, crop),
        width: crop.width,
        height: crop.height,
        capturedAt,
        format: "png",
      }
    }
    if (scope === "fullPage") {
      const metrics = await browser.run(tab.id, "ISOLATED", pageScrollMetrics, [])
      const steps = Math.min(
        MAX_FULL_PAGE_SEGMENTS,
        Math.max(1, Math.ceil(metrics.scrollHeight / metrics.viewportHeight))
      )
      const shots: string[] = []
      const heights: number[] = []
      for (let step = 0; step < steps; step++) {
        const target = step * metrics.viewportHeight
        const landed = await browser.run(tab.id, "ISOLATED", pageScrollTo, [target])
        await sleep(step === 0 ? 150 : CAPTURE_SPACING_MS)
        shots.push(await browser.captureVisible(tab.windowId))
        // The last step may overlap the previous one; keep only the new rows.
        const previousBottom =
          step === 0 ? 0 : (step - 1) * metrics.viewportHeight + metrics.viewportHeight
        const fresh =
          step === 0 ? metrics.viewportHeight : landed + metrics.viewportHeight - previousBottom
        heights.push(Math.round(Math.max(0, Math.min(metrics.viewportHeight, fresh)) * metrics.dpr))
      }
      await browser.run(tab.id, "ISOLATED", pageScrollTo, [metrics.scrollY])
      const width = Math.min(MAX_CANVAS_SIDE, Math.round(metrics.viewportWidth * metrics.dpr))
      const rows = heights.reduce((sum, value) => sum + value, 0)
      // The canvas the segments are stacked on stops at MAX_CANVAS_SIDE; a
      // page taller than that, or than the segment budget, is cut and says so.
      const height = Math.min(MAX_CANVAS_SIDE, rows)
      const truncated =
        rows > MAX_CANVAS_SIDE ||
        (steps === MAX_FULL_PAGE_SEGMENTS && metrics.scrollHeight > steps * metrics.viewportHeight)
      return {
        bytes: await browser.image.stitch(shots, width, heights),
        width,
        height,
        capturedAt,
        format: "png",
        ...(truncated ? { truncated: true } : {}),
      }
    }
    const shot = await browser.captureVisible(tab.windowId)
    const size = await browser.image.size(shot)
    await showBar(current, tab.id)
    return {
      bytes: stripDataUrl(shot),
      width: size.width,
      height: size.height,
      capturedAt,
      format: "png",
    }
  }

  async function requirePermission(permission: "downloads" | "cookies"): Promise<void> {
    if (!(await browser.hasPermission({ permissions: [permission] }))) {
      throw new AgentOperationError(
        "browser_permission_required",
        `The extension needs the “${permission}” permission; turn it on in the Cognia side panel's settings.`
      )
    }
  }

  function downloadSummary(sessionId: string, item: DownloadRecord) {
    const state =
      item.state === "complete"
        ? "completed"
        : item.state === "in_progress"
          ? "in_progress"
          : item.error === "USER_CANCELED"
            ? "cancelled"
            : "failed"
    return {
      id: String(item.id),
      sessionId,
      filename: item.filename.split(/[\\/]/).pop() ?? item.filename,
      size: item.state === "complete" ? item.fileSize || item.bytesReceived : item.bytesReceived,
      url: item.url,
      mimeType: item.mime,
      totalBytes: item.totalBytes,
      receivedBytes: item.bytesReceived,
      startedAt: item.startTime,
      ...(item.endTime ? { finishedAt: item.endTime } : {}),
      ...(item.state === "complete" && item.exists ? { savedPath: item.filename } : {}),
      ...(item.error ? { error: item.error } : {}),
      state,
    }
  }

  async function sessionDownload(current: AgentSession, id: string): Promise<DownloadRecord> {
    const numeric = Number(id)
    const found = (await browser.searchDownloads(current.startedAt)).find(
      (item) => item.id === numeric
    )
    if (!found) {
      throw new AgentOperationError(
        "browser_download_not_found",
        `no download ${id} in this conversation`
      )
    }
    return found
  }

  async function release(current: AgentSession): Promise<void> {
    for (const tabId of current.tabIds) {
      await browser.run(tabId, "ISOLATED", pageActingBar, [null]).catch(() => undefined)
    }
    const kept = current.tabIds.filter((id) => !current.ownedTabIds.includes(id))
    if (kept.length > 0) await browser.ungroup(kept).catch(() => undefined)
    await permissions.dropQuestions(current.id, checkActive)
    await sessions.remove(current.id, checkActive)
  }

  async function execute(
    operation: AgentOperation,
    args: Record<string, unknown>,
    deadlineMs: number
  ): Promise<unknown> {
    signal?.throwIfAborted()
    const sessionId = stringArg(args, "session")
    const deadline = now() + Math.max(1_000, deadlineMs) - 250
    let current = await session(sessionId)
    if (current.takeover && !ALLOWED_DURING_TAKEOVER.includes(operation)) {
      throw new AgentOperationError(
        "browser_user_takeover",
        "The person has taken control of this conversation's tabs. Wait until they hand it back."
      )
    }
    // Even reads cannot claim/group a fresh tab while the person holds control.
    // Cleanup also waits for Resume: deleting the session would erase its pause.
    if (!current.takeover) current = await claimStartTab(current, args.startTabId)

    switch (operation) {
      case "bind": {
        return { ok: true, tabId: current.activeTabId }
      }
      case "release": {
        await release(current)
        return { ok: true }
      }
      case "finalize_tabs": {
        let closed = 0
        for (const tabId of current.ownedTabIds) {
          await browser.removeTab(tabId).then(
            () => {
              closed += 1
            },
            () => undefined
          )
        }
        await release(current)
        return { closed }
      }
      case "navigate": {
        const url = stringArg(args, "url")
        originOf(url)
        await permissions.ensureAllowed(sessionId, url, operation, deadline, signal)
        let tab: AgentTab
        if (current.activeTabId === null) {
          tab = await openTab(current, url)
        } else {
          tab = await activeTab(current)
          await browser.updateTab(tab.id, { url })
        }
        await sleep(100)
        const landed = (await waitForComplete(tab.id, deadline)) ?? tab
        current = await session(sessionId)
        if (isWebUrl(landed.url)) await prepare(current, landed).catch(() => undefined)
        return { ok: true, error: null }
      }
      case "create_page": {
        const url = optionalString(args, "url") ?? "about:blank"
        if (url !== "about:blank") {
          originOf(url)
          await permissions.ensureAllowed(sessionId, url, operation, deadline, signal)
        }
        const tab = await openTab(current, url)
        const landed = (await waitForComplete(tab.id, deadline)) ?? tab
        return { id: String(landed.id), url: landed.url, title: landed.title, active: true }
      }
      case "get_page": {
        const tab = await activeTab(current)
        return { url: tab.url, title: tab.title }
      }
      case "list_pages": {
        const pages = []
        for (const tabId of current.tabIds) {
          const tab = await browser.getTab(tabId)
          if (tab) {
            pages.push({
              id: String(tab.id),
              url: tab.url,
              title: tab.title,
              active: tab.id === current.activeTabId,
            })
          }
        }
        return pages
      }
      case "activate_page": {
        const tabId = pageIdOf(args)
        if (!current.tabIds.includes(tabId)) {
          throw new AgentOperationError(
            "browser_page_not_found",
            `no page ${tabId} in this conversation`
          )
        }
        await sessions.updateSession(
          sessionId,
          now(),
          (s) => ({ ...s, activeTabId: tabId }),
          checkActive
        )
        return null
      }
      case "close_page": {
        const tabId = pageIdOf(args)
        if (!current.tabIds.includes(tabId)) {
          throw new AgentOperationError(
            "browser_page_not_found",
            `no page ${tabId} in this conversation`
          )
        }
        // A tab the person had open before is let go, never closed: the agent
        // was a guest in it.
        if (current.ownedTabIds.includes(tabId))
          await browser.removeTab(tabId).catch(() => undefined)
        else {
          await browser.run(tabId, "ISOLATED", pageActingBar, [null]).catch(() => undefined)
          await browser.ungroup([tabId]).catch(() => undefined)
        }
        await sessions.updateSession(sessionId, now(), (s) => withoutTab(s, tabId), checkActive)
        return null
      }
      case "back":
      case "forward":
      case "reload": {
        const tab = await pageFor(current, operation, deadline)
        if (operation === "back") await browser.goBack(tab.id)
        else if (operation === "forward") await browser.goForward(tab.id)
        else await browser.reload(tab.id)
        await sleep(100)
        await waitForComplete(tab.id, deadline)
        return { ok: true, error: null }
      }
      case "stop": {
        const tab = await activeTab(current)
        await browser.run(tab.id, "ISOLATED", pageStopLoading, [])
        return { ok: true, error: null }
      }
      case "snapshot": {
        const tab = await pageFor(current, operation, deadline)
        const outcome = await browser.run(tab.id, "ISOLATED", pageSnapshot, [
          JSON.stringify(record(args.options)),
        ])
        if (!outcome.ok) {
          throw new AgentOperationError(
            "browser_snapshot_failed",
            outcome.error ?? "snapshot failed"
          )
        }
        return outcome.snapshot
      }
      case "act": {
        const tab = await pageFor(current, operation, deadline)
        return act(tab, stringArg(args, "ref"), stringArg(args, "action"), record(args.args))
      }
      case "press_key": {
        const tab = await pageFor(current, operation, deadline)
        return act(tab, optionalString(args, "ref") ?? "", "key", { key: stringArg(args, "key") })
      }
      case "scroll": {
        const tab = await pageFor(current, operation, deadline)
        const { session: _s, startTabId: _t, reference, ...rest } = args
        return act(tab, typeof reference === "string" ? reference : "", "scroll", rest)
      }
      case "drag": {
        const tab = await pageFor(current, operation, deadline)
        const outcome = await browser.run(tab.id, "ISOLATED", pageDrag, [
          stringArg(args, "sourceRef"),
          stringArg(args, "targetRef"),
        ])
        return { ...outcome, generation: 0 }
      }
      case "evaluate": {
        const tab = await pageFor(current, operation, deadline)
        return browser.run(tab.id, "MAIN", mainEvaluate, [stringArg(args, "expression")])
      }
      case "read_console":
      case "read_network": {
        const tab = await pageFor(current, operation, deadline)
        return browser.run(tab.id, "MAIN", mainHooksCall, [
          operation === "read_console" ? "drainConsole" : "drainNetwork",
        ])
      }
      case "handle_dialog": {
        const tab = await pageFor(current, operation, deadline)
        const promptText = optionalString(args, "promptText")
        await browser.run(tab.id, "MAIN", mainSetDialogPolicy, [
          { accept: args.accept === true, ...(promptText !== undefined ? { promptText } : {}) },
        ])
        return { ok: true, error: null, generation: 0 }
      }
      case "set_files": {
        const tab = await pageFor(current, operation, deadline)
        const files = Array.isArray(args.files) ? args.files : []
        const typed = files.map((file) => {
          const entry = record(file)
          if (
            typeof entry.name !== "string" ||
            typeof entry.mediaType !== "string" ||
            typeof entry.dataBase64 !== "string"
          ) {
            throw new AgentOperationError(
              "malformed",
              "files must carry name, mediaType and dataBase64"
            )
          }
          return { name: entry.name, mediaType: entry.mediaType, dataBase64: entry.dataBase64 }
        })
        return browser.run(tab.id, "ISOLATED", pageSetFiles, [stringArg(args, "ref"), typed])
      }
      case "wait_for_text":
      case "wait_for_selector": {
        const tab = await pageFor(current, operation, deadline)
        const options = record(args.options)
        const appear = options.mode !== "disappear"
        const kind = operation === "wait_for_text" ? "text" : "selector"
        const value = stringArg(args, kind)
        const until = Math.min(
          deadline,
          now() + (typeof options.timeoutMs === "number" ? options.timeoutMs : 10_000)
        )
        return waitUntil(
          until,
          typeof options.intervalMs === "number" ? options.intervalMs : POLL_MS,
          async () => {
            const present = await browser.run(tab.id, "ISOLATED", pageHas, [kind, value])
            return appear ? present === true : present === false
          }
        )
      }
      case "wait_for_network_idle": {
        const tab = await pageFor(current, operation, deadline)
        const options = record(args.options)
        const idleMs = typeof options.idleMs === "number" ? options.idleMs : 500
        const until = Math.min(
          deadline,
          now() + (typeof options.timeoutMs === "number" ? options.timeoutMs : 10_000)
        )
        let quietSince: number | null = null
        let lastCompleted = -1
        return waitUntil(
          until,
          typeof options.intervalMs === "number" ? options.intervalMs : POLL_MS,
          async () => {
            const state = record(await browser.run(tab.id, "MAIN", mainHooksCall, ["networkState"]))
            const pending = Number(state.pending ?? 0)
            const completed = Number(state.completed ?? 0)
            if (pending > 0 || completed !== lastCompleted) {
              lastCompleted = completed
              quietSince = pending > 0 ? null : now()
              return false
            }
            quietSince ??= now()
            return now() - quietSince >= idleMs
          }
        )
      }
      case "wait_for_load": {
        const tab = await activeTab(current)
        const options = record(args.options)
        const until = Math.min(
          deadline,
          now() + (typeof options.timeoutMs === "number" ? options.timeoutMs : 15_000)
        )
        if (typeof options.initialDelayMs === "number") await sleep(options.initialDelayMs)
        const targetUrl = typeof options.targetUrl === "string" ? options.targetUrl : null
        const fromUrl = typeof options.fromUrl === "string" ? options.fromUrl : null
        return waitUntil(
          until,
          typeof options.intervalMs === "number" ? options.intervalMs : POLL_MS,
          async () => {
            const live = await browser.getTab(tab.id)
            if (!live || live.status !== "complete") return false
            if (targetUrl && live.url === targetUrl) return true
            if (fromUrl) return live.url !== fromUrl
            return true
          }
        )
      }
      case "screenshot": {
        const tab = await pageFor(current, operation, deadline)
        return screenshot(current, tab, record(args.options))
      }
      case "set_zoom": {
        const tab = await activeTab(current)
        const zoom = typeof args.zoom === "number" ? Math.min(5, Math.max(0.25, args.zoom)) : 1
        await browser.setZoom(tab.id, zoom)
        return { ok: true, error: null, zoom: await browser.getZoom(tab.id) }
      }
      case "find": {
        const tab = await pageFor(current, operation, deadline)
        return browser.run(tab.id, "ISOLATED", pageFind, [
          stringArg(args, "query"),
          args.options ?? null,
        ])
      }
      case "find_clear": {
        const tab = await activeTab(current)
        await browser.run(tab.id, "ISOLATED", pageFind, [null, null]).catch(() => undefined)
        return null
      }
      case "get_storage":
      case "set_storage":
      case "clear_storage": {
        const tab = await pageFor(current, operation, deadline)
        const area = args.area === "session" ? "session" : "local"
        const action =
          operation === "get_storage" ? "get" : operation === "set_storage" ? "set" : "clear"
        const outcome = await browser.run(tab.id, "ISOLATED", pageStorage, [
          action,
          area,
          optionalString(args, "key") ?? (typeof args.key === "string" ? args.key : null),
          typeof args.value === "string" ? args.value : null,
        ])
        if (!outcome.ok)
          throw new AgentOperationError("browser_storage_failed", outcome.error ?? "storage failed")
        return action === "get"
          ? {
              area,
              origin: outcome.origin,
              entries: outcome.entries,
              ...(outcome.exists !== undefined ? { exists: outcome.exists } : {}),
            }
          : { ok: true, error: null }
      }
      case "list_cookies":
      case "clear_cookies": {
        await requirePermission("cookies")
        const tab = await pageFor(current, operation, deadline)
        const domain = optionalString(args, "domain") ?? new URL(tab.url).hostname
        const cookies = await browser.getCookies(domain)
        if (operation === "clear_cookies") {
          for (const cookie of cookies) await browser.removeCookie(cookie)
          return { removed: cookies.length }
        }
        // Metadata only: a cookie's value never leaves the browser.
        return cookies.map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          expires: cookie.expirationDate ?? null,
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          ...(cookie.sameSite ? { sameSite: cookie.sameSite } : {}),
          size: cookie.name.length + cookie.value.length,
        }))
      }
      case "downloads": {
        await requirePermission("downloads")
        return (await browser.searchDownloads(current.startedAt)).map((item) =>
          downloadSummary(sessionId, item)
        )
      }
      case "cancel_download": {
        await requirePermission("downloads")
        const item = await sessionDownload(current, stringArg(args, "downloadId"))
        await browser.cancelDownload(item.id)
        const updated = await sessionDownload(current, String(item.id))
        return downloadSummary(sessionId, updated)
      }
      case "delete_download": {
        await requirePermission("downloads")
        const item = await sessionDownload(current, stringArg(args, "downloadId"))
        await browser.deleteDownload(item.id, checkActive)
        return { deleted: true, id: String(item.id) }
      }
      default: {
        throw new AgentOperationError(
          "browser_operation_unknown",
          `this extension does not implement ${String(operation)}`
        )
      }
    }
  }

  return { execute }
}

export type AgentExecutor = ReturnType<typeof createAgentExecutor>
