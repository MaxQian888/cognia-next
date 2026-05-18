/**
 * External Bridge handler — `computer_use` MCP tool.
 *
 * Exposes Cognia's automation subsystem to external coding agents
 * (Claude Code, Cursor, Cline, Codex) over MCP. Schema mirrors Anthropic's
 * `computer_20251124` action union but stays platform-agnostic — the
 * underlying dispatch goes through the same Rust automation worker the
 * in-app character path uses.
 *
 * # Wire path
 *
 * The MCP server runs in a Node sidecar process spawned by Tauri (see
 * `src-tauri/src/mcp_server/sidecar.rs`). The sidecar cannot directly
 * invoke Tauri commands — those are renderer-side. Instead the handler
 * opens a TCP socket to the dedicated automation-proxy port the Tauri
 * Rust side bound when starting the MCP server. Authentication is a
 * shared-secret token passed through `COGNIA_AUTOMATION_PROXY_TOKEN`;
 * see `src-tauri/src/mcp_server/automation_proxy.rs` for the protocol.
 *
 * When `COGNIA_AUTOMATION_PROXY` is unset (standalone mode — the npm
 * plugin running without the Cognia desktop app), the handler surfaces a
 * structured error so the external agent sees a clear reason instead of
 * silent failures.
 */

import { isTauri } from "@/lib/tauri"
import { desktop } from "@/lib/automation/client"
import type {
  ButtonTransition,
  ClickTarget,
  KeyChord,
  MouseButton,
  Point,
  ScrollTarget,
} from "@/lib/automation/types"

export interface ComputerUseInput {
  action:
    | "screenshot"
    | "click"
    | "type"
    | "keys"
    | "mouse_move"
    | "drag"
    | "scroll"
    | "hold_key"
    | "mouse_button"
    | "cursor_position"
  /** For `click` / `mouse_move` / `scroll` — coordinate target. */
  coordinate?: [number, number]
  /** For `click` — left / right / middle. */
  button?: MouseButton
  /** For `click` — single vs double click. */
  double?: boolean
  /** For `click` — explicit count (1/2/3). Wins over `double`. */
  count?: 1 | 2 | 3
  /** For `type`. */
  text?: string
  /** For `keys` / `hold_key`. */
  chord?: string
  /** For `drag` — start coordinate. */
  startCoordinate?: [number, number]
  /** For `scroll` — `dx` / `dy` in OS wheel units. */
  dx?: number
  dy?: number
  /** For `hold_key` — milliseconds. */
  durationMs?: number
  /** For `mouse_button` — down / up. */
  transition?: ButtonTransition
}

export interface ComputerUseOutput {
  ok: boolean
  /** Base64 screenshot when `action === "screenshot"`. */
  screenshot?: string
  /** Width/height of the screenshot in pixels. */
  width?: number
  height?: number
  /** Cursor position when `action === "cursor_position"`. */
  cursor?: { x: number; y: number }
  /** Reason the call failed. Present iff `ok === false`. */
  error?: string
}

/**
 * Dispatch a `computer_use` action.
 *
 * When `isTauri()` is true (handler being exercised from a test mount or
 * a renderer process), the renderer-side `desktop.*` client handles the
 * call directly so the test path doesn't depend on a live sidecar.
 *
 * Otherwise (the normal production path: Node MCP sidecar), the handler
 * opens the automation-proxy socket and forwards a JSON envelope.
 */
export async function computerUse(input: ComputerUseInput): Promise<ComputerUseOutput> {
  if (isTauri()) {
    return rendererPath(input)
  }
  return sidecarPath(input)
}

// ---------------------------------------------------------------------------
// Renderer-side path — talks to Tauri commands directly. Used by tests and
// when the handler is somehow invoked from the renderer (unusual but valid).
// ---------------------------------------------------------------------------

