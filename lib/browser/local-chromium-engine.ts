/**
 * `BrowserEngine` over the desktop's local browser runtime (ADR-0201).
 *
 * Both desktop Chromium backends are the same `services/workspace-runtime`
 * service run on loopback: `local-chromium` launches Cognia's managed
 * Chromium, `user-chrome` attaches to the user's own Chrome through its
 * consent-gated remote debugging. Every call is one allow-listed runtime op
 * through `browser_local_rpc` — the same op vocabulary the cloud gateway maps
 * the companion `browser_*` RPCs onto (see
 * `crates/cognia-companion/src/browser_gateway.rs`), plus the local-only ops.
 */
import type { Screenshot } from "@/lib/automation/types"
import { emitAgentActivity } from "@/lib/browser/agent-activity"
import { saveDownloadAs } from "@/lib/browser/downloads-client"
import { listExtensions, type BrowserExtension } from "@/lib/browser/extensions-client"
import { isBrowserSelection } from "@/lib/browser/client"
import { localBrowser } from "@/lib/browser/local-client"
import type { BrowserSelection } from "@/lib/browser/protocol"
import type { BrowserAdjustAction } from "@/lib/browser/adjust"
import { fillCredential } from "@/lib/browser/passwords"
import {
  credentialFilledEvaluateRefusal,
  redactNetworkHeaders,
  type BrowserActionResult,
  type BrowserSnapshot,
  type ConsoleEntry,
  type EvaluateResult,
  type NetworkEntry,
  type SnapshotOptions,
} from "@/lib/browser/protocol"
import {
  BrowserSessionError,
  type BrowserDownloadSummary,
  type BrowserPageSummary,
} from "@/lib/browser/session-types"

import type {
  BrowserCookieMeta,
  BrowserCredentialFillArgs,
  BrowserCredentialFillResult,
  BrowserEmulateOptions,
  BrowserEmulateResult,
  BrowserEngine,
  BrowserPdfResult,
  BrowserLoginForm,
  BrowserMutationResult,
  BrowserNetworkRequestDetail,
  BrowserPdfOptions,
  BrowserStorageArea,
  BrowserStorageResult,
  BrowserZoomResult,
  EvaluateOptions,
  FindOptions,
  HandleDialogArgs,
  NetworkIdleOptions,
  ScreenshotOptions,
  ScrollArgs,
  WaitForLoadOptions,
  WaitForOptions,
  WaitForResult,
} from "./agent-engine"

export type LocalEngineBackend = "local-chromium" | "user-chrome"

/**
 * Runtime sessions a vault credential was filled in. Keyed by session id, not
 * held on the instance: the pane re-binds a session by building a fresh
 * engine object, and the lock must survive that (ADR-0201).
 */
const credentialFilledSessions = new Set<string>()

/** Whether a vault credential was filled in the local runtime session `sessionId`. */
export function isLocalSessionCredentialFilled(sessionId: string): boolean {
  return credentialFilledSessions.has(sessionId)
}

/** Forget the post-fill lock for one session (closed) or, without an id, all (tests). */
export function clearLocalSessionCredentialFilled(sessionId?: string): void {
  if (sessionId === undefined) credentialFilledSessions.clear()
  else credentialFilledSessions.delete(sessionId)
}

/** An `Error` that keeps the runtime's stable code for the tool envelope. */
export class LocalBrowserOpError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "LocalBrowserOpError"
  }
}

const CODE_PREFIX = /^([a-z][a-z0-9_]*_[a-z0-9_]+)(?::\s*|\s+-\s+)(.*)$/s

/**
 * Normalize a rejected `browser_local_rpc` into an error carrying a code.
 * Rust returns either `{ code, message }` or a `"code: message"` string.
 */
export function toLocalBrowserError(error: unknown): Error {
  if (error instanceof BrowserSessionError || error instanceof LocalBrowserOpError) return error
  if (error && typeof error === "object" && "code" in error) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === "string") {
      return new LocalBrowserOpError(code, typeof message === "string" ? message : code)
    }
  }
  const text =
    typeof error === "string" ? error : error instanceof Error ? error.message : String(error)
  const match = CODE_PREFIX.exec(text)
  if (match) return new LocalBrowserOpError(match[1], match[2] || match[1])
  return error instanceof Error ? error : new Error(text)
}

