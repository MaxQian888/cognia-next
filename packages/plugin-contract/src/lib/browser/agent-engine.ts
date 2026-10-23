/**
 * The plugin contract's share of `lib/browser/agent-engine.ts`, which re-exports these.
 */
import type {
  BrowserActionResult,
  BrowserDialogState,
  BrowserSnapshot,
  ConsoleEntry,
  EvaluateResult,
  NetworkEntry,
  SnapshotOptions,
} from "./protocol"
import type { BrowserDownloadSummary, BrowserPageSummary } from "./session-types"
import type { BrowserExtension } from "./extensions-client"
import type { CredentialFillReason } from "./passwords"
import type { Screenshot } from "../automation/types"

export interface BrowserEngine {
  navigate(url: string): Promise<void | BrowserMutationResult>
  /** Host UI recording only: fixed helpers, never arbitrary page evaluation. */
  recordingControl?(action: "start" | "resume" | "stop" | "drain"): Promise<unknown>
  /** Resolve one top-document recorded selector in this engine's ref namespace. */
  resolveRecordedTarget?(selector: string): Promise<string>
  snapshot(opts?: SnapshotOptions): Promise<BrowserSnapshot>
  act(
    reference: string,
    action: string,
    args: Record<string, unknown>
  ): Promise<BrowserActionResult>
  /** Press a key chord (Enter, Tab, ctrl+a, …); ref optional (focused element). */
  pressKey(key: string, reference?: string): Promise<BrowserActionResult>
  /** Scroll an element into view (ref) or the page (direction/amount). */
  scroll(args: ScrollArgs): Promise<BrowserActionResult>
  /**
   * Evaluate a JS expression in the page (trust-gated by the caller). Once
   * {@link BrowserEngine.credentialFilled} is set the engine refuses with
   * `browser_human_input_required` unless the caller passes
   * `credentialFillApproved` for a person's per-call approval of THIS
   * expression (ADR-0201).
   */
  evaluate(expr: string, options?: EvaluateOptions): Promise<EvaluateResult>
  readConsole(): Promise<ConsoleEntry[]>
  readNetwork(): Promise<NetworkEntry[]>
  back(): Promise<void | BrowserMutationResult>
  forward(): Promise<void | BrowserMutationResult>
  reload(): Promise<void | BrowserMutationResult>
  stop(): Promise<void | BrowserMutationResult>
  getPage(): Promise<{ url: string; title: string }>
  listPages(): Promise<BrowserPageSummary[]>
  activatePage(pageId: string): Promise<void>
  closePage(pageId: string): Promise<void>
  createPage(url?: string): Promise<BrowserPageSummary | BrowserActionResult>
  drag(sourceRef: string, targetRef: string): Promise<BrowserActionResult>
  handleDialog(args: HandleDialogArgs): Promise<BrowserActionResult>
  setFiles(reference: string, paths: string[]): Promise<void | BrowserMutationResult>
  downloads(): Promise<BrowserDownloadSummary[]>
  waitForText(text: string, opts?: WaitForOptions): Promise<WaitForResult>
  waitForSelector(selector: string, opts?: WaitForOptions): Promise<WaitForResult>
  waitForNetworkIdle(opts?: NetworkIdleOptions): Promise<WaitForResult>
  /** Wait for a just-triggered navigation to land (document loaded). */
  waitForLoad(opts?: WaitForLoadOptions): Promise<WaitForResult>
  screenshot(options?: ScreenshotOptions): Promise<Screenshot>
  setZoom(zoom: number): Promise<BrowserZoomResult>
  find(query: string, options?: FindOptions): Promise<{ matches: number; index: number }>
  findClear(): Promise<void>