async function rendererPath(input: ComputerUseInput): Promise<ComputerUseOutput> {
  const ctx = { surface: "mcp" as const }
  try {
    switch (input.action) {
      case "screenshot": {
        const shot = await desktop.screenshot({}, ctx)
        return { ok: true, screenshot: shot.bytes, width: shot.width, height: shot.height }
      }
      case "click": {
        const [x, y] = requireCoord(input.coordinate, "click")
        const target: ClickTarget = { kind: "point", x, y }
        await desktop.click(
          target,
          { button: input.button, double: input.double, count: input.count },
          ctx
        )
        return { ok: true }
      }
      case "type": {
        if (typeof input.text !== "string") {
          return { ok: false, error: "type requires `text` field" }
        }
        await desktop.type(input.text, {}, ctx)
        return { ok: true }
      }
      case "keys": {
        if (!input.chord) return { ok: false, error: "keys requires `chord` field" }
        const chord: KeyChord = [input.chord] as unknown as KeyChord
        await desktop.keys(chord, ctx)
        return { ok: true }
      }
      case "mouse_move": {
        const [x, y] = requireCoord(input.coordinate, "mouse_move")
        await desktop.mouseMove({ x, y }, ctx)
        return { ok: true }
      }
      case "drag": {
        const [fx, fy] = requireCoord(input.startCoordinate, "drag.startCoordinate")
        const [tx, ty] = requireCoord(input.coordinate, "drag.coordinate")
        const from: Point = { x: fx, y: fy }
        const to: Point = { x: tx, y: ty }
        await desktop.drag(from, to, { button: input.button }, ctx)
        return { ok: true }
      }
      case "scroll": {
        const [x, y] = requireCoord(input.coordinate, "scroll")
        const target: ScrollTarget = { kind: "point", x, y }
        await desktop.scroll(target, { dx: input.dx ?? 0, dy: input.dy ?? 0 }, ctx)
        return { ok: true }
      }
      case "hold_key": {
        if (!input.chord) return { ok: false, error: "hold_key requires `chord` field" }
        if (typeof input.durationMs !== "number") {
          return { ok: false, error: "hold_key requires `durationMs` field" }
        }
        const chord: KeyChord = [input.chord] as unknown as KeyChord
        await desktop.holdKey(chord, input.durationMs, ctx)
        return { ok: true }
      }
      case "mouse_button": {
        if (!input.button) return { ok: false, error: "mouse_button requires `button` field" }
        if (!input.transition)
          return { ok: false, error: "mouse_button requires `transition` (down|up)" }
        await desktop.mouseButton(input.button, input.transition, ctx)
        return { ok: true }
      }
      case "cursor_position": {
        const pt = await desktop.cursorPosition(ctx)
        return { ok: true, cursor: { x: pt.x, y: pt.y } }
      }
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  return { ok: false, error: "unknown action" }
}

// ---------------------------------------------------------------------------
// Sidecar path — opens the automation_proxy TCP socket on first use.
// ---------------------------------------------------------------------------

let proxyClient: ProxyClient | null = null

async function sidecarPath(input: ComputerUseInput): Promise<ComputerUseOutput> {
  const addr = typeof process !== "undefined" ? process.env?.COGNIA_AUTOMATION_PROXY : undefined
  const token =
    typeof process !== "undefined" ? process.env?.COGNIA_AUTOMATION_PROXY_TOKEN : undefined

  if (!addr || !token) {
    return {
      ok: false,
      error:
        "computer_use over MCP requires the Cognia desktop runtime — set " +
        "COGNIA_AUTOMATION_PROXY + COGNIA_AUTOMATION_PROXY_TOKEN in the sidecar env. " +
        "Standalone mode is not yet supported.",
    }
  }

  try {
    if (!proxyClient) {
      proxyClient = await openProxyClient(addr, token)
    }
    return await dispatchOverSocket(proxyClient, input)
  } catch (err) {
    // Reset the cached client so the next call retries from scratch (e.g.
    // after a sidecar restart on the Rust side).
    proxyClient = null
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

interface ProxyClient {
  send(envelope: ProxyEnvelope): Promise<ProxyResponse>
  close(): void
}

interface ProxyEnvelope {
  id: string
  token: string
  command: string
  args: Record<string, unknown>
}

interface ProxyResponse {
  id: string
  ok: boolean
  result?: unknown
  error?: string
}

async function openProxyClient(addr: string, token: string): Promise<ProxyClient> {
  // Late-import `node:net` so renderer / test bundles that mock isTauri()
  // don't pull the Node-only module at parse time.
  const net = (await import("node:net")) as typeof import("node:net")
  const [host, portStr] = addr.split(":")
  const port = Number(portStr)
  if (!host || !Number.isInteger(port)) {
    throw new Error(`invalid COGNIA_AUTOMATION_PROXY value: ${addr}`)
  }

  const socket = net.createConnection({ host, port })
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve())
    socket.once("error", reject)
  })
  socket.setNoDelay(true)
  // Each call gets its own pending entry keyed by id — concurrent
  // automation calls from the model multiplex over a single connection.
  const pending = new Map<string, (resp: ProxyResponse) => void>()
  let buffer = ""
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let nl = buffer.indexOf("\n")
    while (nl >= 0) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.length > 0) {
        try {
          const resp = JSON.parse(line) as ProxyResponse
          const cb = pending.get(resp.id)
          if (cb) {
            pending.delete(resp.id)
            cb(resp)
          }
        } catch {
          // Discard malformed lines — the Rust side never emits them.
        }
      }
      nl = buffer.indexOf("\n")
    }
  })
  socket.on("close", () => {
    for (const cb of pending.values()) {
      cb({ id: "", ok: false, error: "automation_proxy socket closed" })
    }
    pending.clear()
  })
  socket.on("error", (err) => {
    for (const cb of pending.values()) {
      cb({ id: "", ok: false, error: `automation_proxy socket error: ${err.message}` })
    }
    pending.clear()
  })

  return {
    send(envelope) {
      return new Promise<ProxyResponse>((resolve) => {
        pending.set(envelope.id, resolve)
        socket.write(JSON.stringify(envelope) + "\n")
      })
    },
    close() {
      try {
        socket.destroy()
      } catch {
        // already closed
      }
    },
  }
  void token // captured by callers via the envelope
}