/**
 * A local session uploads only from `<app_data>/browser/uploads`, and only
 * Rust puts files there, after the user picked them (`stageUpload`). An agent
 * path — workspace-relative or anywhere else on disk — is refused with this
 * code rather than copied in: confinement stays with the user's pick.
 */
export const LOCAL_UPLOAD_NEEDS_STAGING = "browser_upload_needs_staging"

const LOCAL_UPLOAD_STAGING_MESSAGE =
  "Local Chromium can only upload files the user picked in the browser pane (Cognia copies them into its upload folder); workspace or other local paths cannot be handed to the page. Ask the user to click the page's file input in the browser pane and choose the files there, or use the cloud browser for workspace files."

/**
 * `saveDownload` resolved without a file: the user dismissed the native save
 * dialog. A stable code so the agent tool can report it instead of retrying.
 */
export const LOCAL_DOWNLOAD_SAVE_CANCELLED = "browser_download_save_cancelled"

function isAbsolutePath(path: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)
}

function userChromeOnly(feature: string): BrowserSessionError {
  return new BrowserSessionError(
    "browser_feature_unsupported",
    `${feature} is not available when attached to your own Chrome: it uses Chrome's own extensions and profile.`
  )
}

/** The picker's info-panel toggle labels, localized by the pane. */
export interface SelectionPanelLabels {
  details: string
  collapse: string
}

/** `selectionForRef`'s answer: the overlay's envelope, stamped with the pane. */
export interface SelectionForRefResult {
  ok: boolean
  error: string | null
  selection: unknown
}

export interface LocalEngineOptions {
  /**
   * The tab every operation addresses (`pageId` on the runtime op) instead of
   * the one in front. Several tasks share one local session (ADR-0214), so an
   * engine working for one of them names its own tab; without it the engine
   * acts on whatever page the screencast is showing.
   */
  pageId?: string
}

export class LocalChromiumEngine implements BrowserEngine {
  /** The addressed tab, if any — see {@link LocalEngineOptions.pageId}. */
  public readonly pageId: string | null

  constructor(
    public readonly sessionId: string,
    public readonly backend: LocalEngineBackend,
    options: LocalEngineOptions = {}
  ) {
    this.pageId = options.pageId ?? null
  }

