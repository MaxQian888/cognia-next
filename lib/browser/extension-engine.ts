/**
 * The fifth `BrowserEngine` backend: the user's own browser, driven through the
 * Browser Companion extension (ADR-0228 §6).
 *
 * Every method is one operation frame on the browser's device socket
 * (`crates/cognia-companion/src/ws_browser_companion.rs`). The extension runs
 * it with `chrome.scripting` and the same `overlay.injected.js` the embedded
 * engine injects, so snapshot refs, generations, secret redaction and
 * `browser_stale_ref` mean here exactly what they mean on the other backends —
 * and the 43 `browser_*` tools work unchanged.
 *
 * What needs the debugger protocol is refused, naming the backend that has it,
 * the way `RemoteChromiumEngine` refuses what the cloud gateway does not route.
 * The extension deliberately has no `chrome.debugger` (ADR-0201 keeps that
 * alternative rejected).
 *
 * Which browser and which conversation: an engine is bound to one paired
 * browser device and one conversation. The conversation id travels with every
 * frame as `session`, and the extension keeps that conversation's tabs apart
 * from the user's own — its tab group, its active tab, its site decisions.
 */
import type { Screenshot } from "@/lib/automation/types"
import { emitAgentActivity } from "@/lib/browser/agent-activity"
import { callBrowserSocket } from "@/lib/browser-companion/host-transport"
import { isTauri } from "@/lib/platform/detect"
import type { BrowserExtension } from "@/lib/browser/extensions-client"
import type {
  BrowserActionResult,
  BrowserSnapshot,
  ConsoleEntry,
  EvaluateResult,
  NetworkEntry,
  SnapshotOptions,
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
  BrowserLoginForm,
  BrowserMutationResult,
  BrowserNetworkRequestDetail,
  BrowserPdfOptions,
  BrowserPdfResult,
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

/**
 * Moves one operation to the browser and back. The Host addresses the browser
 * under the tenant it was paired into; the renderer never names one.
 */
export type ExtensionTransport = (input: {
  deviceId: string
  operation: string
  args: Record<string, unknown>
  timeoutMs: number
}) => Promise<unknown>

/** Reads one file the agent asked to upload, from the Host's own disk. */
export type ExtensionFileReader = (path: string) => Promise<Uint8Array>

export interface ExtensionBinding {
  /** The paired browser device that will run the operations. */
  deviceId: string
  /** The tab the conversation started on, when it started from one. */
  tabId?: number
}

/**
 * Features that need the debugger protocol, and therefore another backend.
 *
 * Each refusal names where the feature lives, so the agent can switch with
 * `browser_open` instead of retrying something that cannot work here.
 */
export const EXTENSION_UNSUPPORTED_FEATURES = {
  pdf: "Printing to PDF",
  emulate: "Device and network emulation",
  networkRequest: "Request and response bodies",
  credentials: "Password autofill",
  extensions: "Listing and opening Chrome extensions",
  saveDownload: "Copying a download to a chosen path",
} as const

export type ExtensionUnsupportedFeature = keyof typeof EXTENSION_UNSUPPORTED_FEATURES

function extensionUnsupported(feature: ExtensionUnsupportedFeature): BrowserSessionError {
  return new BrowserSessionError(
    "browser_feature_unsupported",
    `${EXTENSION_UNSUPPORTED_FEATURES[feature]} is not available when acting through the Cognia browser extension, which does not use Chrome's debugger. Use browser_open with backend "user-chrome" or "local-chromium" for it.`
  )
}

/** Default and ceiling for one operation, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000
const WAIT_SLACK_MS = 5_000
const MAX_TIMEOUT_MS = 120_000

/** Per-file and per-call ceilings for `setFiles`, matching the attachment ceiling. */
const MAX_UPLOAD_FILE_BYTES = 10 * 1024 * 1024
const MAX_UPLOAD_FILES = 6

/**
 * A refusal from the browser or the socket, keeping its machine code.
 *
 * The codes are the extension's and the socket's own vocabulary —
 * `browser_site_permission_required`, `browser_user_takeover`,
 * `browser_extension_offline`, `browser_drive_forbidden` … — which the tool
 * envelope hands the model so it can tell "ask the user" from "switch backend".
 */
export class ExtensionBrowserOpError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = "ExtensionBrowserOpError"
  }
}

