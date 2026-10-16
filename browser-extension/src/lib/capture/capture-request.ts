/**
 * The record the background worker leaves for the side panel.
 *
 * It exists because the two are not alive at the same time. A context-menu
 * click happens in the worker; the panel it opens may be starting from nothing.
 * Passing a message would need a listener that is not there yet, so the worker
 * writes a request and the panel reads it on mount.
 *
 * What crosses is a tab id and a mode — never page content. The panel does the
 * extraction itself, because `activeTab` is granted to the gesture that opened
 * it and because the user reviews the result before anything is sent.
 */

/** `chrome.storage.local` key holding the pending request. */
export const CAPTURE_REQUEST_KEY = "cognia.captureRequest.v1"

export const CAPTURE_MENU_IDS = {
  selection: "cognia-capture-selection",
  page: "cognia-capture-page",
  article: "cognia-capture-article",
  link: "cognia-capture-link",
  image: "cognia-capture-image",
  /** Parent of the quick actions submenu; never a request on its own. */
  quick: "cognia-quick",
} as const

/** One-click instructions, offered in the context menu and the panel (ADR-0228 §1). */
export const QUICK_ACTIONS = ["summarize", "explain", "translate"] as const
export type QuickActionId = (typeof QUICK_ACTIONS)[number]

/** Each quick action's label key in `_locales`. */
export const QUICK_ACTION_LABEL_KEYS: Record<QuickActionId, string> = {
  summarize: "quickActionSummarize",
  explain: "quickActionExplain",
  translate: "quickActionTranslate",
}

export function quickActionMenuId(action: QuickActionId): string {
  return `${CAPTURE_MENU_IDS.quick}-${action}`
}

export function isQuickAction(value: unknown): value is QuickActionId {
  return typeof value === "string" && (QUICK_ACTIONS as readonly string[]).includes(value)
}

/** The keyboard commands besides the toolbar's own `_execute_action`. */
export const CAPTURE_COMMANDS = {
  page: "capture-page",
  selection: "capture-selection",
  article: "capture-article",
} as const

/**
 * `auto` means "take the selection if there is one, otherwise the metadata" —
 * the toolbar and shortcut path, where the user has not said which they want.
 */
export type CaptureRequestMode = "auto" | "selection" | "page" | "article" | "link" | "image"

export interface CaptureRequest {
  tabId: number
  mode: CaptureRequestMode
  requestedAt: number
  /** The link right-clicked, for `link`. http(s) only. */
  linkUrl?: string
  /** The link's own text, when the browser reported a selection over it. */
  linkText?: string
  /** The image right-clicked, for `image`. http(s) only. */
  srcUrl?: string
  /** A quick action chosen from the menu; the panel fills its instruction. */
  quickAction?: QuickActionId
  /** Text typed after the omnibox keyword, as the instruction. */
  instruction?: string
}

/** Whether a menu entry should be offered for a tab at all. */
export function shouldOfferCaptureMenu(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

function webUrl(value: string | undefined): string | undefined {
  return value && shouldOfferCaptureMenu(value) ? value : undefined
}

/** What the context-menu listener receives, narrowed to what is used. */
export interface MenuClick {
  menuItemId: string | number
  linkUrl?: string
  srcUrl?: string
  selectionText?: string
}

/** Turn a clicked menu entry into a request, or `null` if it is not one of ours. */
export function captureRequestForMenu(
  click: MenuClick | string,
  tabId: number,
  requestedAt: number
): CaptureRequest | null {
  const info: MenuClick = typeof click === "string" ? { menuItemId: click } : click
  const id = String(info.menuItemId)
  if (id === CAPTURE_MENU_IDS.selection) return { tabId, mode: "selection", requestedAt }
  if (id === CAPTURE_MENU_IDS.page) return { tabId, mode: "page", requestedAt }
  if (id === CAPTURE_MENU_IDS.article) return { tabId, mode: "article", requestedAt }
  if (id === CAPTURE_MENU_IDS.link) {
    const linkUrl = webUrl(info.linkUrl)
    if (!linkUrl) return null
    const linkText = info.selectionText?.trim()
    return { tabId, mode: "link", requestedAt, linkUrl, ...(linkText ? { linkText } : {}) }
  }
  if (id === CAPTURE_MENU_IDS.image) {
    const srcUrl = webUrl(info.srcUrl)
    return srcUrl ? { tabId, mode: "image", requestedAt, srcUrl } : null
  }
  for (const action of QUICK_ACTIONS) {
    if (id === quickActionMenuId(action)) {
      // A quick action on a selection acts on the selection; otherwise on the
      // page's main content.
      return {
        tabId,
        mode: info.selectionText?.trim() ? "selection" : "article",
        requestedAt,
        quickAction: action,
      }
    }
  }
  return null
}

/** Turn a keyboard command into a request, or `null` if it is not one of ours. */
export function captureRequestForCommand(
  command: string,
  tabId: number,
  requestedAt: number
): CaptureRequest | null {
  if (command === CAPTURE_COMMANDS.page) return { tabId, mode: "auto", requestedAt }
  if (command === CAPTURE_COMMANDS.selection) return { tabId, mode: "selection", requestedAt }
  if (command === CAPTURE_COMMANDS.article) return { tabId, mode: "article", requestedAt }
  return null
}

/** The omnibox keyword's text, as a request on the tab in front. */
export const MAX_OMNIBOX_INSTRUCTION = 2_000

export function captureRequestForOmnibox(
  text: string,
  tabId: number,
  requestedAt: number
): CaptureRequest | null {
  const instruction = text.trim().slice(0, MAX_OMNIBOX_INSTRUCTION)
  return instruction ? { tabId, mode: "auto", requestedAt, instruction } : null
}

/** Read back a stored request, dropping anything malformed or not ours. */
export function parseCaptureRequest(value: unknown): CaptureRequest | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const modes: readonly string[] = ["auto", "selection", "page", "article", "link", "image"]
  if (
    typeof record.tabId !== "number" ||
    typeof record.requestedAt !== "number" ||
    typeof record.mode !== "string" ||
    !modes.includes(record.mode)
  ) {
    return null
  }
  const request: CaptureRequest = {
    tabId: record.tabId,
    mode: record.mode as CaptureRequestMode,
    requestedAt: record.requestedAt,
  }
  const linkUrl = webUrl(typeof record.linkUrl === "string" ? record.linkUrl : undefined)
  const srcUrl = webUrl(typeof record.srcUrl === "string" ? record.srcUrl : undefined)
  if (request.mode === "link" && !linkUrl) return null
  if (request.mode === "image" && !srcUrl) return null
  if (linkUrl) request.linkUrl = linkUrl
  if (typeof record.linkText === "string" && record.linkText) request.linkText = record.linkText
  if (srcUrl) request.srcUrl = srcUrl
  if (isQuickAction(record.quickAction)) request.quickAction = record.quickAction
  if (typeof record.instruction === "string" && record.instruction.trim()) {
    request.instruction = record.instruction.slice(0, MAX_OMNIBOX_INSTRUCTION)
  }
  return request
}

/**
 * Whether a stored request is recent enough to act on.
 *
 * A request older than this is one the browser held while the panel was shut,
 * possibly across a restart. Acting on it would capture whatever tab now has
 * that id, which is not what the user asked for and may not even be the same
 * page.
 */
export const CAPTURE_REQUEST_TTL_MS = 60_000

export function isFreshCaptureRequest(request: CaptureRequest, now: number): boolean {
  return now - request.requestedAt < CAPTURE_REQUEST_TTL_MS && now >= request.requestedAt
}
