/**
 * Renderer client for the desktop's local browser runtime (ADR-0201).
 *
 * `services/workspace-runtime` runs on loopback under Rust supervision
 * (`src-tauri/src/browser/local.rs`). The renderer never sees its URL or
 * secret: every operation goes through `browser_local_rpc(op, payload)`, whose
 * Rust allow-list excludes the value-carrying ops (`browser.cookies.set`,
 * `browser.credential.fill`). Frames arrive through a Tauri `Channel` as the
 * same 24-byte framed JPEG the cloud stream uses, so
 * `decodeRemoteBrowserFrame` reads them unchanged. Events are re-emitted as
 * `browser-local://event`.
 */
import { Channel, invoke } from "@tauri-apps/api/core"
import type { UnlistenFn } from "@tauri-apps/api/event"

import type { BrowserDownloadSummary } from "@/lib/browser/session-types"
import { transport } from "@/lib/tauri"

export const LOCAL_BROWSER_EVENTS = {
  /** Runtime journal events, re-emitted by Rust. */
  event: "browser-local://event",
  /** Chromium install progress. */
  install: "browser-local://install",
} as const

export interface LocalBrowserStatus {
  installed: boolean
  installing: boolean
  chromiumVersion: string | null
  running: boolean
  runtimeStaged: boolean
  error: string | null
}

export interface LocalBrowserInstallProgress {
  phase: "downloading" | "extracting" | "done" | "failed"
  receivedBytes?: number
  totalBytes?: number
  message?: string
}

export type LocalBrowserEvent =
  | { type: "pages.changed"; sessionId: string; [key: string]: unknown }
  | { type: "download.updated"; sessionId: string; download: BrowserDownloadSummary }
  | {
      type: "dialog.opened"
      sessionId: string
      dialog?: { type: string; message: string; defaultValue?: string }
      [key: string]: unknown
    }
  | { type: "session.closed"; sessionId: string; [key: string]: unknown }
  | {
      type: "credential.submitted"
      sessionId: string
      origin: string
      username: string
      /** Opaque id of the Rust-held pending save; the password never crosses IPC. */
      pendingId: string
    }
  | { type: "extensions.changed"; sessionId: string; [key: string]: unknown }
  | {
      /**
       * A page opened a file chooser. Headless Chromium shows no dialog: the
       * pane lets the user pick through {@link localBrowser.stageUpload} and
       * answers with {@link localBrowser.answerFileChooser}.
       */
      type: "filechooser.opened"
      sessionId: string
      pageId: string
      chooserId: string
      multiple: boolean
    }
  | {
      /**
       * The in-page picker took `count` picks on `pageId` (ADR-0214). Only the
       * signal crosses: the pane showing that page drains the picks itself.
       */
      type: "element.selected"
      sessionId: string
      pageId: string
      count: number
      generation: number
    }

export type LocalBrowserEventType = LocalBrowserEvent["type"]

export const LOCAL_BROWSER_EVENT_TYPES: readonly LocalBrowserEventType[] = [
  "pages.changed",
  "download.updated",
  "dialog.opened",
  "session.closed",
  "credential.submitted",
  "extensions.changed",
  "filechooser.opened",
  "element.selected",
]

export const USER_CHROME_BROWSERS = [
  "chrome",
  "chrome-beta",
  "chrome-canary",
  "edge",
  "brave",
] as const

export type UserChromeBrowser = (typeof USER_CHROME_BROWSERS)[number]

export function isUserChromeBrowser(value: unknown): value is UserChromeBrowser {
  return (USER_CHROME_BROWSERS as readonly unknown[]).includes(value)
}

export interface UserChromeCandidate {
  browser: UserChromeBrowser | string
  label: string
  userDataDir: string
  available: boolean
  reason: "remote_debugging_disabled" | "not_installed" | null
}

/** Payload of `browser.session.create` as the renderer may send it (Rust strips the rest). */
export interface LocalBrowserSessionCreate {
  id: string
  kind: "local" | "user-chrome"
  headless?: boolean
  profileId?: string
  /** For `kind: "user-chrome"` (Rust defaults to "chrome" and resolves the endpoint itself). */
  browser?: UserChromeBrowser
  allowFileUrls?: boolean
  viewport?: { width: number; height: number }
  grants?: string[]
}

function isLocalBrowserEvent(value: unknown): value is LocalBrowserEvent {
  if (!value || typeof value !== "object") return false
  const event = value as { type?: unknown; sessionId?: unknown }
  return (
    typeof event.type === "string" &&
    (LOCAL_BROWSER_EVENT_TYPES as readonly string[]).includes(event.type)
  )
}