function toEngineError(error: unknown): Error {
  if (error instanceof BrowserSessionError || error instanceof ExtensionBrowserOpError) {
    return error
  }
  if (error && typeof error === "object" && "code" in error) {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (typeof code === "string") {
      return code === "browser_feature_unsupported"
        ? new BrowserSessionError(code, typeof message === "string" ? message : code)
        : new ExtensionBrowserOpError(code, typeof message === "string" ? message : code)
    }
  }
  return error instanceof Error ? error : new Error(String(error))
}

function base64OfBytes(bytes: Uint8Array): string {
  let binary = ""
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

/** The media type the page sees for an uploaded file, from its extension. */
export function mediaTypeForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? ""
  const known: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    csv: "text/csv",
    json: "application/json",
    html: "text/html",
    zip: "application/zip",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  }
  return known[extension] ?? "application/octet-stream"
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || "file"
}

export interface ExtensionEngineOptions {
  binding: ExtensionBinding
  /** The conversation this engine works for. */
  chatSessionId: string
  transport?: ExtensionTransport
  readFile?: ExtensionFileReader
}

export class ExtensionBrowserEngine implements BrowserEngine {
  readonly backend = "extension" as const
  private readonly transport: ExtensionTransport
  private readonly readFile: ExtensionFileReader

  constructor(private readonly options: ExtensionEngineOptions) {
    this.transport = options.transport ?? hostExtensionTransport
    this.readFile = options.readFile ?? hostFileReader
  }

  get deviceId(): string {
    return this.options.binding.deviceId
  }

  private async op<T>(
    operation: string,
    args: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    emitAgentActivity(operation)
    try {
      return (await this.transport({
        deviceId: this.options.binding.deviceId,
        operation,
        // `session` names the conversation's slice of the browser; the
        // extension never acts on a tab outside it.
        args: {
          session: this.options.chatSessionId,
          ...(this.options.binding.tabId !== undefined
            ? { startTabId: this.options.binding.tabId }
            : {}),
          ...args,
        },
        timeoutMs: Math.min(Math.max(timeoutMs, 1_000), MAX_TIMEOUT_MS),
      })) as T
    } catch (error) {
      throw toEngineError(error)
    }
  }

  navigate(url: string): Promise<void | BrowserMutationResult> {
    return this.op("navigate", { url }, 60_000)
  }
  snapshot(options?: SnapshotOptions): Promise<BrowserSnapshot> {
    return this.op("snapshot", options ? { options } : {})
  }
  act(ref: string, action: string, args: Record<string, unknown>): Promise<BrowserActionResult> {
    return this.op("act", { ref, action, args })
  }
  pressKey(key: string, ref?: string): Promise<BrowserActionResult> {
    return this.op("press_key", { key, ...(ref ? { ref } : {}) })
  }
  scroll(args: ScrollArgs): Promise<BrowserActionResult> {
    return this.op("scroll", { ...args })
  }
  evaluate(expression: string, _options?: EvaluateOptions): Promise<EvaluateResult> {
    // No vault fill can happen on this backend, so there is no post-fill lock
    // to honour; the trust-tier gate on public origins is the tool's.
    return this.op("evaluate", { expression })
  }
  readConsole(): Promise<ConsoleEntry[]> {
    return this.op("read_console")
  }
  readNetwork(): Promise<NetworkEntry[]> {
    return this.op("read_network")
  }
  back(): Promise<void | BrowserMutationResult> {
    return this.op("back")
  }
  forward(): Promise<void | BrowserMutationResult> {
    return this.op("forward")
  }
  reload(): Promise<void | BrowserMutationResult> {
    return this.op("reload", {}, 60_000)
  }
  stop(): Promise<void | BrowserMutationResult> {
    return this.op("stop")
  }
  getPage(): Promise<{ url: string; title: string }> {
    return this.op("get_page")
  }
  listPages(): Promise<BrowserPageSummary[]> {
    return this.op("list_pages")
  }
  activatePage(pageId: string): Promise<void> {
    return this.op("activate_page", { pageId })
  }
  closePage(pageId: string): Promise<void> {
    return this.op("close_page", { pageId })
  }
  createPage(url?: string): Promise<BrowserPageSummary | BrowserActionResult> {
    return this.op("create_page", url ? { url } : {}, 60_000)
  }
  drag(sourceRef: string, targetRef: string): Promise<BrowserActionResult> {
    return this.op("drag", { sourceRef, targetRef })
  }
  handleDialog(args: HandleDialogArgs): Promise<BrowserActionResult> {
    return this.op("handle_dialog", {
      accept: args.accept,
      ...(args.promptText !== undefined ? { promptText: args.promptText } : {}),
    })
  }