async function dispatchOverSocket(
  client: ProxyClient,
  input: ComputerUseInput
): Promise<ComputerUseOutput> {
  const token = process.env.COGNIA_AUTOMATION_PROXY_TOKEN as string
  const ctx = { surface: "mcp" }

  function envelope(command: string, args: Record<string, unknown>): ProxyEnvelope {
    return { id: cryptoRandomId(), token, command, args: { ...args, ctx } }
  }

  switch (input.action) {
    case "screenshot": {
      const resp = await client.send(envelope("desktop_screenshot", { opts: {} }))
      if (!resp.ok) return { ok: false, error: resp.error ?? "screenshot failed" }
      const r = resp.result as { bytes: string; width: number; height: number }
      return { ok: true, screenshot: r.bytes, width: r.width, height: r.height }
    }
    case "click": {
      const [x, y] = requireCoord(input.coordinate, "click")
      const target: ClickTarget = { kind: "point", x, y }
      const resp = await client.send(
        envelope("desktop_click", {
          target,
          opts: { button: input.button, double: input.double, count: input.count },
        })
      )
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "click failed" }
    }
    case "type": {
      if (typeof input.text !== "string") {
        return { ok: false, error: "type requires `text` field" }
      }
      const resp = await client.send(envelope("desktop_type", { text: input.text, opts: {} }))
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "type failed" }
    }
    case "keys": {
      if (!input.chord) return { ok: false, error: "keys requires `chord` field" }
      const resp = await client.send(
        envelope("desktop_keys", { chord: [input.chord] as unknown as KeyChord })
      )
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "keys failed" }
    }
    case "mouse_move": {
      const [x, y] = requireCoord(input.coordinate, "mouse_move")
      const resp = await client.send(envelope("desktop_mouse_move", { point: { x, y } }))
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "mouse_move failed" }
    }
    case "drag": {
      const [fx, fy] = requireCoord(input.startCoordinate, "drag.startCoordinate")
      const [tx, ty] = requireCoord(input.coordinate, "drag.coordinate")
      const resp = await client.send(
        envelope("desktop_drag", {
          from: { x: fx, y: fy },
          to: { x: tx, y: ty },
          opts: { button: input.button },
        })
      )
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "drag failed" }
    }
    case "scroll": {
      const [x, y] = requireCoord(input.coordinate, "scroll")
      const resp = await client.send(
        envelope("desktop_scroll", {
          target: { kind: "point", x, y } as ScrollTarget,
          opts: { dx: input.dx ?? 0, dy: input.dy ?? 0 },
        })
      )
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "scroll failed" }
    }
    case "hold_key": {
      if (!input.chord) return { ok: false, error: "hold_key requires `chord` field" }
      if (typeof input.durationMs !== "number") {
        return { ok: false, error: "hold_key requires `durationMs` field" }
      }
      const resp = await client.send(
        envelope("desktop_hold_key", {
          chord: [input.chord] as unknown as KeyChord,
          durationMs: input.durationMs,
        })
      )
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "hold_key failed" }
    }
    case "mouse_button": {
      if (!input.button) return { ok: false, error: "mouse_button requires `button` field" }
      if (!input.transition)
        return { ok: false, error: "mouse_button requires `transition` (down|up)" }
      const resp = await client.send(
        envelope("desktop_mouse_button", {
          button: input.button,
          transition: input.transition,
        })
      )
      return resp.ok ? { ok: true } : { ok: false, error: resp.error ?? "mouse_button failed" }
    }
    case "cursor_position": {
      const resp = await client.send(envelope("desktop_cursor_position", {}))
      if (!resp.ok) return { ok: false, error: resp.error ?? "cursor_position failed" }
      const r = resp.result as { x: number; y: number }
      return { ok: true, cursor: { x: r.x, y: r.y } }
    }
  }
  return { ok: false, error: "unknown action" }
}

function cryptoRandomId(): string {
  // Use `crypto.randomUUID` when available (Node 19+) for deterministic
  // monotonic ids; fall back to a Math.random hex string otherwise.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cryptoMod = require("node:crypto") as typeof import("node:crypto")
    return cryptoMod.randomUUID()
  } catch {
    return Math.random().toString(16).slice(2) + Date.now().toString(16)
  }
}

function requireCoord(c: [number, number] | undefined, label: string): [number, number] {
  if (!c || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
    throw new Error(`${label} requires a 2-element [x, y] number array`)
  }
  return [c[0], c[1]]
}

// Exposed for tests so the cached connection can be reset between cases.
export const __testing__ = {
  resetProxyClient(): void {
    if (proxyClient) {
      try {
        proxyClient.close()
      } catch {
        // ignore — best-effort cleanup
      }
    }
    proxyClient = null
  },
}