  // ── ADR-0201 ─────────────────────────────────────────────────────────────
  /** Which backend this engine drives. */
  readonly backend: BrowserEngineBackend
  /** Print the active page to a PDF in the downloads directory. */
  pdf(options?: BrowserPdfOptions): Promise<BrowserPdfResult>
  /** Device / viewport / locale / network emulation for the session. */
  emulate(options: BrowserEmulateOptions): Promise<BrowserEmulateResult>
  /** Cookie METADATA (never values), optionally for one domain. */
  listCookies(domain?: string): Promise<BrowserCookieMeta[]>
  clearCookies(domain?: string): Promise<{ removed: number }>
  getStorage(area: BrowserStorageArea, key?: string): Promise<BrowserStorageResult>
  setStorage(area: BrowserStorageArea, key: string, value: string): Promise<BrowserMutationResult>
  clearStorage(area: BrowserStorageArea): Promise<BrowserMutationResult>
  /** One request's headers and truncated body; auth headers redacted by the runtime. */
  networkRequest(requestId: string): Promise<BrowserNetworkRequestDetail>
  detectLoginForms(pageId?: string): Promise<BrowserLoginForm[]>
  /**
   * Rust fills the password; only `{filled, username}` comes back. A
   * successful fill sets {@link BrowserEngine.credentialFilled}.
   */
  fillCredential(args: BrowserCredentialFillArgs): Promise<BrowserCredentialFillResult>
  /**
   * True once a vault credential was filled in this engine's session: the page
   * may hold a password, so `evaluate` needs per-call approval. Absent on
   * engines that cannot fill credentials (the cloud engine).
   */
  readonly credentialFilled?: boolean
  listExtensions(): Promise<BrowserExtension[]>
  openExtension(
    extensionId: string,
    page: "popup" | "options"
  ): Promise<BrowserPageSummary | BrowserActionResult>
  /** `user-chrome`: close the tabs this session opened, leave the user's alone. */
  finalizeTabs(): Promise<{ closed: number }>
  cancelDownload(downloadId: string): Promise<BrowserDownloadSummary>
  deleteDownload(downloadId: string): Promise<{ deleted: boolean; id: string }>
  /**
   * Copy a finished download. Local Chromium / user Chrome ignore
   * `targetPath`: the user picks the destination in a native save dialog.
   */
  saveDownload(downloadId: string, targetPath?: string): Promise<BrowserDownloadSummary>
}

/** Options for {@link BrowserEngine.evaluate}. */
export interface EvaluateOptions {
  /**
   * A person approved this exact expression for this one call, after a vault
   * credential was filled. Only the first-party browser tools set it, and only
   * after their own confirmation dialog; the plugin engine facade drops it.
   */
  credentialFillApproved?: boolean
}

/** The engine-level backend names (the router's `EngineRoute.backend`). */
export type BrowserEngineBackend =
  | "embedded"
  | "local-chromium"
  | "user-chrome"
  | "remote-chromium"
  /** The user's own browser through the Browser Companion extension (ADR-0228 §6). */
  | "extension"

export interface BrowserPdfOptions {
  /** Page to print; defaults to the active page. */
  pageId?: string
  landscape?: boolean
  /** Default true. */
  printBackground?: boolean
  preferCSSPageSize?: boolean
  /** 0.1–2. */
  scale?: number
  /** Inches, ≤ 100. */
  paperWidth?: number
  paperHeight?: number
  /** Inches, ≤ 20. */
  marginTop?: number
  marginBottom?: number
  marginLeft?: number
  marginRight?: number
  /** e.g. `"1-3, 5"`. */
  pageRanges?: string
  /** File name in the downloads directory (`.pdf` appended when missing). */
  filename?: string
}

export interface BrowserPdfResult {
  /** Absolute path in the downloads directory (desktop runtime). */
  path?: string
  download?: BrowserDownloadSummary
}

