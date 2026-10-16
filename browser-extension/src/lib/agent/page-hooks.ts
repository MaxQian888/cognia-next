/**
 * Main-world hooks the agent needs on a page it acts in (ADR-0228 §6).
 *
 * The overlay runs in the extension's isolated world, which sees the page's
 * DOM but not its globals — so it cannot see the page's console, its `fetch`
 * and XHR traffic, or the `alert` / `confirm` / `prompt` that would freeze the
 * tab under a synthetic click. These hooks install once per document in the
 * page's own world, via `/page-hooks.js`.
 *
 * Dialogs never block. A dialog takes the policy the agent last set with
 * `browser_handle_dialog`, once; with none it is dismissed — `confirm` answers
 * false, `prompt` null — which is the safe default for an action nobody
 * confirmed. Either way the dialog is recorded, so the agent learns it
 * happened.
 */

export interface ConsoleLine {
  level: "log" | "info" | "warn" | "error" | "debug"
  text: string
  ts: number
}

export interface NetworkLine {
  url: string
  method: string
  status: number
  ok: boolean
  durationMs: number | null
}

export interface DialogRecord {
  type: "alert" | "confirm" | "prompt"
  message: string
  defaultValue: string
  /** How it was answered. */
  accepted: boolean
  at: number
}

export interface PageHooks {
  drainConsole(): ConsoleLine[]
  drainNetwork(): NetworkLine[]
  networkState(): { pending: number; completed: number }
  setDialogPolicy(policy: { accept: boolean; promptText?: string } | null): void
  lastDialog(): DialogRecord | null
}

const MAX_LINES = 500
const MAX_TEXT = 2_000

// `console` is a global binding in the DOM lib, not a `Window` member, so it
// is named here for the hooks to replace it on the window they were given.
type HookWindow = Window & {
  __cogniaPageHooks?: PageHooks
  console: Console
  XMLHttpRequest: typeof XMLHttpRequest
}

export function installPageHooks(win: HookWindow, now: () => number = () => Date.now()): PageHooks {
  if (win.__cogniaPageHooks) return win.__cogniaPageHooks
  const consoleLines: ConsoleLine[] = []
  const networkLines: NetworkLine[] = []
  let pending = 0
  let completed = 0
  let policy: { accept: boolean; promptText?: string } | null = null
  let lastDialog: DialogRecord | null = null

  const push = <T>(buffer: T[], line: T) => {
    buffer.push(line)
    if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES)
  }
  const stringify = (values: unknown[]) =>
    values
      .map((value) => {
        if (typeof value === "string") return value
        try {
          return JSON.stringify(value)
        } catch {
          return String(value)
        }
      })
      .join(" ")
      .slice(0, MAX_TEXT)

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = win.console[level].bind(win.console)
    win.console[level] = (...values: unknown[]) => {
      push(consoleLines, { level, text: stringify(values), ts: now() })
      original(...values)
    }
  }
  win.addEventListener("error", (event) => {
    push(consoleLines, {
      level: "error",
      text: String(event.message).slice(0, MAX_TEXT),
      ts: now(),
    })
  })
  win.addEventListener("unhandledrejection", (event) => {
    push(consoleLines, {
      level: "error",
      text: `Unhandled rejection: ${stringify([event.reason])}`,
      ts: now(),
    })
  })

  const originalFetch = win.fetch?.bind(win)
  if (originalFetch) {
    win.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const started = now()
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase()
      pending++
      try {
        const response = await originalFetch(input, init)
        push(networkLines, {
          url: url.slice(0, MAX_TEXT),
          method,
          status: response.status,
          ok: response.ok,
          durationMs: now() - started,
        })
        return response
      } catch (error) {
        push(networkLines, {
          url: url.slice(0, MAX_TEXT),
          method,
          status: 0,
          ok: false,
          durationMs: now() - started,
        })
        throw error
      } finally {
        pending--
        completed++
      }
    }
  }

  const Xhr = win.XMLHttpRequest
  if (Xhr) {
    const open = Xhr.prototype.open
    const send = Xhr.prototype.send
    Xhr.prototype.open = function (
      this: XMLHttpRequest & { __cognia?: { method: string; url: string } },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.__cognia = { method: String(method).toUpperCase(), url: String(url) }
      return (open as (...args: unknown[]) => void).call(this, method, url, ...rest)
    } as typeof Xhr.prototype.open
    Xhr.prototype.send = function (
      this: XMLHttpRequest & { __cognia?: { method: string; url: string } },
      body?: Document | XMLHttpRequestBodyInit | null
    ) {
      const started = now()
      const meta = this.__cognia ?? { method: "GET", url: "" }
      pending++
      this.addEventListener(
        "loadend",
        () => {
          pending--
          completed++
          push(networkLines, {
            url: meta.url.slice(0, MAX_TEXT),
            method: meta.method,
            status: this.status,
            ok: this.status >= 200 && this.status < 400,
            durationMs: now() - started,
          })
        },
        { once: true }
      )
      return send.call(this, body)
    }
  }

  const answer = (type: DialogRecord["type"], message: unknown, defaultValue = "") => {
    const decided = policy
    policy = null
    const accepted = type === "alert" ? true : (decided?.accept ?? false)
    lastDialog = {
      type,
      message: String(message ?? "").slice(0, MAX_TEXT),
      defaultValue,
      accepted,
      at: now(),
    }
    push(consoleLines, {
      level: "info",
      text: `[dialog ${type} ${accepted ? "accepted" : "dismissed"}] ${lastDialog.message}`,
      ts: lastDialog.at,
    })
    return { accepted, promptText: decided?.promptText }
  }
  win.alert = (message?: unknown) => {
    answer("alert", message)
  }
  win.confirm = (message?: string) => answer("confirm", message).accepted
  win.prompt = (message?: string, defaultValue?: string) => {
    const { accepted, promptText } = answer("prompt", message, defaultValue ?? "")
    return accepted ? (promptText ?? defaultValue ?? "") : null
  }

  const hooks: PageHooks = {
    drainConsole: () => consoleLines.splice(0, consoleLines.length),
    drainNetwork: () => networkLines.splice(0, networkLines.length),
    networkState: () => ({ pending, completed }),
    setDialogPolicy: (next) => {
      policy = next
    },
    lastDialog: () => lastDialog,
  }
  Object.defineProperty(win, "__cogniaPageHooks", {
    value: hooks,
    configurable: false,
    enumerable: false,
    writable: false,
  })
  return hooks
}