  private async op<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    try {
      // A payload's own `pageId` (activate / close / detect-login …) wins.
      return await localBrowser.rpc<T>(op, {
        sessionId: this.sessionId,
        ...(this.pageId ? { pageId: this.pageId } : {}),
        ...payload,
      })
    } catch (error) {
      throw toLocalBrowserError(error)
    }
  }

  navigate(url: string): Promise<void | BrowserMutationResult> {
    emitAgentActivity(`navigate ${url}`)
    return this.op("browser.navigate", { url })
  }
  snapshot(options?: SnapshotOptions): Promise<BrowserSnapshot> {
    const { fresh: _fresh, ...rest } = options ?? {}
    return this.op("browser.snapshot", { options: rest })
  }
  act(ref: string, action: string, args: Record<string, unknown>): Promise<BrowserActionResult> {
    emitAgentActivity(`${action} ${ref}`)
    return this.op("browser.act", { ref, action, args })
  }
  pressKey(key: string, ref?: string): Promise<BrowserActionResult> {
    emitAgentActivity(`key ${key}`)
    return this.op("browser.press-key", { key, ...(ref ? { ref } : {}) })
  }
  scroll(args: ScrollArgs): Promise<BrowserActionResult> {
    emitAgentActivity(
      args.reference ? `scroll ${args.reference}` : `scroll ${args.direction ?? "down"}`
    )
    return this.op("browser.scroll", { ...args })
  }
  /** See {@link BrowserEngine.credentialFilled}. */
  get credentialFilled(): boolean {
    return credentialFilledSessions.has(this.sessionId)
  }
  async evaluate(expression: string, options: EvaluateOptions = {}): Promise<EvaluateResult> {
    if (this.credentialFilled && options.credentialFillApproved !== true) {
      return credentialFilledEvaluateRefusal()
    }
    emitAgentActivity("evaluate")
    return this.op("browser.evaluate", { expression })
  }
  readConsole(): Promise<ConsoleEntry[]> {
    return this.op("browser.console")
  }
  readNetwork(): Promise<NetworkEntry[]> {
    return this.op("browser.network")
  }
  back(): Promise<void | BrowserMutationResult> {
    emitAgentActivity("back")
    return this.op("browser.back")
  }
  forward(): Promise<void | BrowserMutationResult> {
    emitAgentActivity("forward")
    return this.op("browser.forward")
  }
  reload(): Promise<void | BrowserMutationResult> {
    emitAgentActivity("reload")
    return this.op("browser.reload")
  }
  stop(): Promise<void | BrowserMutationResult> {
    emitAgentActivity("stop")
    return this.op("browser.stop")
  }
  getPage(): Promise<{ url: string; title: string }> {
    return this.op("browser.page")
  }
  listPages(): Promise<BrowserPageSummary[]> {
    return this.op("browser.pages")
  }
  activatePage(pageId: string): Promise<void> {
    return this.op("browser.page.activate", { pageId })
  }
  closePage(pageId: string): Promise<void> {
    return this.op("browser.page.close", { pageId })
  }
  /**
   * Open a tab. `activate: false` opens it behind the page in front, leaving
   * the screencast where it is.
   */
  createPage(
    url?: string,
    options: { activate?: boolean } = {}
  ): Promise<BrowserPageSummary | BrowserActionResult> {
    emitAgentActivity(url ? `new page ${url}` : "new page")
    return this.op("browser.page.create", {
      ...(url === undefined ? {} : { url }),
      ...(options.activate === false ? { activate: false } : {}),
    })
  }
  drag(sourceRef: string, targetRef: string): Promise<BrowserActionResult> {
    emitAgentActivity(`drag ${sourceRef}`)
    return this.op("browser.drag", { sourceRef, targetRef })
  }
  handleDialog(args: HandleDialogArgs): Promise<BrowserActionResult> {
    return this.op("browser.dialog.handle", {
      accept: args.accept,
      ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
    })
  }
  /**
   * Only paths under the session's upload root (files the user staged) reach
   * the page; see {@link LOCAL_UPLOAD_NEEDS_STAGING}. A relative path is
   * refused before the call, and the runtime's `browser_upload_path_denied`
   * is re-coded with the same explanation.
   */
  async setFiles(ref: string, paths: string[]): Promise<void | BrowserMutationResult> {
    if (paths.some((path) => !isAbsolutePath(path))) {
      throw new LocalBrowserOpError(LOCAL_UPLOAD_NEEDS_STAGING, LOCAL_UPLOAD_STAGING_MESSAGE)
    }
    emitAgentActivity(`upload ${ref}`)
    try {
      return await this.op<void | BrowserMutationResult>("browser.files.set", { ref, paths })
    } catch (error) {
      if (error instanceof LocalBrowserOpError && error.code === "browser_upload_path_denied") {
        throw new LocalBrowserOpError(LOCAL_UPLOAD_NEEDS_STAGING, LOCAL_UPLOAD_STAGING_MESSAGE)
      }
      throw error
    }
  }
  downloads(): Promise<BrowserDownloadSummary[]> {
    return this.op("browser.downloads")
  }
  waitForText(text: string, options?: WaitForOptions): Promise<WaitForResult> {
    return this.op("browser.wait.text", { text, options })
  }
  waitForSelector(selector: string, options?: WaitForOptions): Promise<WaitForResult> {
    return this.op("browser.wait.selector", { selector, options })
  }
  waitForNetworkIdle(options?: NetworkIdleOptions): Promise<WaitForResult> {
    return this.op("browser.wait.network-idle", { options })
  }
  waitForLoad(options?: WaitForLoadOptions): Promise<WaitForResult> {
    return this.op("browser.wait.load", { options })
  }
  screenshot(options?: ScreenshotOptions): Promise<Screenshot> {
    emitAgentActivity("screenshot")
    return this.op("browser.screenshot", options ? { options } : {})
  }
  setZoom(zoom: number): Promise<BrowserZoomResult> {
    return this.op("browser.set-zoom", { zoom })
  }
  find(query: string, options?: FindOptions): Promise<{ matches: number; index: number }> {
    return this.op("browser.find", { query, options })
  }
  findClear(): Promise<void> {
    return this.op("browser.find.clear")
  }

  // ── Element pick and Browser Adjust (ADR-0214) ───────────────────────────
  // The lightweight preview's picker, run by the same injected overlay. Each
  // op calls one fixed overlay function, so none of them is `evaluate`.

  /** Arm or disarm the in-page picker; `labels` localizes its info panel. */
  async setSelectMode(on: boolean, labels?: SelectionPanelLabels): Promise<void> {
    await this.op("browser.select-mode", { on, ...(labels ? { labels } : {}) })
  }
  /** The picks buffered since the last drain (the overlay empties its buffer). */
  async drainSelection(): Promise<BrowserSelection[]> {
    const result = await this.op<{ ok?: unknown; selections?: unknown }>("browser.selection.drain")
    const selections = result?.selections
    if (
      !Array.isArray(selections) ||
      selections.length > 20 ||
      !selections.every(isBrowserSelection)
    ) {
      throw new Error("invalid selection drain payload")
    }
    return selections
  }
  /** Drop the picks and the in-page info panel. */
  async clearSelection(): Promise<void> {
    await this.op("browser.selection.clear")
  }
  /** The pick payload for a snapshot ref (`browser_annotate`). */
  selectionForRef(ref: string): Promise<SelectionForRefResult> {
    return this.op("browser.selection.for-ref", { ref })
  }
  /** Runs the overlay's `__cogniaAdjust`; resolves its JSON answer (a {@link BrowserAdjustDriver}). */
  async adjust(action: BrowserAdjustAction, input: Record<string, unknown>): Promise<string> {
    const answer = await this.op<{ result?: unknown }>("browser.adjust", { action, input })
    if (typeof answer?.result !== "string") throw new Error("Browser adjustment failed")
    return answer.result
  }

  // ── ADR-0201 local-only surface ──────────────────────────────────────────

  pdf(options: BrowserPdfOptions = {}): Promise<BrowserPdfResult> {
    emitAgentActivity("pdf")
    return this.op("browser.pdf", { options })
  }
  emulate(options: BrowserEmulateOptions): Promise<BrowserEmulateResult> {
    emitAgentActivity("emulate")
    return this.op("browser.emulate", { ...options })
  }
  async listCookies(domain?: string): Promise<BrowserCookieMeta[]> {
    const result = await this.op<BrowserCookieMeta[] | { cookies?: BrowserCookieMeta[] }>(
      "browser.cookies.list",
      domain ? { domain } : {}
    )
    const cookies = Array.isArray(result) ? result : (result?.cookies ?? [])
    // Metadata only, whatever the runtime sent: a `value` never reaches a tool.
    return cookies.map(({ value: _value, ...meta }: BrowserCookieMeta & { value?: unknown }) => ({
      ...meta,
      expires: typeof meta.expires === "number" && meta.expires >= 0 ? meta.expires : null,
    }))
  }
  async clearCookies(domain?: string): Promise<{ removed: number }> {
    emitAgentActivity(domain ? `clear cookies ${domain}` : "clear cookies")
    const result = await this.op<{ cleared?: number; removed?: number }>(
      "browser.cookies.clear",
      domain ? { domain } : {}
    )
    return { removed: result?.cleared ?? result?.removed ?? 0 }
  }
  async getStorage(area: BrowserStorageArea, key?: string): Promise<BrowserStorageResult> {
    const result = await this.op<{
      origin?: string
      key?: string
      value?: string | null
      exists?: boolean
      entries?: Record<string, string | null>
      valuesWithheld?: boolean
    }>("browser.storage.get", key === undefined ? { area } : { area, key })
    const entries = result?.entries ?? (key !== undefined ? { [key]: result?.value ?? null } : {})
    return {
      area,
      origin: result?.origin,
      entries,
      // The runtime withholds values off loopback: say so, so a `null` is
      // never read as "the key has no value".
      ...(result?.valuesWithheld === true ? { valuesWithheld: true } : {}),
      ...(key !== undefined && typeof result?.exists === "boolean"
        ? { exists: result.exists }
        : {}),
    }
  }
  async setStorage(
    area: BrowserStorageArea,
    key: string,
    value: string
  ): Promise<BrowserMutationResult> {
    emitAgentActivity(`storage set ${key}`)
    await this.op("browser.storage.set", { area, key, value })
    return { ok: true }
  }
  async clearStorage(area: BrowserStorageArea): Promise<BrowserMutationResult> {
    emitAgentActivity(`storage clear ${area}`)
    await this.op("browser.storage.clear", { area })
    return { ok: true }
  }
  /**
   * The runtime already redacts credential headers; redacting again here keeps
   * the tool surface safe against a runtime that forgot one.
   */
  async networkRequest(requestId: string): Promise<BrowserNetworkRequestDetail> {
    const detail = await this.op<BrowserNetworkRequestDetail>("browser.network.request", {
      requestId,
    })
    return {
      ...detail,
      requestHeaders: redactNetworkHeaders(detail?.requestHeaders),
      responseHeaders: redactNetworkHeaders(detail?.responseHeaders),
    }
  }
  detectLoginForms(pageId?: string): Promise<BrowserLoginForm[]> {
    return this.op<{ forms?: BrowserLoginForm[] }>(
      "browser.forms.detect-login",
      pageId ? { pageId } : {}
    ).then((result) => result?.forms ?? [])
  }
  async fillCredential(args: BrowserCredentialFillArgs): Promise<BrowserCredentialFillResult> {
    emitAgentActivity("fill credential")
    const url = args.url ?? (await this.getPage()).url
    const result = await fillCredential({
      target: "local",
      sessionId: this.sessionId,
      ...(args.pageId ? { pageId: args.pageId } : {}),
      credentialId: args.credentialId ?? null,
      url,
    })
    if (result.filled === true) credentialFilledSessions.add(this.sessionId)
    return {
      filled: result.filled === true,
      username: result.username ?? null,
      reason: result.reason ?? null,
    }
  }
  async listExtensions(): Promise<BrowserExtension[]> {
    if (this.backend === "user-chrome") throw userChromeOnly("Cognia's extension set")
    return (await listExtensions()).filter((extension) => extension.enabled)
  }
  /**
   * Open an enabled extension's action popup or options page as a tab. The
   * page path comes from the extension store's parsed manifest, never from
   * the caller.
   */
  async openExtension(
    extensionId: string,
    page: "popup" | "options"
  ): Promise<BrowserPageSummary | BrowserActionResult> {
    if (this.backend === "user-chrome") throw userChromeOnly("Opening Cognia extensions")
    const extension = (await listExtensions()).find((item) => item.id === extensionId)
    if (!extension || !extension.enabled) {
      throw new LocalBrowserOpError("extension_not_found", "No enabled extension has that id")
    }
    const path = page === "popup" ? extension.popupPath : extension.optionsPath
    if (!path) {
      throw new LocalBrowserOpError(
        "browser_option_invalid",
        `The extension has no ${page === "popup" ? "action popup" : "options page"}`
      )
    }
    emitAgentActivity(`extension ${page}`)
    return this.op("browser.extension.open", { extensionId, page, path })
  }
  finalizeTabs(): Promise<{ closed: number }> {
    emitAgentActivity("finalize tabs")
    return this.op("browser.tabs.finalize")
  }
  cancelDownload(downloadId: string): Promise<BrowserDownloadSummary> {
    return this.op("browser.download.cancel", { downloadId })
  }
  deleteDownload(downloadId: string): Promise<{ deleted: boolean; id: string }> {
    return this.op("browser.download.delete", { downloadId })
  }
  /**
   * Copy a finished download to where the user chooses. The runtime's
   * `browser.download.save` is Rust-only (ADR-0201): Rust shows a native save
   * dialog and runs it, so `_targetPath` is ignored — the user, not the
   * caller, picks the destination. A dismissed dialog throws
   * {@link LOCAL_DOWNLOAD_SAVE_CANCELLED}.
   */
  async saveDownload(downloadId: string, _targetPath?: string): Promise<BrowserDownloadSummary> {
    let saved: BrowserDownloadSummary | null
    try {
      saved = await saveDownloadAs(this.sessionId, downloadId)
    } catch (error) {
      throw toLocalBrowserError(error)
    }
    if (!saved) {
      throw new LocalBrowserOpError(
        LOCAL_DOWNLOAD_SAVE_CANCELLED,
        "The user cancelled the save dialog; the download was not saved"
      )
    }
    return saved
  }
}