export interface BrowserEmulateOptions {
  pageId?: string
  /** Drop every override on the page. */
  reset?: boolean
  /** A Playwright device descriptor name (`iPhone 15`, `Pixel 7`, …). */
  device?: string
  viewport?: { width: number; height: number; deviceScaleFactor?: number }
  userAgent?: string
  colorScheme?: "light" | "dark" | "no-preference"
  locale?: string
  timezone?: string
  /** `null` clears a previous override. */
  geolocation?: { latitude: number; longitude: number; accuracy?: number } | null
  offline?: boolean
}

export interface BrowserEmulateResult extends BrowserMutationResult {
  /** Which overrides took effect (`viewport`, `userAgent`, `offline`, `reset`, …). */
  applied?: string[]
}

export interface BrowserCookieMeta {
  name: string
  domain: string
  path: string
  /** Epoch seconds; null for a session cookie. */
  expires: number | null
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  /** Value length in bytes — the value itself never leaves the runtime. */
  size?: number
}

export type BrowserStorageArea = "local" | "session"

export interface BrowserStorageResult {
  area: BrowserStorageArea
  origin?: string
  /**
   * All entries (no `key`) or the one asked for. A `null` value is a real
   * "absent" only when `valuesWithheld` is not set; see `exists` for a
   * single-key read.
   */
  entries: Record<string, string | null>
  /**
   * The runtime withheld the values (a non-loopback origin on local
   * Chromium): every value is `null` and says nothing about the real one.
   */
  valuesWithheld?: boolean
  /** Single-key read: whether the key exists, reported even when its value is withheld. */
  exists?: boolean
}

export interface BrowserNetworkRequestDetail {
  id?: string
  url: string
  method: string
  status: number | null
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  /** UTF-8 text, or base64 when `bodyEncoding` says so; null when withheld. */
  body: string | null
  bodyEncoding?: "utf8" | "base64" | null
  truncated: boolean
  bodyBytes?: number
  /** True after human keyboard input or a credential fill: bodies are withheld. */
  bodyRedacted?: boolean
}

export interface BrowserLoginForm {
  ref: string
  usernameRef?: string
  passwordRef: string
  origin: string
}

export interface BrowserCredentialFillArgs {
  /** A vault credential id; omitted → the unique registrable-domain match. */
  credentialId?: string
  pageId?: string
  /** The page URL to match against; defaults to the live page. */
  url?: string
}

export interface BrowserCredentialFillResult {
  filled: boolean
  username: string | null
  reason: CredentialFillReason | null
}

export interface BrowserMutationResult extends BrowserDialogState {
  ok: boolean
  error?: string | null
  generation?: number
}

export interface BrowserZoomResult extends BrowserMutationResult {
  zoom?: number
}

export interface HandleDialogArgs {
  accept: boolean
  promptText?: string
}

export interface FindOptions {
  forward?: boolean
  matchCase?: boolean
}

export interface ScreenshotOptions {
  scope?: "viewport" | "fullPage" | "element"
  ref?: string
}

export interface ScrollArgs {
  reference?: string
  direction?: "up" | "down" | "left" | "right" | "top" | "bottom"
  amount?: number
}

export interface WaitForOptions {
  /** Wait for the condition to be met (default) or to clear. */
  mode?: "appear" | "disappear"
  timeoutMs?: number
  intervalMs?: number
}

export interface NetworkIdleOptions {
  timeoutMs?: number
  /** How long the network must stay quiet (no in-flight + no completions). */
  idleMs?: number
  intervalMs?: number
}

export interface WaitForResult {
  ok: boolean
  timedOut: boolean
}

export interface WaitForLoadOptions {
  /** URL the navigation should land on (redirects may change it — see fromUrl). */
  targetUrl?: string
  /** URL before the navigation; leaving it also counts as "arrived". */
  fromUrl?: string
  timeoutMs?: number
  intervalMs?: number
  /** Delay before the first poll (lets a same-URL reload actually start). */
  initialDelayMs?: number
}

export type EngineBackendPreference =
  "auto" | "embedded" | "remote-chromium" | "local-chromium" | "user-chrome" | "extension"
