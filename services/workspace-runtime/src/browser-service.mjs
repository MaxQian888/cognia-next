import { AsyncLocalStorage } from "node:async_hooks"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { RemoteBrowserError } from "./browser-errors.mjs"
import { LocalDownloadTracker } from "./download-tracker.mjs"
import { reserveUniquePath, resolveLocalUploads, safeFilename } from "./local-files.mjs"
import { encodeBody, redactHeaders } from "./network-details.mjs"
import { LocalNetworkPolicy, NetworkPolicy } from "./network-policy.mjs"
import {
  CREDENTIAL_BINDING,
  OVERLAY_TRANSPORT_SCRIPT,
  CREDENTIAL_CAPTURE_SCRIPT,
  LOGIN_REGISTRY_KEY,
  clearStorageInPage,
  detectLoginFormsInPage,
  readStorageInPage,
  resolveLoginRegistryEntry,
  writeStorageInPage,
} from "./page-scripts.mjs"
import {
  MAX_SELECTIONS,
  SELECTION_SIGNAL_BINDING,
  SelectionError,
  normalizeAdjustRequest,
  normalizeAdjustResult,
  normalizePanelLabels,
  normalizeSelectionDrain,
  normalizeSelectionForRef,
} from "./element-selection.mjs"
import { encodeMediaFrame } from "./protocol.mjs"

const SECRET_FIELD =
  /password|passcode|one[\s-]?time|otp|token|secret|verification[\s-]?code|密码|口令|验证码/i

/** `session.create` fields only local mode (ADR-0201) accepts. */
export const LOCAL_SESSION_FIELDS = Object.freeze([
  "kind",
  "headless",
  "extensionPaths",
  "cdpEndpoint",
  "downloadsDir",
  "uploadRoots",
  "allowFileUrls",
  "viewport",
])

const MAX_TRACKED_REQUESTS = 200
const CREDENTIAL_DEDUPE_MS = 10_000
const MAX_EXTENSIONS = 64
const EXTENSION_ID = /^[a-p]{32}$/

export { RemoteBrowserError }

function parseEnvelope(value) {
  return typeof value === "string" ? JSON.parse(value) : value
}

function pageMainFrame(page) {
  return typeof page.mainFrame === "function" ? page.mainFrame() : page.mainFrame
}

function pageSummary(record, pageId, activePageId) {
  return Promise.all([record.page.title(), Promise.resolve(record.page.url())]).then(
    ([title, url]) => ({
      id: pageId,
      url,
      title,
      active: pageId === activePageId,
      ...(record.openerPageId ? { openerId: record.openerPageId } : {}),
    })
  )
}

/**
 * The page an operation was addressed to (`payload.pageId`), for as long as
 * that operation runs — awaits and callbacks included.
 *
 * Every page-level operation acts on "the page" without naming it. That used
 * to mean the session's active page, the one the screencast shows, which was
 * fine while one viewer and one agent shared one tab. Several conversations
 * now keep their own tabs in one session (ADR-0214, D10): a background task's
 * agent must keep driving its own page while the user looks at another one.
 * An addressed operation resolves "the page" to the one it named; an
 * unaddressed one still means the active page, so every existing caller keeps
 * its meaning.
 */
const pageTarget = new AsyncLocalStorage()

/**
 * The per-page half of the action bookkeeping: an in-flight action, the
 * dialog it ran into, and who is waiting to hear about one. Kept per page so
 * an action on one tab neither waits for nor is refused by another tab's.
 */
function newActionLane() {
  return {
    pendingDialog: null,
    pendingAction: null,
    dialogWaiters: new Set(),
    actionInFlight: false,
  }
}

function assertProfileId(profileId) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(profileId)) {
    throw new RemoteBrowserError("browser_profile_invalid", "Browser profile id is invalid")
  }
}

function invalidOption(message) {
  return new RemoteBrowserError("browser_session_option_invalid", message)
}

function absolutePathList(value, field, { max = 256, forbidComma = false } = {}) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > max) throw invalidOption(`${field} must be a list`)
  return value.map((entry) => {
    if (typeof entry !== "string" || !path.isAbsolute(entry)) {
      throw invalidOption(`${field} entries must be absolute paths`)
    }
    if (forbidComma && entry.includes(",")) {
      throw invalidOption(`${field} entries must not contain commas`)
    }
    return path.resolve(entry)
  })
}

function clampViewport(viewport, fallback) {
  if (viewport === undefined || viewport === null) return { ...fallback }
  const width = Number(viewport.width)
  const height = Number(viewport.height)
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 200 || height < 200) {
    throw invalidOption("viewport must have integer width and height of at least 200")
  }
  return { width: Math.min(width, 1600), height: Math.min(height, 1200) }
}

/**
 * The user's Chrome is only ever reached through its own loopback DevTools
 * endpoint (discovered in Rust from `DevToolsActivePort`); anything else is a
 * configuration error, never a remote browser.
 */
