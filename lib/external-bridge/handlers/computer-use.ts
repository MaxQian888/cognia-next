/**
 * External Bridge handler — `computer_use` MCP tool.
 *
 * The tool exposes Cognia's automation subsystem to external coding agents
 * (Claude Code, Cursor, Cline, Codex) over MCP. Schema mirrors Anthropic's
 * `computer_20251124` action union but stays platform-agnostic — the
 * underlying dispatch goes through the same Tauri `desktop_*` commands the
 * in-app character path uses.
 *
 * # Where the dispatch goes
 *
 * The MCP server runs in a Node sidecar process spawned by Tauri (see
 * `src-tauri/src/mcp_server/sidecar.rs`). The sidecar cannot directly
 * invoke Tauri commands — those are renderer-side. Instead the handler
 * emits a structured request via stdout that the Tauri Rust side
 * recognises and forwards to the automation worker:
 *
 *   `{ kind: "automation_proxy", command: "desktop_click", args: {...} }`
 *
 * The Rust side runs the command through the same permission gate + audit
 * pipeline as a renderer-driven call (with `surface: "mcp"`), and writes
 * the result back as a JSON-RPC response on stdin.
 *
 * Until the Rust automation-proxy IPC lands, the handler returns a clear
 * error envelope so external agents see *why* the call didn't run. The
 * MCP tool is still advertised (with its full schema) so agents can
 * discover the surface and plan around the gap.
 */

import { desktop } from "@/lib/automation/client"
import { isTauri } from "@/lib/tauri"
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
  /** For `click` / `mouse_move` / `scroll` — coordinate target. */
  coordinate?: [number, number]
  /** For `click` — left / right / middle. */
  button?: MouseButton
  /** For `click` — single vs double click. */
  double?: boolean
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
  /** Reason the call failed. Present iff `ok === false`. */
  error?: string
}

/**
 * Dispatch a `computer_use` action. Always goes through the renderer-side
 * `desktop` client so the call lands on `Surface::Mcp` at the Rust gate —
 * the gate enforces the same tier + whitelist + consent flow as a
 * character-driven call, but with the MCP-specific policy.
 */
export async function computerUse(input: ComputerUseInput): Promise<ComputerUseOutput> {
  // The MCP server runs in a Node sidecar in production. Tauri commands
  // aren't reachable from there yet — return a structured error so the
  // external agent gets a clear reason.
  if (!isTauri()) {
    return {
      ok: false,
      error:
        "computer_use over MCP requires the Cognia desktop runtime. Sidecar-to-renderer " +
        "dispatch IPC will land in a follow-up commit; for now use the in-app character " +
        "path (Settings → Characters → enable Computer Use).",
    }
  }

  const ctx = { surface: "mcp" as const }

  try {
    switch (input.action) {
      case "screenshot": {
        const shot = await desktop.screenshot({}, ctx)
        return {
          ok: true,
          screenshot: shot.bytes,
          width: shot.width,
          height: shot.height,
        }
      }
      case "click": {
        const [x, y] = requireCoord(input.coordinate, "click")
        const target: ClickTarget = { kind: "point", x, y }
        await desktop.click(target, { button: input.button, double: input.double }, ctx)
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
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

function requireCoord(c: [number, number] | undefined, label: string): [number, number] {
  if (!c || c.length !== 2 || typeof c[0] !== "number" || typeof c[1] !== "number") {
    throw new Error(`${label} requires a 2-element [x, y] number array`)
  }
  return [c[0], c[1]]
}