/** Normalize whatever a `Channel<Vec<u8>>` delivered into bytes. */
export function toFrameBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  if (Array.isArray(value) && value.every((byte) => typeof byte === "number")) {
    return Uint8Array.from(value as number[])
  }
  return null
}

export const localBrowser = {
  status(): Promise<LocalBrowserStatus> {
    return transport.call<LocalBrowserStatus>("browser_local_status")
  },
  install(): Promise<LocalBrowserStatus> {
    return transport.call<LocalBrowserStatus>("browser_local_install")
  },
  uninstall(): Promise<LocalBrowserStatus> {
    return transport.call<LocalBrowserStatus>("browser_local_uninstall")
  },
  start(): Promise<LocalBrowserStatus> {
    return transport.call<LocalBrowserStatus>("browser_local_start")
  },
  stop(): Promise<void> {
    return transport.call<void>("browser_local_stop")
  },
  /** Issue one allow-listed runtime op. */
  rpc<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
    return transport.call<T>("browser_local_rpc", { op, payload })
  },
  /**
   * Stream a session's screencast. Resolves to an unsubscribe that also tells
   * Rust to stop polling. Uses `invoke` directly: a `Channel` is a desktop-only
   * IPC primitive the routing transport cannot forward.
   */
  async subscribeFrames(
    sessionId: string,
    onFrame: (bytes: Uint8Array) => void
  ): Promise<() => void> {
    // Rust sends `InvokeResponseBody::Raw`, which arrives as an ArrayBuffer;
    // `toFrameBytes` also accepts the JSON byte-array form older shells used.
    const channel = new Channel<ArrayBuffer>()
    let active = true
    channel.onmessage = (message) => {
      if (!active) return
      const bytes = message instanceof ArrayBuffer ? new Uint8Array(message) : toFrameBytes(message)
      if (bytes) onFrame(bytes)
    }
    await invoke("browser_local_frames_subscribe", { sessionId, channel })
    return () => {
      if (!active) return
      active = false
      void invoke("browser_local_frames_unsubscribe", { sessionId }).catch(() => undefined)
    }
  },
  async onEvent(callback: (event: LocalBrowserEvent) => void): Promise<UnlistenFn> {
    return transport.subscribe<unknown>(LOCAL_BROWSER_EVENTS.event, (payload) => {
      if (isLocalBrowserEvent(payload)) callback(payload)
    })
  },
  async onInstallProgress(
    callback: (progress: LocalBrowserInstallProgress) => void
  ): Promise<UnlistenFn> {
    return transport.subscribe<LocalBrowserInstallProgress>(LOCAL_BROWSER_EVENTS.install, callback)
  },
  discoverUserChrome(): Promise<UserChromeCandidate[]> {
    return transport.call<UserChromeCandidate[]>("browser_user_chrome_discover")
  },
  /**
   * Create a runtime session (starting the runtime first when it is not
   * running). Rust errors are `"<code>: message"` strings — `chromium_not_installed`,
   * `remote_debugging_disabled`, `runtime_not_staged`, `node_runtime_unavailable`,
   * `install_in_progress`, `browser_op_not_allowed`; `toLocalBrowserError`
   * (`local-chromium-engine.ts`) turns them into coded errors.
   */
  async createSession(payload: LocalBrowserSessionCreate): Promise<{ id: string }> {
    const status = await localBrowser.status()
    if (!status.running) await localBrowser.start()
    return localBrowser.rpc<{ id: string }>(
      "browser.session.create",
      payload as unknown as Record<string, unknown>
    )
  },
  closeSession(sessionId: string): Promise<void> {
    return localBrowser.rpc<void>("browser.session.close", { sessionId })
  },
  /**
   * Let the user pick files in a native picker; Rust copies them under
   * `<app_data>/browser/uploads`, the only directory a local session may
   * upload from, and returns the staged absolute paths (empty when the picker
   * was cancelled). Hand them to `browser.files.set` or
   * {@link localBrowser.answerFileChooser}.
   */
  stageUpload(): Promise<string[]> {
    return transport.call<string[]>("browser_local_stage_upload")
  },
  /**
   * Answer a `filechooser.opened` with staged paths; an empty list cancels
   * it. The runtime refuses any path outside the session's upload root.
   */
  answerFileChooser(
    sessionId: string,
    chooserId: string,
    paths: string[]
  ): Promise<{ ok: boolean; cancelled: boolean }> {
    return localBrowser.rpc<{ ok: boolean; cancelled: boolean }>("browser.filechooser.set", {
      sessionId,
      chooserId,
      paths,
    })
  },
}
