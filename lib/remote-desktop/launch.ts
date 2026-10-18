/**
 * Opening a binding the Host does not bridge (ADR-0234 Phase 5): the
 * user's own web console, or a local app (RustDesk) handed an ID.
 *
 * The Host decides where to go (`remote_desktop_binding_launch`, which needs
 * control); this module opens it the way the client can:
 *
 * - **Desktop app**: a console opens in the viewer page's `remote-console`
 *   webview (`console-webview.ts`), and RustDesk opens through
 *   `remote_desktop_open_app`, which re-parses the link in Rust.
 * - **Phone**: a console opens in the in-app browser, and RustDesk opens
 *   through the native `CogniaAppHandoff` plugin. That plugin can tell when
 *   RustDesk is not installed.
 * - **Web**: a console opens in a new tab, and RustDesk opens by navigating to
 *   the link.
 *
 * Every link is re-checked here before it is opened, so a compromised or
 * outdated Host cannot make this client open something else. Cognia never
 * learns whether RustDesk connected, and the UI never claims it did.
 */

import { open as openInAppBrowser } from "@/lib/capacitor/browser"
import { isAppHandoffAvailable, openInApp } from "@/lib/capacitor/app-handoff"
import { isMobile } from "@/lib/capacitor/_shared"
import { isTauri } from "@/lib/tauri"
import { localTransport } from "@/lib/tauri/transport-instance"

import { RemoteDesktopError } from "./host-client"
import type { RemoteDesktopLaunched } from "./types"

/** The only RustDesk link form Cognia opens (`launch::parse_rustdesk_uri`). */
const RUSTDESK_URI =
  /^rustdesk:\/\/connection\/new\/[A-Za-z0-9][A-Za-z0-9_-]{5,31}(?:@(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?)?(?:\?key=(?:%[0-9A-F]{2}|[A-Za-z0-9])+)?$/

/** Query keys that carry a login (`console::CREDENTIAL_KEYS`). */
const CREDENTIAL_KEYS = new Set([
  "token",
  "access_token",
  "id_token",
  "auth",
  "authtoken",
  "login",
  "logintoken",
  "password",
  "passwd",
  "pwd",
  "secret",
])

export function isRustdeskLaunchUri(uri: string): boolean {
  return uri.length <= 512 && RUSTDESK_URI.test(uri)
}

function hasCredential(query: string): boolean {
  for (const key of new URLSearchParams(query).keys()) {
    if (CREDENTIAL_KEYS.has(key.toLowerCase())) return true
  }
  return false
}

/** http(s), a host, no user info, no login in the query or fragment query. */
export function isOpenableConsoleUrl(raw: string): boolean {
  if (raw.length > 2048) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return false
  if (url.username || url.password) return false
  const fragmentQuery = url.hash.includes("?") ? url.hash.slice(url.hash.indexOf("?") + 1) : ""
  return !hasCredential(url.search) && !hasCredential(fragmentQuery)
}

export type RemoteDesktopClientKind = "desktop" | "phone" | "web"

export function remoteDesktopClientKind(): RemoteDesktopClientKind {
  if (isTauri()) return "desktop"
  if (isMobile()) return "phone"
  return "web"
}

export interface LaunchDeps {
  kind?: RemoteDesktopClientKind
  /** Desktop: the Tauri command that opens a RustDesk link from Rust. */
  openAppOnDesktop?: (uri: string) => Promise<void>
  /** Phone: the native handoff. */
  handoffAvailable?: () => Promise<boolean>
  handoff?: (uri: string) => Promise<boolean>
  /** Phone: the in-app browser. */
  openInAppBrowser?: (url: string) => Promise<boolean>
  /** Web: open a tab, or navigate to an app link. */
  openTab?: (url: string) => void
  navigate?: (uri: string) => void
}

const desktopOpenApp = (uri: string) =>
  localTransport.call<void>("remote_desktop_open_app", { uri })

/**
 * Open an external-app link. Resolves once the app was asked; rejects with
 * `remote_desktop_launch_app_missing` when the phone has no RustDesk, and
 * with `remote_desktop_launch_uri_invalid` for anything but the one form.
 */
export async function openExternalApp(uri: string, deps: LaunchDeps = {}): Promise<void> {
  if (!isRustdeskLaunchUri(uri)) throw new RemoteDesktopError("remote_desktop_launch_uri_invalid")
  const kind = deps.kind ?? remoteDesktopClientKind()
  if (kind === "desktop") {
    try {
      await (deps.openAppOnDesktop ?? desktopOpenApp)(uri)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new RemoteDesktopError(
        /remote_desktop_launch_uri_invalid/.test(message)
          ? "remote_desktop_launch_uri_invalid"
          : "remote_desktop_launch_app_missing"
      )
    }
    return
  }
  if (kind === "phone") {
    const available = await (deps.handoffAvailable ?? (() => isAppHandoffAvailable("rustdesk")))()
    const opened =
      available && (await (deps.handoff ?? ((link: string) => openInApp("rustdesk", link)))(uri))
    if (!opened) throw new RemoteDesktopError("remote_desktop_launch_app_missing")
    return
  }
  ;(deps.navigate ?? ((link: string) => window.location.assign(link)))(uri)
}

/**
 * Open a console outside the desktop app: the phone's in-app browser or a
 * new tab. The desktop app embeds it instead (`console-webview.ts`).
 */
export async function openConsoleOutside(url: string, deps: LaunchDeps = {}): Promise<void> {
  if (!isOpenableConsoleUrl(url)) throw new RemoteDesktopError("remote_desktop_console_url_invalid")
  const kind = deps.kind ?? remoteDesktopClientKind()
  if (kind === "phone") {
    const opened = await (
      deps.openInAppBrowser ??
      (async (link: string) => (await openInAppBrowser({ url: link })).kind === "ok")
    )(url)
    if (!opened) throw new RemoteDesktopError("remote_desktop_console_unavailable")
    return
  }
  // `noopener` makes window.open return null even when the tab opened, so
  // its result says nothing.
  ;(deps.openTab ?? ((link: string) => void window.open(link, "_blank", "noopener,noreferrer")))(
    url
  )
}

/** Open what the Host returned for an external app outside the viewer page. */
export async function openLaunched(
  launched: RemoteDesktopLaunched,
  deps: LaunchDeps = {}
): Promise<void> {
  if (launched.kind === "external-app") return openExternalApp(launched.uri, deps)
  return openConsoleOutside(launched.url, deps)
}