  /**
   * Hand files to a file input.
   *
   * The extension cannot read this machine's paths, so the Host reads them and
   * sends the bytes; the page receives them through the input's `files`, the
   * same thing a person picking them would produce. Bounded like an attachment.
   */
  async setFiles(ref: string, paths: string[]): Promise<void | BrowserMutationResult> {
    if (paths.length > MAX_UPLOAD_FILES) {
      throw new ExtensionBrowserOpError(
        "browser_upload_too_large",
        `At most ${MAX_UPLOAD_FILES} files can be uploaded at once`
      )
    }
    const files: { name: string; mediaType: string; dataBase64: string }[] = []
    for (const path of paths) {
      let bytes: Uint8Array
      try {
        bytes = await this.readFile(path)
      } catch (error) {
        throw new ExtensionBrowserOpError(
          "browser_upload_unreadable",
          `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      if (bytes.byteLength > MAX_UPLOAD_FILE_BYTES) {
        throw new ExtensionBrowserOpError(
          "browser_upload_too_large",
          `${fileNameOf(path)} is larger than ${MAX_UPLOAD_FILE_BYTES} bytes`
        )
      }
      files.push({
        name: fileNameOf(path),
        mediaType: mediaTypeForPath(path),
        dataBase64: base64OfBytes(bytes),
      })
    }
    return this.op("set_files", { ref, files }, 60_000)
  }
  downloads(): Promise<BrowserDownloadSummary[]> {
    return this.op("downloads")
  }
  waitForText(text: string, options?: WaitForOptions): Promise<WaitForResult> {
    return this.op("wait_for_text", { text, ...(options ? { options } : {}) }, waitBudget(options))
  }
  waitForSelector(selector: string, options?: WaitForOptions): Promise<WaitForResult> {
    return this.op(
      "wait_for_selector",
      { selector, ...(options ? { options } : {}) },
      waitBudget(options)
    )
  }
  waitForNetworkIdle(options?: NetworkIdleOptions): Promise<WaitForResult> {
    return this.op("wait_for_network_idle", options ? { options } : {}, waitBudget(options))
  }
  waitForLoad(options?: WaitForLoadOptions): Promise<WaitForResult> {
    return this.op("wait_for_load", options ? { options } : {}, waitBudget(options))
  }
  screenshot(options?: ScreenshotOptions): Promise<Screenshot> {
    return this.op("screenshot", options ? { options } : {}, 60_000)
  }
  setZoom(zoom: number): Promise<BrowserZoomResult> {
    return this.op("set_zoom", { zoom })
  }
  find(query: string, options?: FindOptions): Promise<{ matches: number; index: number }> {
    return this.op("find", { query, ...(options ? { options } : {}) })
  }
  findClear(): Promise<void> {
    return this.op("find_clear")
  }
  async pdf(_options?: BrowserPdfOptions): Promise<BrowserPdfResult> {
    throw extensionUnsupported("pdf")
  }
  async emulate(_options: BrowserEmulateOptions): Promise<BrowserEmulateResult> {
    throw extensionUnsupported("emulate")
  }
  listCookies(domain?: string): Promise<BrowserCookieMeta[]> {
    return this.op("list_cookies", domain ? { domain } : {})
  }
  clearCookies(domain?: string): Promise<{ removed: number }> {
    return this.op("clear_cookies", domain ? { domain } : {})
  }
  getStorage(area: BrowserStorageArea, key?: string): Promise<BrowserStorageResult> {
    return this.op("get_storage", { area, ...(key !== undefined ? { key } : {}) })
  }
  setStorage(area: BrowserStorageArea, key: string, value: string): Promise<BrowserMutationResult> {
    return this.op("set_storage", { area, key, value })
  }
  clearStorage(area: BrowserStorageArea): Promise<BrowserMutationResult> {
    return this.op("clear_storage", { area })
  }
  async networkRequest(_requestId: string): Promise<BrowserNetworkRequestDetail> {
    throw extensionUnsupported("networkRequest")
  }
  async detectLoginForms(_pageId?: string): Promise<BrowserLoginForm[]> {
    throw extensionUnsupported("credentials")
  }
  async fillCredential(_args: BrowserCredentialFillArgs): Promise<BrowserCredentialFillResult> {
    throw extensionUnsupported("credentials")
  }
  async listExtensions(): Promise<BrowserExtension[]> {
    throw extensionUnsupported("extensions")
  }
  async openExtension(
    _extensionId: string,
    _page: "popup" | "options"
  ): Promise<BrowserPageSummary | BrowserActionResult> {
    throw extensionUnsupported("extensions")
  }
  finalizeTabs(): Promise<{ closed: number }> {
    return this.op("finalize_tabs")
  }
  cancelDownload(downloadId: string): Promise<BrowserDownloadSummary> {
    return this.op("cancel_download", { downloadId })
  }
  deleteDownload(downloadId: string): Promise<{ deleted: boolean; id: string }> {
    return this.op("delete_download", { downloadId })
  }
  async saveDownload(_downloadId: string, _targetPath?: string): Promise<BrowserDownloadSummary> {
    throw extensionUnsupported("saveDownload")
  }
}

/** A wait's own budget plus slack, so the socket does not time out first. */
function waitBudget(options?: { timeoutMs?: number }): number {
  const requested = typeof options?.timeoutMs === "number" ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  return requested + WAIT_SLACK_MS
}

/**
 * This Host's own server: Tauri IPC on the desktop, the service plane in the
 * headless brain (`lib/browser-companion/host-transport.ts`).
 */
const hostExtensionTransport: ExtensionTransport = (input) => callBrowserSocket(input)

/**
 * Reads a file the agent names on this Host: through the desktop's fs plugin,
 * or straight from disk in the headless brain, which is a Node process on the
 * machine the paths belong to.
 */
export const hostFileReader: ExtensionFileReader = async (path) => {
  if (isTauri()) {
    const { readFile } = await import("@tauri-apps/plugin-fs")
    return readFile(path)
  }
  const { readFile } = await import("node:fs/promises")
  return new Uint8Array(await readFile(path))
}

// ── Conversation bindings ───────────────────────────────────────────────────

/**
 * Which conversations act in which paired browser.
 *
 * Written when a `browser-agent` submission starts a conversation
 * (`lib/browser-companion/host-dispatch.ts`) and hydrated from the submission
 * ledger on start, so a restart does not leave a conversation that was told it
 * could act in the browser suddenly routed elsewhere. `routeEngine` reads it
 * synchronously.
 */
const bindings = new Map<string, ExtensionBinding>()

export function bindExtensionSession(chatSessionId: string, binding: ExtensionBinding): void {
  bindings.set(chatSessionId, { ...binding })
}

export function unbindExtensionSession(chatSessionId: string): void {
  bindings.delete(chatSessionId)
}

export function extensionBindingFor(chatSessionId: string | undefined): ExtensionBinding | null {
  if (!chatSessionId) return null
  return bindings.get(chatSessionId) ?? null
}

/** Test seam. */
export function resetExtensionBindings(): void {
  bindings.clear()
}

/** The engine for a bound conversation, or a refusal saying how to get one. */
export function extensionEngineFor(
  chatSessionId: string | undefined,
  options: { transport?: ExtensionTransport; readFile?: ExtensionFileReader } = {}
): ExtensionBrowserEngine {
  const binding = extensionBindingFor(chatSessionId)
  if (!binding || !chatSessionId) {
    throw new BrowserSessionError(
      "browser_feature_unsupported",
      "This conversation is not connected to a browser through the Cognia extension. Start it from the extension's side panel with “Act in this browser”."
    )
  }
  return new ExtensionBrowserEngine({ binding, chatSessionId, ...options })
}