export function assertLoopbackCdpEndpoint(endpoint) {
  let url
  try {
    url = new URL(endpoint)
  } catch {
    throw new RemoteBrowserError("browser_cdp_endpoint_invalid", "CDP endpoint is invalid")
  }
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (
    !["ws:", "http:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "::1"].includes(host) ||
    !url.port
  ) {
    throw new RemoteBrowserError(
      "browser_cdp_endpoint_invalid",
      "CDP endpoint must be a loopback ws:// or http:// address"
    )
  }
  return url.toString()
}

function normalizeCookieDomain(domain) {
  if (domain === undefined || domain === null || domain === "") return null
  if (typeof domain !== "string" || domain.length > 253) {
    throw new RemoteBrowserError("browser_cookie_invalid", "Cookie domain is invalid")
  }
  return domain.trim().toLowerCase().replace(/^\./, "")
}

function cookieMatchesDomain(cookieDomain, domain) {
  if (!domain) return true
  const normalized = String(cookieDomain ?? "")
    .toLowerCase()
    .replace(/^\./, "")
  return normalized === domain || normalized.endsWith(`.${domain}`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function normalizeSameSite(value, secure) {
  const lower = String(value ?? "").toLowerCase()
  if (lower === "strict") return "Strict"
  if (lower === "lax") return "Lax"
  if (lower === "none" || lower === "no_restriction") return secure ? "None" : "Lax"
  return undefined
}

function normalizeCookie(raw) {
  if (!raw || typeof raw.name !== "string" || typeof raw.value !== "string") {
    throw new RemoteBrowserError("browser_cookie_invalid", "Cookie name and value are required")
  }
  const domain = typeof raw.domain === "string" ? raw.domain.trim() : ""
  if (!domain) throw new RemoteBrowserError("browser_cookie_invalid", "Cookie domain is required")
  const secure = raw.secure === true
  const expires = Number(raw.expires)
  const sameSite = normalizeSameSite(raw.sameSite, secure)
  return {
    name: raw.name,
    value: raw.value,
    domain,
    path: typeof raw.path === "string" && raw.path.startsWith("/") ? raw.path : "/",
    expires: Number.isFinite(expires) && expires > 0 ? expires : -1,
    secure,
    httpOnly: raw.httpOnly === true,
    ...(sameSite ? { sameSite } : {}),
  }
}

function cookieMetadata(cookie) {
  return {
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
  }
}

function storageArea(area) {
  if (area !== "local" && area !== "session") {
    throw new RemoteBrowserError("browser_storage_invalid", "Storage area must be local or session")
  }
  return area
}

function finiteInRange(value, min, max, field) {
  if (value === undefined || value === null) return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new RemoteBrowserError("browser_option_invalid", `${field} is out of range`)
  }
  return number
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function overlayUnavailable() {
  return new RemoteBrowserError(
    "browser_feature_unsupported",
    "The page has not loaded Cognia's page helpers yet"
  )
}

/** The `paneId` a local page's picks carry (the embedded webview stamps its label). */
function selectionPaneId(pageId) {
  return `local:${pageId}`
}

function selectionResult(build) {
  try {
    return build()
  } catch (error) {
    if (error instanceof SelectionError) {
      throw new RemoteBrowserError("browser_selection_invalid", error.message)
    }
    throw error
  }
}

function frameOrigin(frame) {
  try {
    const origin = new URL(frame.url()).origin
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}

/**
 * Loopback origins (127.0.0.0/8, ::1, localhost, *.localhost): the only
 * origins whose web-storage values a local session hands back.
 */
export function isLoopbackOrigin(origin) {
  let hostname
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true
  if (hostname === "[::1]") return true
  const octets = hostname.split(".")
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

/**
 * Marker file in a persistent profile's directory recording that imported
 * cookies were injected into it. Chromium keeps those cookies across
 * sessions, so every later session on the profile withholds response bodies
 * until an unscoped `browser.cookies.clear` removes the marker.
 */
export const COOKIES_IMPORTED_MARKER = ".cognia-cookies-imported"

export class RemoteChromiumService {
  constructor({
    chromium,
    overlayScript,
    workspaceRoot,
    profilesRoot,
    fileBridge,
    mode = "cloud",
    onEvent = () => undefined,
    devices = {},
    stagingRoot,
    defaultDownloadsDir = path.join(os.homedir(), "Downloads"),
    localPolicyFactory = (options) => new LocalNetworkPolicy(options),
    userChromeConnectTimeoutMs = 120_000,
    eventDebounceMs = 50,
    createId = () => crypto.randomUUID(),
    networkPolicyFactory = () => new NetworkPolicy(),
    maxSessions = 3,
    maxPages = 8,
    idleTimeoutMs = 30 * 60 * 1000,
    maxLifetimeMs = 8 * 60 * 60 * 1000,
    reaperIntervalMs = 60 * 1000,
    now = () => Date.now(),
    viewport = { width: 1280, height: 720 },
  }) {
    if (mode !== "cloud" && mode !== "local") throw new Error("browser service mode is invalid")
    this.mode = mode
    this.chromium = chromium
    this.overlayScript = overlayScript
    this.workspaceRoot = workspaceRoot ? path.resolve(workspaceRoot) : null
    this.profilesRoot = path.resolve(profilesRoot)
    this.stagingRoot = path.resolve(
      stagingRoot ?? path.join(path.dirname(this.profilesRoot), ".download-staging")
    )
    this.defaultDownloadsDir = defaultDownloadsDir
    this.fileBridge = fileBridge ?? null
    if (mode === "cloud" && !this.fileBridge) {
      throw new Error("cloud browser service requires a workspace file bridge")
    }
    this.onEvent = onEvent
    this.devices = devices
    this.localPolicyFactory = localPolicyFactory
    this.userChromeConnectTimeoutMs = userChromeConnectTimeoutMs
    this.eventDebounceMs = eventDebounceMs
    this.createId = createId
    this.networkPolicyFactory = networkPolicyFactory
    this.maxSessions = maxSessions
    this.maxPages = maxPages
    this.idleTimeoutMs = idleTimeoutMs
    this.maxLifetimeMs = maxLifetimeMs
    this.now = now
    this.viewport = {
      width: Math.min(viewport.width, 1600),
      height: Math.min(viewport.height, 1200),
    }
    this.sessions = new Map()
    this.profileOwners = new Map()
    this.references = new Map()
    this.loginRefs = new Map()
    this.shuttingDown = false
    this.pendingLaunches = new Set()
    this.reaper = setInterval(() => void this.reapExpired(), reaperIntervalMs)
    this.reaper.unref?.()
  }

  emit(event) {
    try {
      this.onEvent({ kind: "browser.event", ...event })
    } catch {
      // A failing event sink must never break a browser operation.
    }
  }

  newSessionRecord(fields) {
    const createdAt = this.now()
    return {
      kind: "cloud",
      profileId: null,
      grants: [],
      browser: null,
      ownsBrowser: false,
      context: null,
      pages: new Map(),
      pageIds: new WeakMap(),
      activePageId: null,
      requests: new Map(),
      requestSeq: 0,
      blockedDomains: new Set(),
      lastBlockedError: null,
      screencast: null,
      screencastRequest: null,
      humanKeyboardInputOccurred: false,
      // Set once imported cookies were injected (browser.cookies.set), or at
      // launch when the profile carries the imported-cookies marker: every
      // response may be authenticated with the user's real credentials.
      cookiesImported: false,
      // Local mode: the page's file chooser waiting for the user's staged
      // files (`filechooser.opened` → `browser.filechooser.set`).
      pendingFileChooser: null,
      // Actions that address no existing page yet (`browser.page.create`).
      // Every page record carries its own lane (`newActionLane`).
      actionLane: newActionLane(),
      closing: false,
      restarting: false,
      pagesChangedTimer: null,
      downloads: null,
      downloadCdp: null,
      browserCdp: null,
      targetIds: new Set(),
      pageTargetIds: new WeakMap(),
      recentCredentials: new Map(),
      uploadRoots: null,
      createdAt,
      lastActivityAt: createdAt,
      ...fields,
    }
  }

  /**
   * Validate the local-only `session.create` fields. Cloud mode refuses every
   * one of them with `browser_local_option_unsupported`: a shared cloud
   * runtime must never read host paths, load extensions, or attach to an
   * arbitrary DevTools endpoint.
   */
  parseLocalOptions(options) {
    const present = LOCAL_SESSION_FIELDS.filter((field) => options[field] !== undefined)
    if (this.mode !== "local") {
      if (present.length > 0) {
        throw new RemoteBrowserError(
          "browser_local_option_unsupported",
          `Session options are only available in local mode: ${present.join(", ")}`
        )
      }
      return null
    }
    const kind = options.kind ?? "local"
    if (kind !== "local" && kind !== "user-chrome") throw invalidOption("kind is invalid")
    if (options.headless !== undefined && typeof options.headless !== "boolean") {
      throw invalidOption("headless must be a boolean")
    }
    if (options.allowFileUrls !== undefined && typeof options.allowFileUrls !== "boolean") {
      throw invalidOption("allowFileUrls must be a boolean")
    }
    const extensionPaths = absolutePathList(options.extensionPaths, "extensionPaths", {
      max: MAX_EXTENSIONS,
      forbidComma: true,
    })
    if (kind === "user-chrome" && extensionPaths.length > 0) {
      throw new RemoteBrowserError(
        "extensions_unsupported_backend",
        "The user's Chrome keeps its own extensions"
      )
    }
    let cdpEndpoint = null
    if (kind === "user-chrome") {
      if (typeof options.cdpEndpoint !== "string") {
        throw new RemoteBrowserError(
          "browser_cdp_endpoint_invalid",
          "A user-chrome session needs a CDP endpoint"
        )
      }
      cdpEndpoint = assertLoopbackCdpEndpoint(options.cdpEndpoint)
    } else if (options.cdpEndpoint !== undefined) {
      throw invalidOption("cdpEndpoint is only valid for user-chrome sessions")
    }
    let downloadsDir = this.defaultDownloadsDir
    if (options.downloadsDir !== undefined) {
      if (typeof options.downloadsDir !== "string" || !path.isAbsolute(options.downloadsDir)) {
        throw invalidOption("downloadsDir must be an absolute path")
      }
      downloadsDir = path.resolve(options.downloadsDir)
    }
    return {
      kind,
      headless: options.headless ?? true,
      extensionPaths,
      cdpEndpoint,
      downloadsDir,
      uploadRoots: absolutePathList(options.uploadRoots, "uploadRoots"),
      allowFileUrls: options.allowFileUrls ?? false,
      viewport: clampViewport(options.viewport, this.viewport),
    }
  }

  async createSession(options = {}) {
    const { id, profileId = null, grants = [] } = options
    if (typeof id !== "string" || !id) throw invalidOption("Session id is required")
    this.assertNotShuttingDown()
    const local = this.parseLocalOptions(options)
    if (local) return this.createLocalSession({ id, profileId, grants, ...local })

    await this.fileBridge.ready
    if (this.sessions.has(id))
      throw new RemoteBrowserError("browser_session_exists", "Session exists")
    if (this.sessions.size >= this.maxSessions) {
      throw new RemoteBrowserError("browser_session_quota_exceeded", "Session quota exceeded")
    }
    if (profileId) {
      assertProfileId(profileId)
      if (this.profileOwners.has(profileId)) {
        throw new RemoteBrowserError("browser_profile_in_use", "Browser profile is in use")
      }
    }

    const policy = this.networkPolicyFactory()
    const resolverRules = await policy.resolverRules(grants)
    const browserLaunchOptions = {
      headless: true,
      args: [
        `--host-resolver-rules=${resolverRules}`,
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    }
    const contextOptions = { viewport: this.viewport, acceptDownloads: true }
    let browser = null
    let context
    if (profileId) {
      const profilePath = path.join(this.profilesRoot, profileId)
      await fs.mkdir(profilePath, { recursive: true, mode: 0o700 })
      context = await this.chromium.launchPersistentContext(profilePath, {
        ...browserLaunchOptions,
        ...contextOptions,
      })
      this.profileOwners.set(profileId, id)
    } else {
      browser = await this.chromium.launch(browserLaunchOptions)
      context = await browser.newContext(contextOptions)
    }

    const session = this.newSessionRecord({
      id,
      profileId,
      grants: [...grants],
      policy,
      browser,
      ownsBrowser: Boolean(browser),
      context,
    })
    this.sessions.set(id, session)
    await context.addInitScript(OVERLAY_TRANSPORT_SCRIPT)
    await context.addInitScript(this.overlayScript)
    await context.route("**/*", async (route) => this.authorizeRoute(session, route))
    context.on("page", (page) => this.onContextPage(session, page))
    context.on("close", () => {
      void this.handleConnectionClosed(session).catch(() => undefined)
    })
    browser?.on?.("disconnected", () => {
      void this.handleConnectionClosed(session).catch(() => undefined)
    })
    const firstPage = await context.newPage()
    this.registerPage(session, firstPage)
    return this.summary(id)
  }

  async createLocalSession({ id, profileId, grants, ...local }) {
    if (this.sessions.has(id))
      throw new RemoteBrowserError("browser_session_exists", "Session exists")
    if (this.sessions.size >= this.maxSessions) {
      throw new RemoteBrowserError("browser_session_quota_exceeded", "Session quota exceeded")
    }
    const effectiveProfile = local.kind === "local" ? (profileId ?? "default") : null
    if (effectiveProfile) {
      assertProfileId(effectiveProfile)
      if (this.profileOwners.has(effectiveProfile)) {
        throw new RemoteBrowserError("browser_profile_in_use", "Browser profile is in use")
      }
    }
    const session = this.newSessionRecord({
      id,
      profileId: effectiveProfile,
      grants: Array.isArray(grants) ? [...grants] : [],
      kind: local.kind,
      headless: local.headless,
      extensionPaths: local.extensionPaths,
      downloadsDir: local.downloadsDir,
      uploadRoots: local.uploadRoots,
      allowFileUrls: local.allowFileUrls,
      viewport: local.viewport,
      policy: this.localPolicyFactory({
        allowFileUrls: local.allowFileUrls,
        allowExtensionUrls: local.kind === "local",
      }),
    })
    session.downloads = new LocalDownloadTracker({
      sessionId: id,
      backend: local.kind === "local" ? "local-chromium" : "user-chrome",
      downloadsDir: local.downloadsDir,
      createId: this.createId,
      now: this.now,
      publish: (event) => this.emit(event),
      cancelByGuid: (guid) => session.downloadCdp?.send("Browser.cancelDownload", { guid }),
    })
    this.sessions.set(id, session)
    if (effectiveProfile) this.profileOwners.set(effectiveProfile, id)
    const launch = (async () => {
      try {
        if (local.kind === "local") await this.launchLocalContext(session)
        else await this.connectUserChrome(session, local.cdpEndpoint)
        // Shutdown (or a close) raced the launch: never leave the Chromium it
        // just started running without an owner.
        this.assertNotShuttingDown()
        if (session.closing) {
          throw new RemoteBrowserError("browser_session_not_found", "Session was closed")
        }
      } catch (error) {
        if (this.sessions.get(id) === session) this.sessions.delete(id)
        if (effectiveProfile && this.profileOwners.get(effectiveProfile) === id) {
          this.profileOwners.delete(effectiveProfile)
        }
        // Never close the user's own context: a failed user-chrome attach only
        // disconnects.
        if (session.kind === "user-chrome") await session.browser?.close().catch(() => undefined)
        else await session.context?.close().catch(() => undefined)
        throw error
      }
    })()
    this.pendingLaunches.add(launch)
    try {
      await launch
    } finally {
      this.pendingLaunches.delete(launch)
    }
    return this.summary(id)
  }

  /**
   * Launch Cognia's own Chromium on the session's persistent profile. The
   * full Chromium build (`channel: "chromium"`) runs MV3 extensions in both
   * headed and new-headless mode; Playwright's default `--disable-extensions`
   * is dropped so `--load-extension` takes effect.
   */
  async launchLocalContext(session) {
    const profilePath = path.join(this.profilesRoot, session.profileId)
    await fs.mkdir(profilePath, { recursive: true, mode: 0o700 })
    if (await this.profileHasImportedCookies(session)) session.cookiesImported = true
    await fs.mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
    await fs.mkdir(session.downloadsDir, { recursive: true })
    const args = ["--no-first-run", "--no-default-browser-check"]
    if (session.extensionPaths.length > 0) {
      const list = session.extensionPaths.join(",")
      args.push(`--disable-extensions-except=${list}`, `--load-extension=${list}`)
    }
    const context = await this.chromium.launchPersistentContext(profilePath, {
      channel: "chromium",
      headless: session.headless,
      args,
      ignoreDefaultArgs: ["--disable-extensions"],
      acceptDownloads: true,
      downloadsPath: this.stagingRoot,
      viewport: session.viewport,
    })
    session.context = context
    session.browser = typeof context.browser === "function" ? context.browser() : null
    session.ownsBrowser = false
    // Shutdown began while Chromium was starting: bail out so the caller
    // closes this context instead of wiring it up.
    this.assertNotShuttingDown()
    await context.addInitScript(OVERLAY_TRANSPORT_SCRIPT)
    await context.addInitScript(this.overlayScript)
    await context.exposeBinding(CREDENTIAL_BINDING, (source, payload) =>
      this.onCredentialSubmitted(session, source, payload)
    )
    await context.exposeBinding(SELECTION_SIGNAL_BINDING, (source, payload) =>
      this.onSelectionSignal(session, source, payload)
    )
    await context.addInitScript(CREDENTIAL_CAPTURE_SCRIPT)
    context.on("page", (page) => this.onContextPage(session, page))
    context.on("close", () => {
      if (session.context !== context) return
      void this.handleConnectionClosed(session).catch(() => undefined)
    })
    await this.attachDownloadEvents(session, {
      behavior: "allowAndName",
      downloadPath: this.stagingRoot,
      eventsEnabled: true,
    })
    const existing = typeof context.pages === "function" ? context.pages() : []
    for (const page of existing) this.registerPage(session, page)
    if (session.pages.size === 0) this.registerPage(session, await context.newPage())
  }

  /**
   * Attach to the user's running Chrome through its consent-gated remote
   * debugging endpoint. Agent tabs open in a dedicated window of the user's
   * default context; only those tabs (and popups they open) belong to the
   * session. Closing the session disconnects and never closes the browser.
   */
  async connectUserChrome(session, cdpEndpoint) {
    let browser
    try {
      browser = await this.chromium.connectOverCDP(cdpEndpoint, {
        timeout: this.userChromeConnectTimeoutMs,
      })
    } catch (error) {
      throw new RemoteBrowserError(
        "browser_user_chrome_connect_failed",
        error instanceof Error ? error.message : String(error)
      )
    }
    const context = browser.contexts()[0]
    if (!context) {
      await browser.close().catch(() => undefined)
      throw new RemoteBrowserError(
        "browser_user_chrome_connect_failed",
        "The user's browser exposes no default context"
      )
    }
    session.browser = browser
    session.ownsBrowser = false
    session.context = context
    session.browserCdp = await browser.newBrowserCDPSession()
    browser.on?.("disconnected", () => {
      void this.handleConnectionClosed(session).catch(() => undefined)
    })
    context.on("page", (page) => {
      void this.adoptUserChromePopup(session, page).catch(() => undefined)
    })
    await this.attachDownloadEvents(session, { behavior: "default", eventsEnabled: true })
    await this.openUserChromeTab(session, { newWindow: true })
  }

  async attachDownloadEvents(session, behavior) {
    const browser = session.browser
    if (!browser || typeof browser.newBrowserCDPSession !== "function") return
    try {
      const cdp = await browser.newBrowserCDPSession()
      cdp.on("Browser.downloadWillBegin", (event) => {
        if (session.kind === "user-chrome" && !session.targetIds.has(event.frameId)) return
        session.downloads.onWillBegin(event)
      })
      cdp.on("Browser.downloadProgress", (event) => session.downloads.onProgress(event))
      await cdp.send("Browser.setDownloadBehavior", behavior)
      session.downloadCdp = cdp
    } catch {
      // Progress is best-effort: Playwright still reports completion for
      // launched Chromium, and user-chrome downloads stay in the user's Chrome.
    }
  }

  async pageTargetId(session, page) {
    const cached = session.pageTargetIds.get(page)
    if (cached) return cached
    const cdp = await session.context.newCDPSession(page)
    try {
      const { targetInfo } = await cdp.send("Target.getTargetInfo")
      session.pageTargetIds.set(page, targetInfo.targetId)
      return targetInfo.targetId
    } finally {
      await cdp.detach().catch(() => undefined)
    }
  }

  async waitForTargetPage(session, targetId, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      for (const page of session.context.pages()) {
        const pageTarget = await this.pageTargetId(session, page).catch(() => null)
        if (pageTarget === targetId) return page
      }
      if (Date.now() > deadline) {
        throw new RemoteBrowserError("browser_page_not_found", "The new tab did not appear")
      }
      await delay(25)
    }
  }

  async openUserChromeTab(session, { newWindow }) {
    const cdp = session.browserCdp
    if (!newWindow) {
      const anchor = session.targetIds.values().next().value
      if (anchor)
        await cdp.send("Target.activateTarget", { targetId: anchor }).catch(() => undefined)
    }
    const { targetId } = await cdp.send("Target.createTarget", {
      url: "about:blank",
      ...(newWindow ? { newWindow: true } : {}),
    })
    session.targetIds.add(targetId)
    const page = await this.waitForTargetPage(session, targetId)
    await page.addInitScript(OVERLAY_TRANSPORT_SCRIPT)
    await page.addInitScript(this.overlayScript)
    await this.exposeSelectionSignal(session, page)
    const pageId = this.registerPage(session, page)
    if (!pageId) throw new RemoteBrowserError("browser_page_quota_exceeded", "Page quota exceeded")
    return { page, pageId }
  }

  async adoptUserChromePopup(session, page) {
    if (session.pageIds.get(page)) return
    const opener = typeof page.opener === "function" ? await page.opener() : null
    const openerId = opener ? session.pageIds.get(opener) : undefined
    if (!openerId) return
    const targetId = await this.pageTargetId(session, page).catch(() => null)
    if (targetId) session.targetIds.add(targetId)
    await page.addInitScript(OVERLAY_TRANSPORT_SCRIPT)
    await page.addInitScript(this.overlayScript)
    await this.exposeSelectionSignal(session, page)
    const pageId = this.registerPage(session, page)
    if (pageId) await this.linkOpener(session, pageId, openerId)
  }

  /** A page the browser context opened: register it, then find out who opened it. */
  onContextPage(session, page) {
    const pageId = this.registerPage(session, page)
    if (!pageId) return
    void this.adoptOpener(session, page, pageId).catch(() => undefined)
  }

  async adoptOpener(session, page, pageId) {
    const opener = typeof page.opener === "function" ? await page.opener() : null
    const openerId = opener ? session.pageIds.get(opener) : undefined
    if (openerId) await this.linkOpener(session, pageId, openerId)
  }

  /**
   * Record that `openerId` opened `pageId` (reported as `openerId`, so a
   * client can give the popup to whoever owns its opener), and bring the
   * popup forward when its opener was the page in front — what a browser does
   * when the tab you are using opens a window.
   */
  async linkOpener(session, pageId, openerId) {
    const record = session.pages.get(pageId)
    if (!record || pageId === openerId) return
    record.openerPageId = openerId
    this.schedulePagesChanged(session)
    if (session.activePageId === openerId) await this.setActivePage(session, pageId)
  }

  /**
   * Put `pageId` in front: the page unaddressed operations act on and the one
   * the screencast shows. The screencast follows here — it is attached to one
   * page, so switching tabs without moving it kept streaming the old tab.
   */
  async setActivePage(session, pageId) {
    if (!session.pages.has(pageId)) {
      throw new RemoteBrowserError("browser_page_not_found", "Page not found")
    }
    if (session.activePageId !== pageId) {
      session.activePageId = pageId
      this.schedulePagesChanged(session)
    }
    await this.retargetScreencast(session)
  }

  /**
   * Re-attach a running screencast to the page in front, if it is on another
   * one. Serialized per session: two quick tab switches must not leave two
   * screencasts attached, or the last one detached.
   */
  retargetScreencast(session) {
    const run = async () => {
      const request = session.screencastRequest
      if (!request || session.closing || session.restarting) return
      if (session.screencast?.pageId === session.activePageId) return
      if (session.screencast) await this.stopScreencast(session.id).catch(() => undefined)
      if (!session.activePageId) return
      await this.startScreencast(session.id, request.onFrame, { quality: request.quality })
    }
    session.screencastRetarget = (session.screencastRetarget ?? Promise.resolve())
      .then(run)
      .catch(() => undefined)
    return session.screencastRetarget
  }

  onCredentialSubmitted(session, source, payload) {
    if (this.mode !== "local" || session.kind !== "local" || session.closing) return
    if (!payload || typeof payload.password !== "string" || !payload.password) return
    if (payload.password.length > 1024) return
    const username = typeof payload.username === "string" ? payload.username.slice(0, 512) : ""
    const origin = source?.frame ? frameOrigin(source.frame) : null
    if (!origin || !/^https?:\/\//.test(origin)) return
    const signature = crypto
      .createHash("sha256")
      .update(`${origin}\u0000${username}\u0000${payload.password}`)
      .digest("hex")
    const at = this.now()
    for (const [key, seenAt] of session.recentCredentials) {
      if (at - seenAt > CREDENTIAL_DEDUPE_MS) session.recentCredentials.delete(key)
    }
    if (session.recentCredentials.has(signature)) return
    session.recentCredentials.set(signature, at)
    const pageId = source.page ? session.pageIds.get(source.page) : undefined
    this.emit({
      type: "credential.submitted",
      sessionId: session.id,
      ...(pageId ? { pageId } : {}),
      origin,
      username,
      password: payload.password,
      sensitive: true,
    })
  }

  async authorizeRoute(session, route) {
    const request = route.request()
    try {
      await session.policy.authorize(request.url(), session.grants)
      await route.continue()
    } catch (error) {
      if (error.hostname) session.blockedDomains.add(error.hostname)
      session.lastBlockedError = error
      await route.abort("blockedbyclient")
    }
  }

  schedulePagesChanged(session) {
    if (session.closing || session.restarting || session.pagesChangedTimer) return
    session.pagesChangedTimer = setTimeout(() => {
      session.pagesChangedTimer = null
      if (session.closing || !this.sessions.has(session.id)) return
      void this.pageSummaries(session)
        .then((pages) =>
          this.emit({
            type: "pages.changed",
            sessionId: session.id,
            pages,
            activePageId: session.activePageId,
          })
        )
        .catch(() => undefined)
    }, this.eventDebounceMs)
    session.pagesChangedTimer.unref?.()
  }

  pageSummaries(session) {
    return Promise.all(
      [...session.pages.entries()].map(([pageId, record]) =>
        pageSummary(record, pageId, session.activePageId)
      )
    )
  }

  registerPage(session, page) {
    const existing = session.pageIds.get(page)
    if (existing) return existing
    if (session.pages.size >= this.maxPages) {
      void page.close()
      return null
    }
    const pageId = this.createId()
    const record = {
      page,
      generation: 0,
      cdp: null,
      emulationCdp: null,
      openerPageId: null,
      console: [],
      network: [],
      ...newActionLane(),
    }
    session.pageIds.set(page, pageId)
    session.pages.set(pageId, record)
    // A new page takes the front only when nothing has it yet. Who else gets
    // it is decided by whoever opened the page: `createPage` (when asked to
    // activate) and a popup whose opener was in front (`adoptOpener`). A tab
    // opened for a task in the background must not swap the page the user is
    // watching.
    if (session.activePageId === null) session.activePageId = pageId
    this.schedulePagesChanged(session)
    page.on("close", () => {
      void this.dismissPendingDialog(session, pageId).catch(() => undefined)
      if (session.pendingFileChooser?.pageId === pageId) session.pendingFileChooser = null
      session.pages.delete(pageId)
      this.invalidatePage(session.id, pageId)
      if (session.activePageId === pageId) {
        session.activePageId = session.pages.keys().next().value ?? null
        void this.retargetScreencast(session)
      }
      this.schedulePagesChanged(session)
    })
    page.on("framenavigated", (frame) => {
      if (frame === pageMainFrame(page)) this.schedulePagesChanged(session)
    })
    if (session.uploadRoots?.length) {
      // Local mode with upload roots (ADR-0201): a headless page has no native file dialog, so
      // the chooser is intercepted and handed to the host, which lets the
      // user pick files, stages copies under the upload root and answers
      // with `browser.filechooser.set`. A newer chooser replaces an
      // unanswered one.
      page.on("filechooser", (chooser) => {
        const chooserId = this.createId()
        const multiple = chooser.isMultiple()
        session.pendingFileChooser = { id: chooserId, chooser, pageId, multiple }
        this.emit({
          type: "filechooser.opened",
          sessionId: session.id,
          pageId,
          chooserId,
          multiple,
        })
      })
    }
    page.on("dialog", (dialog) => {
      if (record.pendingDialog) {
        void dialog.dismiss().catch(() => undefined)
        return
      }
      const pending = {
        dialog,
        pageId,
        /** The lane whose action ran into this dialog, once one claims it. */
        lane: null,
        metadata: {
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
        },
      }
      record.pendingDialog = pending
      this.emit({
        type: "dialog.opened",
        sessionId: session.id,
        pageId,
        dialog: pending.metadata,
      })
      // This page's own action, or a page-less one (a tab still being
      // created) — never an action running on another tab.
      for (const resolve of [...record.dialogWaiters, ...session.actionLane.dialogWaiters]) {
        resolve(pending)
      }
    })
    page.on("console", (message) => {
      const type = message.type()
      const text = message.text()
      record.console.push({
        level: ["log", "info", "warn", "error", "debug"].includes(type) ? type : "log",
        text: session.humanKeyboardInputOccurred || SECRET_FIELD.test(text) ? "[REDACTED]" : text,
        ts: Date.now(),
      })
    })
    const started = new WeakMap()
    page.on("request", (request) => started.set(request, Date.now()))
    page.on("response", (response) => {
      const request = response.request()
      const requestUrl = new URL(request.url())
      if (session.humanKeyboardInputOccurred) {
        requestUrl.search = ""
        requestUrl.hash = ""
      }
      session.requestSeq += 1
      const requestId = `r${session.requestSeq}`
      session.requests.set(requestId, { request, response })
      if (session.requests.size > MAX_TRACKED_REQUESTS) {
        session.requests.delete(session.requests.keys().next().value)
      }
      record.network.push({
        id: requestId,
        url: requestUrl.toString(),
        method: request.method(),
        status: response.status(),
        ok: response.ok(),
        durationMs: started.has(request) ? Date.now() - started.get(request) : null,
      })
    })
    page.on("download", async (download) => {
      if (session.downloads) {
        await session.downloads.onPlaywrightDownload(download).catch(() => undefined)
        return
      }
      try {
        const downloadPath = await download.path()
        if (!downloadPath) return
        const bytes = await fs.readFile(downloadPath)
        const summary = await this.fileBridge.quarantineDownload(
          session.id,
          download.suggestedFilename(),
          bytes
        )
        this.emit({
          type: "download.updated",
          sessionId: session.id,
          download: { ...summary, backend: "remote" },
        })
      } catch {
        // Download failures surface through the browser action/diagnostic path.
      }
    })
    return pageId
  }

  async summary(sessionId) {
    const session = this.requireSession(sessionId)
    return {
      id: session.id,
      profileId: session.profileId,
      ...(session.kind === "cloud" ? {} : { kind: session.kind }),
      pages: await this.listPages(sessionId),
      activePageId: session.activePageId,
      blockedDomains: [...session.blockedDomains],
    }
  }

  async listPages(sessionId) {
    const session = this.requireSession(sessionId)
    return this.pageSummaries(session)
  }

  /**
   * Bring a tab forward. A dialog pending on another tab does not stop it:
   * that dialog belongs to its own tab and stays pending there.
   */
  async activatePage(sessionId, pageId) {
    const session = this.requireSession(sessionId)
    const record = session.pages.get(pageId)
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "Page not found")
    await record.page.bringToFront()
    await this.setActivePage(session, pageId)
  }

  /** Close a tab, dismissing a dialog it was holding open rather than refusing. */
  async closePage(sessionId, pageId) {
    const session = this.requireSession(sessionId)
    const record = session.pages.get(pageId)
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "Page not found")
    await this.dismissPendingDialog(session, pageId)
    await record.page.close()
  }

  /**
   * Open a tab. `activate: false` opens it behind the page in front — a tab
   * for a task the user is not looking at — and leaves the screencast alone.
   */
  async createPage(sessionId, url = "about:blank", { activate = true } = {}) {
    const session = this.requireSession(sessionId)
    if (session.pages.size >= this.maxPages) {
      throw new RemoteBrowserError("browser_page_quota_exceeded", "Page quota exceeded")
    }
    if (url !== "about:blank") await session.policy.authorize(url, session.grants)
    return this.runActionWithDialog(
      session,
      0,
      async () => {
        let page
        let pageId
        if (session.kind === "user-chrome") {
          ;({ page, pageId } = await this.openUserChromeTab(session, {
            newWindow: session.pages.size === 0,
          }))
        } else {
          page = await session.context.newPage()
          pageId = this.registerPage(session, page)
        }
        if (!pageId)
          throw new RemoteBrowserError("browser_page_quota_exceeded", "Page quota exceeded")
        if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded" })
        if (activate) await this.setActivePage(session, pageId)
        this.schedulePagesChanged(session)
        const record = session.pages.get(pageId)
        return pageSummary(record, pageId, session.activePageId)
      },
      session.actionLane
    )
  }

  async navigate(sessionId, url) {
    const session = this.requireSession(sessionId)
    const { pageId, page, record } = this.activeRecord(session)
    const fromUrl = page.url()
    await session.policy.authorize(url, session.grants)
    return this.runActionWithDialog(session, record.generation, async () => {
      session.lastBlockedError = null
      try {
        await page.goto(url, { waitUntil: "domcontentloaded" })
      } catch (error) {
        if (session.lastBlockedError) throw session.lastBlockedError
        throw error
      }
      try {
        await session.policy.authorizeRedirect(fromUrl, page.url(), session.grants)
      } catch (error) {
        await page.evaluate(() => window.stop()).catch(() => undefined)
        throw error
      }
      this.invalidatePage(session.id, pageId)
      await this.applyZoom(session)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async snapshot(sessionId, options = {}) {
    const session = this.requireSession(sessionId)
    const { pageId, record } = this.activeRecord(session)
    record.generation += 1
    this.invalidatePage(sessionId, pageId)
    const nodes = []
    let url = record.page.url()
    let title = await record.page.title()
    const mainFrame = pageMainFrame(record.page)
    for (const frame of record.page.frames()) {
      let frameSnapshot
      try {
        frameSnapshot = parseEnvelope(
          await frame.evaluate(({ includeText }) => window.__cogniaSnapshot({ includeText }), {
            includeText: !!options.includeText,
          })
        )
      } catch {
        continue
      }
      if (frame === mainFrame) {
        url = frameSnapshot.url || url
        title = frameSnapshot.title || title
      }
      for (const node of frameSnapshot.nodes ?? []) {
        if (SECRET_FIELD.test(`${node.name} ${node.tag} ${node.type ?? ""}`)) continue
        const opaqueRef = this.createId()
        this.references.set(opaqueRef, {
          sessionId,
          pageId,
          generation: record.generation,
          frame,
          nativeRef: node.ref,
        })
        nodes.push({
          ...node,
          ref: opaqueRef,
          value: node.value,
          ...(frame === mainFrame ? {} : { frame: true }),
        })
      }
    }
    return {
      generation: record.generation,
      url,
      title,
      nodes,
      blockedDomains: [...session.blockedDomains],
    }
  }

  async act(sessionId, reference, action, args) {
    const session = this.requireSession(sessionId)
    const generation = this.activeRecord(session).record.generation
    const modifiers = Array.isArray(args?.modifiers)
      ? args.modifiers.map((modifier) => {
          const value = String(modifier).toLowerCase()
          if (value === "ctrl" || value === "control") return "Control"
          if (value === "cmd" || value === "meta") return "Meta"
          if (value === "alt" || value === "option") return "Alt"
          if (value === "shift") return "Shift"
          return String(modifier)
        })
      : []
    const clickOptions = modifiers.length ? { modifiers } : undefined
    return this.runActionWithDialog(session, generation, async () => {
      const { element, dispose } = await this.resolveTarget(session, reference)
      try {
        if (
          await element.evaluate((node) => {
            const descriptor = [
              node.getAttribute?.("type"),
              node.getAttribute?.("name"),
              node.id,
              node.getAttribute?.("autocomplete"),
              node.getAttribute?.("placeholder"),
              node.getAttribute?.("aria-label"),
            ].join(" ")
            return /password|passcode|one[\s-]?time|otp|token|secret|verification[\s-]?code|密码|口令|验证码/i.test(
              descriptor
            )
          })
        ) {
          throw new RemoteBrowserError(
            "browser_human_input_required",
            "Credential fields require human takeover"
          )
        }
        if (action === "click") await element.click(clickOptions)
        else if (action === "double_click") await element.dblclick(clickOptions)
        else if (action === "hover") await element.hover()
        else if (action === "focus") await element.focus()
        else if (action === "fill") await element.fill(String(args?.text ?? ""))
        else if (action === "type") await element.pressSequentially(String(args?.text ?? ""))
        else if (action === "select") await element.selectOption(args?.value)
        else if (action === "key") await element.press(String(args?.key ?? ""))
        else if (action === "scroll") await element.scrollIntoViewIfNeeded()
        else throw new RemoteBrowserError("browser_action_invalid", "Unsupported browser action")
        return { ok: true, error: null, generation }
      } finally {
        await dispose()
      }
    })
  }

  async drag(sessionId, sourceRef, targetRef) {
    const session = this.requireSession(sessionId)
    const generation = this.activeRecord(session).record.generation
    return this.runActionWithDialog(session, generation, async () => {
      const source = await this.resolveTarget(session, sourceRef)
      const target = await this.resolveTarget(session, targetRef)
      if (source.generation !== target.generation) {
        await Promise.allSettled([source.dispose(), target.dispose()])
        throw new RemoteBrowserError("browser_stale_ref", "Browser reference is stale")
      }
      try {
        await source.element.dragTo(target.element)
        return { ok: true, error: null, generation: source.generation }
      } finally {
        await Promise.allSettled([source.dispose(), target.dispose()])
      }
    })
  }

  /**
   * Answer a dialog: the addressed page's, else the one in front, else — for a
   * caller that cannot know which tab raised it — whichever tab has one.
   */
  async handleDialog(sessionId, { accept, promptText } = {}) {
    const session = this.requireSession(sessionId)
    const pending = this.pendingDialogFor(session)
    if (!pending) {
      throw new RemoteBrowserError("browser_dialog_not_found", "No browser dialog is pending")
    }
    const holder = session.pages.get(pending.pageId)
    const lane = pending.lane
    const action = lane?.pendingAction ?? null
    try {
      if (accept) await pending.dialog.accept(promptText)
      else await pending.dialog.dismiss()
      let actionError = null
      if (action) {
        try {
          await action
        } catch (error) {
          actionError = error instanceof Error ? error.message : String(error)
        }
      }
      return {
        ok: actionError === null,
        error: actionError,
        generation: holder?.generation ?? 0,
      }
    } finally {
      if (holder?.pendingDialog === pending) holder.pendingDialog = null
      if (lane) {
        lane.pendingAction = null
        lane.actionInFlight = false
      }
    }
  }

  pendingDialogFor(session) {
    const target = pageTarget.getStore()
    if (target && target.sessionId === session.id) {
      return session.pages.get(target.pageId)?.pendingDialog ?? null
    }
    const active = session.activePageId ? session.pages.get(session.activePageId) : null
    if (active?.pendingDialog) return active.pendingDialog
    for (const record of session.pages.values()) {
      if (record.pendingDialog) return record.pendingDialog
    }
    return null
  }

  async pressKey(sessionId, key, reference = "") {
    if (reference) return this.act(sessionId, reference, "key", { key })
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    return this.runActionWithDialog(session, record.generation, async () => {
      const sensitive = await page.evaluate(() => {
        const element = document.activeElement
        if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          return false
        }
        const descriptor = [
          element.type,
          element.name,
          element.id,
          element.autocomplete,
          element.placeholder,
          element.getAttribute("aria-label"),
        ].join(" ")
        return /password|passcode|one[\s-]?time|otp|token|secret|verification[\s-]?code|密码|口令|验证码/i.test(
          descriptor
        )
      })
      if (sensitive) {
        throw new RemoteBrowserError(
          "browser_human_input_required",
          "Credential fields require human takeover"
        )
      }
      await page.keyboard.press(key)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async scroll(sessionId, { reference = "", direction = "down", amount = 600 }) {
    if (reference) return this.act(sessionId, reference, "scroll", { direction, amount })
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    const edgeDelta = 10_000_000
    const x = direction === "left" ? -amount : direction === "right" ? amount : 0
    const y =
      direction === "top"
        ? -edgeDelta
        : direction === "bottom"
          ? edgeDelta
          : direction === "up"
            ? -amount
            : direction === "down"
              ? amount
              : 0
    return this.runActionWithDialog(session, record.generation, async () => {
      await page.mouse.wheel(x, y)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async evaluate(sessionId, expression) {
    const session = this.requireSession(sessionId)
    // After a human typed into the page (or a vault credential was filled),
    // arbitrary script could read the entered secrets back out of the DOM.
    if (session.humanKeyboardInputOccurred) {
      throw new RemoteBrowserError(
        "browser_human_input_required",
        "browser_evaluate is disabled after human input or a credential fill in this session"
      )
    }
    const { page, record } = this.activeRecord(session)
    const hostname = new URL(page.url()).hostname
    if (!["localhost", "127.0.0.1", "::1"].includes(hostname)) {
      return { ok: false, error: "browser_evaluate is disabled on public origins" }
    }
    return this.runActionWithDialog(session, record.generation, async () => {
      try {
        return {
          ok: true,
          value: await page.evaluate((source) => globalThis.eval(source), expression),
        }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    })
  }

  async getPage(sessionId) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    return { url: page.url(), title: await page.title() }
  }

  // CSS `zoom` reflows into the JPEG screencast (unlike CDP setPageScaleFactor,
  // which is pinch-only). It resets on navigation, so `applyZoom` re-applies the
  // session's factor after every navigate/history.
  async setZoom(sessionId, zoom) {
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    const numeric = Number(zoom)
    const factor = Number.isFinite(numeric) ? Math.min(5, Math.max(0.25, numeric)) : 1
    return this.runActionWithDialog(session, record.generation, async () => {
      session.zoom = factor
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value)
      }, factor)
      return { ok: true, zoom: factor }
    })
  }

  async applyZoom(session) {
    const factor = session.zoom
    if (!factor || factor === 1) return
    try {
      const { page } = this.activeRecord(session)
      await page.evaluate((value) => {
        document.documentElement.style.zoom = String(value)
      }, factor)
    } catch {
      // Page may be mid-navigation; the next navigate re-applies.
    }
  }

  // Find-in-page runs the injected `__cogniaFind` helper directly (NOT the
  // localhost-gated `evaluate`), so it works on any origin the session allows.
  async find(sessionId, query, options = {}) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    return page.evaluate((args) => window.__cogniaFind(args.query, args.options || {}), {
      query: String(query ?? ""),
      options: options ?? {},
    })
  }

  async findClear(sessionId) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    await page.evaluate(() => window.__cogniaFindClear())
    return { ok: true }
  }

  // ---- Element pick and Browser Adjust (ADR-0214) ---------------------------
  // Each op calls one fixed overlay function with JSON arguments, never caller
  // JS, so like `find` it skips the loopback- and keyboard-gated `evaluate`.
  // What the page answers is untrusted and checked in element-selection.mjs.

  /** Arm or disarm the in-page picker on the addressed (else the front) page. */
  async setSelectMode(sessionId, on, labels) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    const panelLabels = normalizePanelLabels(labels)
    const armed = await page.evaluate(
      (args) => {
        if (typeof window.__cogniaSetSelectMode !== "function") return false
        if (args.labels && typeof window.__cogniaSetPanelLabels === "function") {
          window.__cogniaSetPanelLabels(args.labels)
        }
        window.__cogniaSetSelectMode(args.on)
        return true
      },
      { on: Boolean(on), labels: panelLabels ? JSON.stringify(panelLabels) : null }
    )
    if (!armed) throw overlayUnavailable()
    return { ok: true, on: Boolean(on) }
  }

  /** Take the picks the overlay buffered since the last drain. */
  async drainSelection(sessionId) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page, pageId } = this.activeRecord(session)
    const raw = await page.evaluate(() =>
      typeof window.__cogniaGetSelection === "function" ? window.__cogniaGetSelection() : null
    )
    if (raw === null) throw overlayUnavailable()
    return selectionResult(() => normalizeSelectionDrain(raw, selectionPaneId(pageId)))
  }

  /** Drop the picks and the in-page info panel (the comment was sent or cancelled). */
  async clearSelection(sessionId) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    await page.evaluate(() => {
      if (typeof window.__cogniaClearSelection === "function") window.__cogniaClearSelection()
    })
    return { ok: true }
  }

  /** The selection payload for a snapshot ref (`browser_annotate`). */
  async selectionForRef(sessionId, reference) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { pageId, record } = this.activeRecord(session)
    const target = this.references.get(String(reference ?? ""))
    if (
      !target ||
      target.sessionId !== session.id ||
      target.pageId !== pageId ||
      target.generation !== record.generation
    ) {
      return { ok: false, error: `Unknown or stale ref: ${String(reference)}`, selection: null }
    }
    const raw = await target.frame.evaluate(
      (ref) =>
        typeof window.__cogniaSelectionForRef === "function"
          ? window.__cogniaSelectionForRef(ref)
          : null,
      target.nativeRef
    )
    if (raw === null) throw overlayUnavailable()
    return selectionResult(() => normalizeSelectionForRef(raw, selectionPaneId(pageId)))
  }

  /** Browser Adjust: preview or revert a draft; resolves the overlay's JSON answer. */
  async adjust(sessionId, action, input) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    let request
    try {
      request = normalizeAdjustRequest(action, input)
    } catch (error) {
      throw new RemoteBrowserError("browser_option_invalid", error.message)
    }
    const raw = await page.evaluate(
      (args) =>
        typeof window.__cogniaAdjust === "function"
          ? window.__cogniaAdjust(args.action, args.json)
          : null,
      { action: request.action, json: JSON.stringify(request.input) }
    )
    if (raw === null) throw overlayUnavailable()
    return selectionResult(() => ({ ok: true, result: normalizeAdjustResult(raw) }))
  }

  /**
   * A user-chrome tab lives in the user's own browser context, so the pick
   * signal is bound per tab Cognia drives rather than on the whole context.
   */
  async exposeSelectionSignal(session, page) {
    if (typeof page.exposeBinding !== "function") return
    await page.exposeBinding(SELECTION_SIGNAL_BINDING, (source, payload) =>
      this.onSelectionSignal(session, source, payload)
    )
  }

  /**
   * The overlay's page→runtime pick signal. The embedded webview gets the same
   * `{count, generation}` from a sentinel navigation it intercepts; here it is a
   * Playwright binding, forwarded as an `element.selected` event so the pane
   * showing that page drains it. Only a page's main frame picks. The page's
   * `generation` is checked but not forwarded (see below).
   */
  onSelectionSignal(session, source, payload) {
    if (session.closing) return
    const page = source?.page
    const pageId = page ? session.pageIds.get(page) : undefined
    if (!pageId) return
    if (source.frame && source.frame !== pageMainFrame(page)) return
    const count = Number(payload?.count)
    const generation = Number(payload?.generation)
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_SELECTIONS) return
    if (!Number.isSafeInteger(generation) || generation < 1) return
    const record = session.pages.get(pageId)
    if (!record) return
    // The page's own generation restarts with every document; the pane
    // dedupes on this one, which only grows for the page's lifetime.
    record.selectionSignals = (record.selectionSignals ?? 0) + 1
    this.emit({
      type: "element.selected",
      sessionId: session.id,
      pageId,
      count,
      generation: record.selectionSignals,
    })
  }

  /** The addressed (else the front) page's console since the last read. */
  async readConsole(sessionId) {
    const record = this.addressedRecordOrNull(this.requireSession(sessionId))
    return record ? record.console.splice(0) : []
  }

  /** The addressed (else the front) page's requests since the last read. */
  async readNetwork(sessionId) {
    const record = this.addressedRecordOrNull(this.requireSession(sessionId))
    return record ? record.network.splice(0) : []
  }

  async history(sessionId, operation) {
    const session = this.requireSession(sessionId)
    const { pageId, page, record } = this.activeRecord(session)
    return this.runActionWithDialog(session, record.generation, async () => {
      await page[operation]({ waitUntil: "domcontentloaded" })
      this.invalidatePage(sessionId, pageId)
      await this.applyZoom(session)
      return { ok: true, error: null, generation: record.generation }
    })
  }

  back(sessionId) {
    return this.history(sessionId, "goBack")
  }

  forward(sessionId) {
    return this.history(sessionId, "goForward")
  }

  reload(sessionId) {
    return this.history(sessionId, "reload")
  }

  async stop(sessionId) {
    const session = this.requireSession(sessionId)
    const { page, record } = this.activeRecord(session)
    return this.runActionWithDialog(session, record.generation, async () => {
      await page.evaluate(() => window.stop())
      return { ok: true, error: null, generation: record.generation }
    })
  }

  async waitForText(sessionId, text, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() =>
      page.getByText(text, { exact: false }).waitFor({
        state: options.mode === "disappear" ? "hidden" : "visible",
        timeout: options.timeoutMs ?? 5000,
      })
    )
  }

  async waitForSelector(sessionId, selector, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() =>
      page.locator(selector).waitFor({
        state: options.mode === "disappear" ? "hidden" : "visible",
        timeout: options.timeoutMs ?? 5000,
      })
    )
  }

  async waitForNetworkIdle(sessionId, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() =>
      page.waitForLoadState("networkidle", { timeout: options.timeoutMs ?? 10000 })
    )
  }

  async waitForLoad(sessionId, options = {}) {
    const page = this.activeRecord(this.requireSession(sessionId)).page
    return this.waitFor(() => page.waitForLoadState("load", { timeout: options.timeoutMs ?? 8000 }))
  }

  async waitFor(callback) {
    try {
      await callback()
      return { ok: true, timedOut: false }
    } catch (error) {
      if (String(error).toLowerCase().includes("timeout")) return { ok: false, timedOut: true }
      throw error
    }
  }

  async screenshot(sessionId, options = {}) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    const scope = options.scope ?? (options.ref ? "element" : "viewport")
    if (scope === "element") {
      if (!options.ref) {
        throw new RemoteBrowserError(
          "browser_screenshot_ref_required",
          "Element screenshot requires a ref"
        )
      }
      const target = await this.resolveTarget(session, options.ref)
      try {
        const [bytes, box] = await Promise.all([
          target.element.screenshot({ type: "png" }),
          target.element.boundingBox(),
        ])
        if (!box)
          throw new RemoteBrowserError("browser_element_not_visible", "Element is not visible")
        return {
          bytes: bytes.toString("base64"),
          width: Math.round(box.width),
          height: Math.round(box.height),
          capturedAt: Date.now(),
          format: "png",
        }
      } finally {
        await target.dispose()
      }
    }
    const bytes = await page.screenshot({
      type: "png",
      ...(scope === "fullPage" ? { fullPage: true } : {}),
    })
    const viewport =
      scope === "fullPage"
        ? await page.evaluate(() => ({
            width: Math.max(
              document.documentElement.scrollWidth,
              document.body?.scrollWidth ?? 0,
              window.innerWidth
            ),
            height: Math.max(
              document.documentElement.scrollHeight,
              document.body?.scrollHeight ?? 0,
              window.innerHeight
            ),
          }))
        : (page.viewportSize() ?? this.viewport)
    return {
      bytes: bytes.toString("base64"),
      width: viewport.width,
      height: viewport.height,
      capturedAt: Date.now(),
      format: "png",
    }
  }

  async setFiles(sessionId, reference, relativePaths) {
    const session = this.requireSession(sessionId)
    const { pageId, record } = this.activeRecord(session)
    const paths =
      session.uploadRoots === null
        ? await this.fileBridge.resolveUploads(relativePaths)
        : await resolveLocalUploads(relativePaths, session.uploadRoots)
    return this.runActionWithDialog(session, record.generation, async () => {
      const target = this.references.get(reference)
      if (
        !target ||
        target.sessionId !== sessionId ||
        target.pageId !== pageId ||
        target.generation !== record.generation
      ) {
        throw new RemoteBrowserError("browser_stale_ref", "Browser reference is stale")
      }
      const handle = await target.frame.evaluateHandle(
        (ref) => window.__cogniaOverlay.resolveRef(ref),
        target.nativeRef
      )
      const element = handle.asElement()
      if (!element) {
        await handle.dispose()
        throw new RemoteBrowserError("browser_invalid_file_target", "Ref is not an element")
      }
      try {
        await element.setInputFiles(paths)
        return { ok: true, error: null, generation: record.generation }
      } finally {
        await handle.dispose()
      }
    })
  }

  /**
   * Answer the pending file chooser `chooserId` (local mode). An empty `paths`
   * cancels it (the input keeps its files); otherwise every path must resolve
   * under the session's upload roots, exactly as `browser.files.set`. One
   * answer per chooser, whether it succeeded or not.
   */
  async setFileChooserFiles(sessionId, chooserId, paths) {
    const session = this.requireSession(sessionId)
    const pending = session.pendingFileChooser
    if (!session.uploadRoots?.length || !pending || pending.id !== chooserId) {
      throw new RemoteBrowserError(
        "browser_file_chooser_not_found",
        "No matching file chooser is pending"
      )
    }
    session.pendingFileChooser = null
    if (!Array.isArray(paths) || paths.length === 0) return { ok: true, cancelled: true }
    if (!pending.multiple && paths.length > 1) {
      throw new RemoteBrowserError(
        "browser_upload_invalid",
        "This file input accepts a single file"
      )
    }
    const resolved = await resolveLocalUploads(paths, session.uploadRoots)
    await pending.chooser.setFiles(resolved)
    return { ok: true, cancelled: false }
  }

  listDownloads(sessionId) {
    const session = this.requireSession(sessionId)
    if (session.downloads) return session.downloads.list()
    return this.fileBridge
      .listDownloads(sessionId)
      .map((download) => ({ ...download, backend: "remote" }))
  }

  /**
   * Stream the page in front — never an addressed one: the screencast is what
   * the user sees, and `setActivePage` moves it when the front page changes.
   */
  async startScreencast(sessionId, onFrame, { quality = 70 } = {}) {
    const session = this.requireSession(sessionId)
    const pageId = session.activePageId
    const record = pageId ? session.pages.get(pageId) : null
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "No active page")
    const { page } = record
    if (session.screencast) await this.stopScreencast(sessionId)
    session.screencastRequest = { onFrame, quality }
    const cdp = await session.context.newCDPSession(page)
    const state = { cdp, pageId, sequence: 0, pending: null }
    session.screencast = state
    cdp.on("Page.screencastFrame", async (event) => {
      if (state.pending) return
      state.sequence += 1
      state.pending = { sequence: state.sequence, cdpSessionId: event.sessionId }
      const viewport = page.viewportSize() ?? this.viewport
      await onFrame(
        encodeMediaFrame({
          sequence: state.sequence,
          width: viewport.width,
          height: viewport.height,
          timestamp: Date.now(),
          jpeg: Buffer.from(event.data, "base64"),
        })
      )
    })
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: Math.max(60, Math.min(80, quality)),
      maxWidth: 1600,
      maxHeight: 1200,
      everyNthFrame: 1,
    })
  }

  async ackScreencastFrame(sessionId, sequence) {
    const state = this.requireSession(sessionId).screencast
    if (!state?.pending || state.pending.sequence !== sequence) return false
    await state.cdp.send("Page.screencastFrameAck", { sessionId: state.pending.cdpSessionId })
    state.pending = null
    return true
  }

  async stopScreencast(sessionId) {
    const session = this.requireSession(sessionId)
    if (!session.screencast) return
    await session.screencast.cdp.send("Page.stopScreencast")
    await session.screencast.cdp.detach()
    session.screencast = null
  }

  async dispatchInput(sessionId, input) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session)
    const { page } = this.activeRecord(session)
    const cdp = await session.context.newCDPSession(page)
    try {
      if (input.kind === "mouse") {
        await cdp.send("Input.dispatchMouseEvent", input.payload)
      } else if (input.kind === "key") {
        session.humanKeyboardInputOccurred = true
        await cdp.send("Input.dispatchKeyEvent", input.payload)
      } else {
        throw new RemoteBrowserError("browser_input_invalid", "Unsupported input kind")
      }
    } finally {
      await cdp.detach()
    }
  }

  async cancelAction(sessionId) {
    const session = this.requireSession(sessionId)
    const { page } = this.activeRecord(session)
    await Promise.allSettled([page.keyboard.press("Escape"), page.evaluate(() => window.stop())])
  }

  async closeSession(sessionId, reason = "closed") {
    const session = this.requireSession(sessionId)
    session.closing = true
    clearTimeout(session.pagesChangedTimer)
    await this.stopScreencast(sessionId).catch(() => undefined)
    await this.dismissPendingDialog(session)
    this.invalidateSession(sessionId)
    this.clearLoginRefs(sessionId)
    try {
      if (session.kind === "user-chrome") {
        // Disconnect only: the user's browser, window and own tabs stay open.
        await session.downloadCdp?.detach().catch(() => undefined)
        await session.browserCdp?.detach().catch(() => undefined)
        await session.browser.close()
      } else {
        await session.context.close()
        if (session.ownsBrowser) await session.browser.close()
      }
      await this.fileBridge?.cleanupSession(sessionId)
    } finally {
      this.sessions.delete(sessionId)
      if (session.profileId && this.profileOwners.get(session.profileId) === sessionId) {
        this.profileOwners.delete(session.profileId)
      }
      this.emit({ type: "session.closed", sessionId, reason })
    }
  }

  /**
   * Erase a persistent profile's user-data directory — the sign-ins and site
   * storage the cloud browser kept for it. Refused while a session has the
   * profile open: Chromium holds the directory, and pulling it out from under
   * a live context corrupts the session rather than signing it out.
   */
  async deleteProfile(profileId) {
    assertProfileId(profileId)
    if (this.profileOwners.has(profileId)) {
      throw new RemoteBrowserError("browser_profile_in_use", "Browser profile is in use")
    }
    const profilePath = path.join(this.profilesRoot, profileId)
    // `assertProfileId` admits `.` and `..`; the resolved path must still sit
    // strictly inside the profiles root.
    if (path.dirname(profilePath) !== this.profilesRoot) {
      throw new RemoteBrowserError("browser_profile_invalid", "Browser profile id is invalid")
    }
    await fs.rm(profilePath, { recursive: true, force: true })
    return { deleted: true }
  }

  async handleConnectionClosed(session) {
    if (session.closing || session.restarting || !this.sessions.has(session.id)) return
    session.closing = true
    clearTimeout(session.pagesChangedTimer)
    await this.dismissPendingDialog(session)
    this.invalidateSession(session.id)
    this.clearLoginRefs(session.id)
    await this.fileBridge?.cleanupSession(session.id)
    this.sessions.delete(session.id)
    if (session.profileId && this.profileOwners.get(session.profileId) === session.id) {
      this.profileOwners.delete(session.profileId)
    }
    this.emit({ type: "session.closed", sessionId: session.id, reason: "disconnected" })
  }

  /**
   * Runtime shutdown: refuse new sessions, then close every session's browser
   * concurrently so one hung Chromium cannot keep the others alive past the
   * entrypoint's grace period. A launch still in flight is closed by
   * `createLocalSession` once it resolves.
   */
  async closeAll() {
    this.shuttingDown = true
    clearInterval(this.reaper)
    await Promise.allSettled([
      ...[...this.sessions.keys()].map((sessionId) => this.closeSession(sessionId, "shutdown")),
      // In-flight launches observe `shuttingDown` and close their own browser.
      ...this.pendingLaunches,
    ])
  }

  assertNotShuttingDown() {
    if (this.shuttingDown) {
      throw new RemoteBrowserError(
        "browser_runtime_shutting_down",
        "The browser runtime is shutting down"
      )
    }
  }

  async reapExpired(at = this.now()) {
    const expired = [...this.sessions.values()]
      .filter(
        (session) =>
          at - session.lastActivityAt >= this.idleTimeoutMs ||
          at - session.createdAt >= this.maxLifetimeMs
      )
      .map((session) => session.id)
    await Promise.allSettled(expired.map((sessionId) => this.closeSession(sessionId, "expired")))
    return expired
  }

  // ---------------------------------------------------------------------------
  // ADR-0201 operations
  // ---------------------------------------------------------------------------

  assertLocalMode(operation) {
    if (this.mode !== "local") {
      throw new RemoteBrowserError(
        "browser_local_only",
        `${operation} is only available in local mode`
      )
    }
  }

  assertKind(session, kinds, operation) {
    if (!kinds.includes(session.kind)) {
      throw new RemoteBrowserError(
        "browser_feature_unsupported",
        `${operation} is not supported by this browser backend`
      )
    }
  }

  pageRecord(session, pageId) {
    if (pageId === undefined || pageId === null) return this.activeRecord(session)
    const record = session.pages.get(pageId)
    if (!record) throw new RemoteBrowserError("browser_page_not_found", "Page not found")
    return { pageId, record, page: record.page }
  }

  requireDownloadOwner(session, downloadId) {
    if (typeof downloadId !== "string" || !downloadId) {
      throw new RemoteBrowserError("browser_download_not_found", "Download not found")
    }
    if (session.downloads) return
    if (!this.fileBridge.listDownloads(session.id).some((item) => item.id === downloadId)) {
      throw new RemoteBrowserError("browser_download_not_found", "Download not found")
    }
  }

  async cancelDownload(sessionId, downloadId) {
    const session = this.requireSession(sessionId)
    this.requireDownloadOwner(session, downloadId)
    if (!session.downloads) {
      throw new RemoteBrowserError(
        "browser_download_not_cancellable",
        "Quarantined downloads are already complete"
      )
    }
    return session.downloads.cancel(downloadId)
  }

  async deleteDownload(sessionId, downloadId) {
    const session = this.requireSession(sessionId)
    this.requireDownloadOwner(session, downloadId)
    if (session.downloads) return session.downloads.delete(downloadId)
    await this.fileBridge.deleteDownload(downloadId)
    return { deleted: true, id: downloadId }
  }

  /**
   * Local: copy a finished download to an absolute path the user chose (never
   * overwriting). Cloud: ADR-0085 semantics — move the quarantined file to a
   * workspace-relative path.
   */
  async saveDownload(sessionId, downloadId, targetPath) {
    const session = this.requireSession(sessionId)
    this.requireDownloadOwner(session, downloadId)
    if (session.downloads) return session.downloads.save(downloadId, targetPath)
    const saved = await this.fileBridge.saveDownload(downloadId, targetPath)
    const summary = { ...saved, backend: "remote" }
    this.emit({ type: "download.updated", sessionId, download: summary })
    return summary
  }

  /**
   * Restart every live launched-Chromium session with a new extension set,
   * reopening each session's tabs at their current URLs.
   */
  async reloadExtensions(extensionPaths) {
    this.assertLocalMode("browser.extensions.reload")
    const paths = absolutePathList(extensionPaths, "extensionPaths", {
      max: MAX_EXTENSIONS,
      forbidComma: true,
    })
    const reloaded = []
    for (const session of [...this.sessions.values()]) {
      if (session.kind !== "local" || session.closing) continue
      await this.restartLocalSession(session, paths)
      reloaded.push(session.id)
    }
    return { reloaded }
  }

  async restartLocalSession(session, extensionPaths) {
    const records = [...session.pages.entries()]
    const urls = records.map(([, record]) => record.page.url())
    const activeIndex = Math.max(
      0,
      records.findIndex(([pageId]) => pageId === session.activePageId)
    )
    const screencast = session.screencast ? session.screencastRequest : null
    session.restarting = true
    try {
      if (session.screencast) await this.stopScreencast(session.id).catch(() => undefined)
      await this.dismissPendingDialog(session)
      this.invalidateSession(session.id)
      this.clearLoginRefs(session.id)
      await session.downloadCdp?.detach().catch(() => undefined)
      session.downloadCdp = null
      await session.context.close()
      session.pages = new Map()
      session.pageIds = new WeakMap()
      session.activePageId = null
      session.requests.clear()
      session.extensionPaths = extensionPaths
      await this.launchLocalContext(session)
      const pageIds = [...session.pages.keys()]
      for (let index = 0; index < urls.length; index += 1) {
        let pageId = pageIds[index]
        if (!pageId) pageId = this.registerPage(session, await session.context.newPage())
        if (!pageId) break
        pageIds[index] = pageId
        const url = urls[index]
        if (!url || url === "about:blank") continue
        try {
          await session.policy.authorize(url, session.grants)
          await session.pages.get(pageId).page.goto(url, { waitUntil: "domcontentloaded" })
        } catch {
          // A tab that cannot be restored (e.g. the removed extension's own
          // page) stays blank rather than failing the whole reload.
        }
      }
      session.activePageId = pageIds[activeIndex] ?? pageIds[0] ?? session.activePageId
    } finally {
      session.restarting = false
    }
    if (screencast) {
      await this.startScreencast(session.id, screencast.onFrame, {
        quality: screencast.quality,
      }).catch(() => undefined)
    }
    this.emit({
      type: "extensions.changed",
      sessionId: session.id,
      extensionCount: extensionPaths.length,
    })
    this.schedulePagesChanged(session)
  }

  /** Open an installed extension's popup or options page as a tab. */
  async openExtensionPage(sessionId, { extensionId, page, path: pagePath } = {}) {
    this.assertLocalMode("browser.extension.open")
    const session = this.requireSession(sessionId)
    if (session.kind !== "local") {
      throw new RemoteBrowserError(
        "extensions_unsupported_backend",
        "Only Cognia's local Chromium loads Cognia extensions"
      )
    }
    if (typeof extensionId !== "string" || !EXTENSION_ID.test(extensionId)) {
      throw new RemoteBrowserError("extension_not_found", "Extension id is invalid")
    }
    if (page !== "popup" && page !== "options") {
      throw new RemoteBrowserError(
        "browser_option_invalid",
        "Extension page must be popup or options"
      )
    }
    const pathPart = typeof pagePath === "string" ? pagePath.split(/[?#]/)[0] : ""
    if (
      !pathPart ||
      pagePath.length > 512 ||
      /[\\:]/.test(pagePath) ||
      pathPart.startsWith("/") ||
      pathPart.split("/").some((segment) => segment === ".." || segment === "." || segment === "")
    ) {
      throw new RemoteBrowserError("browser_option_invalid", "Extension page path is invalid")
    }
    return this.createPage(sessionId, `chrome-extension://${extensionId}/${pagePath}`)
  }

  /** Privileged (Rust-only): inject imported cookies. Values are never echoed. */
  async setCookies(sessionId, cookies) {
    this.assertLocalMode("browser.cookies.set")
    const session = this.requireSession(sessionId)
    this.assertKind(session, ["local"], "browser.cookies.set")
    if (!Array.isArray(cookies) || cookies.length > 10_000) {
      throw new RemoteBrowserError("browser_cookie_invalid", "Cookies must be a list")
    }
    const normalized = cookies.map((cookie) => normalizeCookie(cookie))
    // Mark before injecting: a partially applied batch still authenticates.
    // The profile marker is written first so a failed write never leaves
    // imported cookies in the profile unmarked.
    if (normalized.length > 0) {
      await this.markProfileCookiesImported(session)
      session.cookiesImported = true
    }
    let set = 0
    let skipped = 0
    try {
      await session.context.addCookies(normalized)
      set = normalized.length
    } catch {
      // One malformed cookie rejects the batch; retry individually so every
      // valid cookie still lands.
      for (const cookie of normalized) {
        try {
          await session.context.addCookies([cookie])
          set += 1
        } catch {
          skipped += 1
        }
      }
    }
    return { set, skipped }
  }

  /** Cookie metadata only — values never leave the runtime. */
  async listCookies(sessionId, { domain } = {}) {
    const session = this.requireSession(sessionId)
    const normalized = normalizeCookieDomain(domain)
    const cookies = await session.context.cookies()
    return {
      cookies: cookies
        .filter((cookie) => cookieMatchesDomain(cookie.domain, normalized))
        .map((cookie) => cookieMetadata(cookie)),
    }
  }

  async clearCookies(sessionId, { domain } = {}) {
    const session = this.requireSession(sessionId)
    // Clearing cookies in the user's own Chrome would sign them out of their
    // real profile; only Cognia-owned contexts may be cleared.
    this.assertKind(session, ["local", "cloud"], "browser.cookies.clear")
    const normalized = normalizeCookieDomain(domain)
    const matching = (await session.context.cookies()).filter((cookie) =>
      cookieMatchesDomain(cookie.domain, normalized)
    )
    if (normalized) {
      await session.context.clearCookies({
        domain: new RegExp(`(^|\\.)${escapeRegExp(normalized)}$`),
      })
    } else {
      await session.context.clearCookies()
      // Every cookie is gone, imported ones included: later sessions on this
      // profile no longer need to withhold bodies. This session keeps
      // withholding, since responses it already captured may be authenticated.
      await this.clearProfileCookiesImported(session)
    }
    return { cleared: matching.length }
  }

  cookiesImportedMarkerPath(session) {
    if (session.kind !== "local" || !session.profileId) return null
    return path.join(this.profilesRoot, session.profileId, COOKIES_IMPORTED_MARKER)
  }

  async profileHasImportedCookies(session) {
    const marker = this.cookiesImportedMarkerPath(session)
    if (!marker) return false
    try {
      await fs.lstat(marker)
      return true
    } catch (error) {
      if (error?.code === "ENOENT") return false
      // Unreadable marker state: fail closed.
      return true
    }
  }

  async markProfileCookiesImported(session) {
    const marker = this.cookiesImportedMarkerPath(session)
    if (!marker) return
    await fs.writeFile(marker, `${new Date(this.now()).toISOString()}\n`, { mode: 0o600 })
  }

  async clearProfileCookiesImported(session) {
    const marker = this.cookiesImportedMarkerPath(session)
    if (!marker) return
    await fs.rm(marker, { force: true })
  }

  clearLoginRefs(sessionId, pageId) {
    for (const [ref, target] of this.loginRefs) {
      if (target.sessionId === sessionId && (pageId === undefined || target.pageId === pageId)) {
        this.loginRefs.delete(ref)
      }
    }
  }

  async collectLoginForms(session, pageId, page) {
    this.clearLoginRefs(session.id, pageId)
    const forms = []
    for (const frame of page.frames()) {
      const origin = frameOrigin(frame)
      if (!origin) continue
      let found
      try {
        found = await frame.evaluate(detectLoginFormsInPage, LOGIN_REGISTRY_KEY)
      } catch {
        continue
      }
      for (const form of Array.isArray(found) ? found : []) {
        const entry = { sessionId: session.id, pageId, frame, origin }
        const ref = this.createId()
        const passwordRef = this.createId()
        this.loginRefs.set(ref, { ...entry, key: form.key })
        this.loginRefs.set(passwordRef, { ...entry, key: `${form.key}:p` })
        let usernameRef
        if (form.hasUsername) {
          usernameRef = this.createId()
          this.loginRefs.set(usernameRef, { ...entry, key: `${form.key}:u` })
        }
        forms.push({
          ref,
          ...(usernameRef ? { usernameRef } : {}),
          passwordRef,
          origin,
          frame,
          key: form.key,
          main: frame === pageMainFrame(page),
        })
      }
    }
    return forms
  }

  async detectLoginForms(sessionId, { pageId } = {}) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session, pageId)
    const target = this.pageRecord(session, pageId)
    const forms = await this.collectLoginForms(session, target.pageId, target.page)
    return {
      forms: forms.map(({ ref, usernameRef, passwordRef, origin }) => ({
        ref,
        ...(usernameRef ? { usernameRef } : {}),
        passwordRef,
        origin,
      })),
    }
  }

  async resolveLoginElement(frame, key) {
    const handle = await frame.evaluateHandle(resolveLoginRegistryEntry, {
      registryKey: LOGIN_REGISTRY_KEY,
      key,
    })
    const element = handle.asElement()
    if (!element) {
      await handle.dispose()
      return null
    }
    return element
  }

  /**
   * Privileged (Rust-only): fill a login form with a vault credential. Only
   * forms in frames of the page's own origin (or the explicit `origin` Rust
   * matched the credential against) are eligible, so a cross-origin iframe
   * never receives a password. Returns only `{filled, username}`.
   */
  async fillCredential(sessionId, { pageId, username, password, origin } = {}) {
    this.assertLocalMode("browser.credential.fill")
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session, pageId)
    if (typeof password !== "string" || !password) {
      throw new RemoteBrowserError("browser_credential_invalid", "A password is required")
    }
    const user = typeof username === "string" ? username : ""
    const target = this.pageRecord(session, pageId)
    let expectedOrigin = frameOrigin(pageMainFrame(target.page))
    if (origin !== undefined && origin !== null) {
      // Rust sends the origin it matched the vault credential against; only a
      // frame whose origin equals it exactly may receive the password.
      let parsed = null
      try {
        parsed = typeof origin === "string" && origin ? new URL(origin).origin : null
      } catch {
        parsed = null
      }
      if (!parsed || parsed === "null") {
        throw new RemoteBrowserError("browser_credential_invalid", "Credential origin is invalid")
      }
      expectedOrigin = parsed
    }
    if (!expectedOrigin) return { filled: false, username: null, reason: "no_login_form" }
    const detected = await this.collectLoginForms(session, target.pageId, target.page)
    const forms = detected.filter((form) => form.origin === expectedOrigin)
    forms.sort((left, right) => Number(right.main) - Number(left.main))
    const form = forms[0]
    if (!form) {
      return {
        filled: false,
        username: null,
        reason: detected.length > 0 ? "origin_mismatch" : "no_login_form",
      }
    }
    const passwordElement = await this.resolveLoginElement(form.frame, `${form.key}:p`)
    if (!passwordElement) return { filled: false, username: null, reason: "no_login_form" }
    try {
      if (form.usernameRef && user) {
        const usernameElement = await this.resolveLoginElement(form.frame, `${form.key}:u`)
        if (usernameElement) {
          try {
            await usernameElement.fill(user)
          } finally {
            await usernameElement.dispose()
          }
        }
      }
      await passwordElement.fill(password)
    } finally {
      await passwordElement.dispose()
    }
    // Diagnostics captured after a credential fill are redacted exactly like
    // after human keyboard input.
    session.humanKeyboardInputOccurred = true
    return { filled: true, username: user }
  }

  /**
   * Print the page through CDP `Page.printToPDF`, which works for headed and
   * headless Chromium alike. Local: saved into the downloads directory and
   * tracked as a completed download. Cloud: quarantined like any download.
   */
  async pdf(sessionId, options = {}) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session, options.pageId)
    const { page } = this.pageRecord(session, options.pageId)
    const params = {
      transferMode: "ReturnAsBase64",
      landscape: options.landscape === true,
      printBackground: options.printBackground !== false,
      preferCSSPageSize: options.preferCSSPageSize === true,
    }
    const scale = finiteInRange(options.scale, 0.1, 2, "scale")
    if (scale !== undefined) params.scale = scale
    for (const [field, max] of [
      ["paperWidth", 100],
      ["paperHeight", 100],
      ["marginTop", 20],
      ["marginBottom", 20],
      ["marginLeft", 20],
      ["marginRight", 20],
    ]) {
      const value = finiteInRange(options[field], 0, max, field)
      if (value !== undefined) params[field] = value
    }
    if (typeof options.pageRanges === "string") {
      if (!/^[\d\s,-]*$/.test(options.pageRanges)) {
        throw new RemoteBrowserError("browser_option_invalid", "pageRanges is invalid")
      }
      params.pageRanges = options.pageRanges
    }
    const cdp = await session.context.newCDPSession(page)
    let result
    try {
      result = await cdp.send("Page.printToPDF", params)
    } finally {
      await cdp.detach().catch(() => undefined)
    }
    const bytes = Buffer.from(result?.data ?? "", "base64")
    const title = await page.title().catch(() => "")
    let fallback = "page"
    try {
      fallback = new URL(page.url()).hostname || "page"
    } catch {
      // keep "page"
    }
    let filename = safeFilename(
      typeof options.filename === "string" && options.filename ? options.filename : title,
      fallback
    )
    if (!filename.toLowerCase().endsWith(".pdf")) filename = `${filename}.pdf`
    if (session.downloads) {
      const filePath = await reserveUniquePath(session.downloadsDir, filename)
      await fs.writeFile(filePath, bytes)
      const download = await session.downloads.addCompletedFile({ filePath, url: page.url() })
      return { path: filePath, download }
    }
    const quarantined = await this.fileBridge.quarantineDownload(sessionId, filename, bytes)
    const download = { ...quarantined, backend: "remote" }
    this.emit({ type: "download.updated", sessionId, download })
    return { download }
  }

  async emulationSession(session, record) {
    if (!record.emulationCdp) record.emulationCdp = await session.context.newCDPSession(record.page)
    return record.emulationCdp
  }

  /**
   * Page-scoped device emulation. Overrides live on a dedicated CDP session
   * per page (CDP drops them when that session detaches, which is how
   * `reset` clears them), so emulating in the user's Chrome never leaks into
   * the user's own tabs.
   */
  async emulate(sessionId, options = {}) {
    const session = this.requireSession(sessionId)
    this.assertNoPendingDialog(session, options.pageId)
    const { page, record } = this.pageRecord(session, options.pageId)
    const applied = []
    if (options.reset === true) {
      if (record.emulationCdp) {
        await record.emulationCdp.detach().catch(() => undefined)
        record.emulationCdp = null
      }
      await page.setViewportSize(session.viewport ?? this.viewport)
      await page.emulateMedia({ colorScheme: null })
      return { ok: true, applied: ["reset"] }
    }
    let device = null
    if (options.device !== undefined) {
      device = typeof options.device === "string" ? this.devices[options.device] : undefined
      if (!device) throw new RemoteBrowserError("browser_device_unknown", "Unknown device")
    }
    const viewport =
      options.viewport !== undefined
        ? clampViewport(options.viewport, this.viewport)
        : device?.viewport
          ? clampViewport(device.viewport, this.viewport)
          : null
    const userAgent = options.userAgent ?? device?.userAgent
    if (userAgent !== undefined && (typeof userAgent !== "string" || userAgent.length > 1024)) {
      throw new RemoteBrowserError("browser_option_invalid", "userAgent is invalid")
    }
    if (options.locale !== undefined) {
      try {
        Intl.getCanonicalLocales(options.locale)
      } catch {
        throw new RemoteBrowserError("browser_option_invalid", "locale is invalid")
      }
    }
    if (options.timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: options.timezone })
      } catch {
        throw new RemoteBrowserError("browser_option_invalid", "timezone is invalid")
      }
    }
    if (
      options.colorScheme !== undefined &&
      !["light", "dark", "no-preference", null].includes(options.colorScheme)
    ) {
      throw new RemoteBrowserError("browser_option_invalid", "colorScheme is invalid")
    }
    let geolocation = null
    if (options.geolocation !== undefined && options.geolocation !== null) {
      geolocation = {
        latitude: finiteInRange(options.geolocation.latitude, -90, 90, "latitude"),
        longitude: finiteInRange(options.geolocation.longitude, -180, 180, "longitude"),
        accuracy: finiteInRange(options.geolocation.accuracy ?? 0, 0, 100_000, "accuracy"),
      }
      if (geolocation.latitude === undefined || geolocation.longitude === undefined) {
        throw new RemoteBrowserError("browser_option_invalid", "geolocation is invalid")
      }
    }
    if (options.offline !== undefined && typeof options.offline !== "boolean") {
      throw new RemoteBrowserError("browser_option_invalid", "offline must be a boolean")
    }

    if (viewport) {
      await page.setViewportSize(viewport)
      applied.push("viewport")
    }
    const needsCdp =
      device ||
      userAgent !== undefined ||
      options.locale !== undefined ||
      options.timezone !== undefined ||
      geolocation ||
      options.offline !== undefined
    const cdp = needsCdp ? await this.emulationSession(session, record) : null
    if (device && viewport) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: Number(device.deviceScaleFactor) || 1,
        mobile: device.isMobile === true,
      })
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: device.hasTouch === true })
      applied.push("device")
    }
    if (userAgent !== undefined) {
      await cdp.send("Emulation.setUserAgentOverride", {
        userAgent,
        ...(options.locale ? { acceptLanguage: options.locale } : {}),
      })
      applied.push("userAgent")
    }
    if (options.locale !== undefined) {
      await cdp.send("Emulation.setLocaleOverride", { locale: options.locale })
      applied.push("locale")
    }
    if (options.timezone !== undefined) {
      await cdp.send("Emulation.setTimezoneOverride", { timezoneId: options.timezone })
      applied.push("timezone")
    }
    if (options.colorScheme !== undefined) {
      await page.emulateMedia({ colorScheme: options.colorScheme })
      applied.push("colorScheme")
    }
    if (geolocation) {
      if (session.kind !== "user-chrome") {
        const origin = frameOrigin(pageMainFrame(page))
        if (origin) {
          await session.context.grantPermissions(["geolocation"], { origin }).catch(() => undefined)
        }
      }
      await cdp.send("Emulation.setGeolocationOverride", geolocation)
      applied.push("geolocation")
    }
    if (options.offline !== undefined) {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: options.offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      })
      applied.push("offline")
    }
    return { ok: true, applied }
  }

  async storageEvaluate(session, pageId, fn, argument) {
    this.assertNoPendingDialog(session, pageId)
    const { page } = this.pageRecord(session, pageId)
    try {
      return await pageMainFrame(page).evaluate(fn, argument)
    } catch (error) {
      throw new RemoteBrowserError(
        "browser_storage_unavailable",
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  /**
   * Read web storage. Refused for user-chrome (the user's real profile). A
   * local session returns values only for loopback origins; elsewhere it
   * returns keys with every value withheld (`valuesWithheld: true`), since a
   * public site's storage routinely holds session tokens.
   */
  async storageGet(sessionId, { area, key, pageId } = {}) {
    const session = this.requireSession(sessionId)
    this.assertKind(session, ["local", "cloud"], "browser.storage.get")
    if (key !== undefined && typeof key !== "string") {
      throw new RemoteBrowserError("browser_storage_invalid", "Storage key must be a string")
    }
    const result = await this.storageEvaluate(session, pageId, readStorageInPage, {
      area: storageArea(area),
      ...(typeof key === "string" ? { key } : {}),
    })
    if (session.kind !== "local" || isLoopbackOrigin(result?.origin)) return result
    if (typeof key === "string") {
      return {
        origin: result?.origin,
        key,
        value: null,
        exists: result?.value !== null && result?.value !== undefined,
        valuesWithheld: true,
      }
    }
    const keys = Object.keys(result?.entries ?? {})
    return {
      origin: result?.origin,
      keys,
      entries: Object.fromEntries(keys.map((name) => [name, null])),
      valuesWithheld: true,
    }
  }

  async storageSet(sessionId, { area, key, value, pageId } = {}) {
    const session = this.requireSession(sessionId)
    if (typeof key !== "string" || !key || key.length > 1024) {
      throw new RemoteBrowserError("browser_storage_invalid", "Storage key is invalid")
    }
    const text = typeof value === "string" ? value : JSON.stringify(value ?? null)
    if (text.length > 5 * 1024 * 1024) {
      throw new RemoteBrowserError("browser_storage_invalid", "Storage value is too large")
    }
    return this.storageEvaluate(session, pageId, writeStorageInPage, {
      area: storageArea(area),
      key,
      value: text,
    })
  }

  async storageClear(sessionId, { area, pageId } = {}) {
    const session = this.requireSession(sessionId)
    return this.storageEvaluate(session, pageId, clearStorageInPage, { area: storageArea(area) })
  }

  /**
   * Details of one request listed by `browser.network`: headers with
   * credentials redacted and the response body truncated to 64 KB. After
   * human keyboard input (or a credential fill) bodies are withheld and the
   * URL query dropped, matching the network log's redaction. After imported
   * cookies were set on the session, bodies are withheld too: responses may
   * then carry the user's authenticated data.
   */
  async networkRequest(sessionId, requestId) {
    const session = this.requireSession(sessionId)
    const entry = typeof requestId === "string" ? session.requests.get(requestId) : undefined
    if (!entry) throw new RemoteBrowserError("browser_request_not_found", "Request not found")
    const { request, response } = entry
    const redacted = session.humanKeyboardInputOccurred
    const withholdBody = redacted || session.cookiesImported
    const url = new URL(request.url())
    if (redacted) {
      url.search = ""
      url.hash = ""
    }
    const requestHeaders = await (
      typeof request.allHeaders === "function"
        ? request.allHeaders()
        : Promise.resolve(request.headers?.() ?? {})
    ).catch(() => request.headers?.() ?? {})
    const responseHeaders = await (
      typeof response.allHeaders === "function"
        ? response.allHeaders()
        : Promise.resolve(response.headers?.() ?? {})
    ).catch(() => response.headers?.() ?? {})
    let body = { body: null, bodyEncoding: null, truncated: false, bodyBytes: 0 }
    if (!withholdBody) {
      const bytes = await response.body().catch(() => null)
      const contentType = Object.entries(responseHeaders).find(
        ([name]) => name.toLowerCase() === "content-type"
      )?.[1]
      body = encodeBody(bytes, contentType)
    }
    return {
      id: requestId,
      url: url.toString(),
      method: request.method(),
      status: response.status(),
      requestHeaders: redactHeaders(requestHeaders),
      responseHeaders: redactHeaders(responseHeaders),
      ...body,
      ...(withholdBody ? { bodyRedacted: true } : {}),
    }
  }

  /**
   * user-chrome: close every tab this session opened (and popups those tabs
   * opened); the user's own tabs and the browser stay untouched.
   */
  async finalizeTabs(sessionId) {
    const session = this.requireSession(sessionId)
    this.assertKind(session, ["user-chrome"], "browser.tabs.finalize")
    await this.stopScreencast(sessionId).catch(() => undefined)
    await this.dismissPendingDialog(session)
    let closed = 0
    for (const record of [...session.pages.values()]) {
      try {
        await record.page.close()
        closed += 1
      } catch {
        // Already closed by the user.
      }
    }
    return { closed }
  }

  /**
   * Run `operation` with every unaddressed page lookup inside it resolving to
   * `pageId` (see `pageTarget`). The runtime server wraps an operation whose
   * payload names a `pageId` in this.
   */
  withPageTarget(sessionId, pageId, operation) {
    return pageTarget.run({ sessionId, pageId }, operation)
  }

  /**
   * The page an operation acts on: the one it addressed (`withPageTarget`),
   * else the page in front.
   */
  activeRecord(session) {
    const target = pageTarget.getStore()
    const addressed = Boolean(target && target.sessionId === session.id)
    const pageId = addressed ? target.pageId : session.activePageId
    const record = pageId ? session.pages.get(pageId) : null
    if (!record) {
      throw new RemoteBrowserError(
        "browser_page_not_found",
        addressed ? "Page not found" : "No active page"
      )
    }
    return { pageId, record, page: record.page }
  }

  /** `activeRecord`'s record, or null when the session has no such page. */
  addressedRecordOrNull(session) {
    try {
      return this.activeRecord(session).record
    } catch {
      return null
    }
  }

  /**
   * Refuse while the page an operation acts on (`pageId`, else the addressed
   * or front page) is held by a dialog. A dialog on another tab is that tab's
   * business.
   */
  assertNoPendingDialog(session, pageId) {
    const record =
      pageId === undefined || pageId === null
        ? this.addressedRecordOrNull(session)
        : session.pages.get(pageId)
    if (record?.pendingDialog) {
      throw new RemoteBrowserError(
        "browser_dialog_pending",
        "Handle the pending browser dialog before performing another action"
      )
    }
  }

  async resolveTarget(session, reference) {
    const { pageId, record } = this.activeRecord(session)
    const target = this.references.get(reference)
    if (
      !target ||
      target.sessionId !== session.id ||
      target.pageId !== pageId ||
      target.generation !== record.generation
    ) {
      throw new RemoteBrowserError("browser_stale_ref", "Browser reference is stale")
    }
    const handle = await target.frame.evaluateHandle(
      (ref) => window.__cogniaOverlay.resolveRef(ref),
      target.nativeRef
    )
    const element = handle.asElement()
    if (!element) {
      await handle.dispose()
      throw new RemoteBrowserError("browser_invalid_target", "Browser ref is not an element")
    }
    return {
      element,
      generation: record.generation,
      dispose: () => handle.dispose(),
    }
  }

  /**
   * Run one dialog-aware action on `lane` — the addressed (else front) page's,
   * or `session.actionLane` for an action no page exists for yet. One action
   * at a time per lane: two tabs can each run one, a tab cannot run two.
   */
  async runActionWithDialog(session, generation, action, lane = this.activeRecord(session).record) {
    if (lane.pendingDialog) {
      throw new RemoteBrowserError(
        "browser_dialog_pending",
        "Handle the pending browser dialog before performing another action"
      )
    }
    if (lane.actionInFlight) {
      throw new RemoteBrowserError(
        "browser_action_in_progress",
        "Another browser action is still in progress"
      )
    }
    lane.actionInFlight = true
    let resolveDialog
    const dialogPromise = new Promise((resolve) => {
      resolveDialog = resolve
    })
    lane.dialogWaiters.add(resolveDialog)
    const actionPromise = Promise.resolve().then(action)
    let keepActionInFlight = false
    try {
      const outcome = await Promise.race([
        actionPromise.then((result) => ({ kind: "action", result })),
        dialogPromise.then((pending) => ({ kind: "dialog", pending })),
      ])
      if (outcome.kind === "dialog") {
        outcome.pending.lane = lane
        lane.pendingAction = actionPromise
        keepActionInFlight = true
        void actionPromise.catch(() => undefined)
        return {
          ok: true,
          error: null,
          generation,
          dialogPending: true,
          dialog: outcome.pending.metadata,
        }
      }
      return outcome.result
    } finally {
      lane.dialogWaiters.delete(resolveDialog)
      if (!keepActionInFlight) lane.actionInFlight = false
    }
  }

  /** Dismiss `pageId`'s pending dialog, or every tab's when no page is named. */
  async dismissPendingDialog(session, pageId) {
    // Read synchronously: a closing page leaves `session.pages` right after this call starts.
    const records = pageId ? [session.pages.get(pageId)] : [...session.pages.values()]
    await Promise.allSettled(
      records.map(async (record) => {
        const pending = record?.pendingDialog
        if (!pending) return
        const lane = pending.lane
        try {
          await pending.dialog.dismiss()
          if (lane?.pendingAction) await Promise.allSettled([lane.pendingAction])
        } finally {
          if (record.pendingDialog === pending) record.pendingDialog = null
          if (lane) {
            lane.pendingAction = null
            lane.actionInFlight = false
          }
        }
      })
    )
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) throw new RemoteBrowserError("browser_session_not_found", "Session not found")
    session.lastActivityAt = this.now()
    return session
  }

  invalidatePage(sessionId, pageId) {
    for (const [reference, target] of this.references) {
      if (target.sessionId === sessionId && target.pageId === pageId)
        this.references.delete(reference)
    }
  }

  invalidateSession(sessionId) {
    for (const [reference, target] of this.references) {
      if (target.sessionId === sessionId) this.references.delete(reference)
    }
  }
}
