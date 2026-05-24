/**
 * Translate the Anthropic `computer_20251124` action JSON into renderer-side
 * `desktop.*` calls. Used by:
 *
 * - `plugins/computer-use/src/index.ts` — the plugin MCP tool's `execute()`
 *   callback. The model invokes `mcp__cognia-plugin-tools__computer_use` with
 *   one of the action variants; the executor routes to `desktop.*` for
 *   every action *except* `wait`, which sleeps inside this module so we
 *   don't need a Rust round-trip for a pure delay.
 * - `lib/external-bridge/handlers/computer-use.ts` — the external-bridge MCP
 *   tool handler when running renderer-side (test mounts; the sidecar path
 *   uses the socket envelope).
 *
 * The action enum mirrors `plugins/computer-use/rust/src/types.rs::ComputerAction`
 * so adding new variants requires changes in lockstep on both sides.
 *
 * Surface tagging: every call routes through the `surface` field on the
 * passed `CallContext` so the Rust permission gate fires with the right
 * policy (chat → `computerUse`, MCP → `mcp`). Callers MUST set surface.
 */

import { desktop, type CallContext } from "@/lib/automation/client"
import {
  elementRefValue,
  keyChord,
  type ClickOpts,
  type ClickTarget,
  type ScrollOpts,
  type ScrollTarget,
} from "@/lib/automation/types"

/**
 * Each "amount" from Anthropic's scroll action corresponds to one wheel
 * notch (120 wheel units). Mirrors the Rust constant in
 * `plugins/computer-use/rust/src/translator.rs::WHEEL_DELTA_PER_AMOUNT`.
 */
const WHEEL_DELTA_PER_AMOUNT = 120

/**
 * Union of every action shape the Anthropic `computer_20251124` tool can
 * emit. The discriminator is `action`. Coordinates are `[x, y]` tuples.
 *
 * Keep field names snake_case — they come straight from the API and the
 * model emits them verbatim. The Rust enum uses serde's `snake_case` rename
 * so the two sides agree.
 */
export type ComputerAction =
  | { action: "screenshot" }
  | { action: "left_click"; coordinate: [number, number] }
  | { action: "right_click"; coordinate: [number, number] }
  | { action: "middle_click"; coordinate: [number, number] }
  | { action: "double_click"; coordinate: [number, number] }
  | { action: "triple_click"; coordinate: [number, number] }
  | { action: "mouse_move"; coordinate: [number, number] }
  | {
      action: "left_click_drag"
      start_coordinate: [number, number]
      coordinate: [number, number]
    }
  | { action: "left_mouse_down" }
  | { action: "left_mouse_up" }
  | {
      action: "scroll"
      coordinate: [number, number]
      scroll_direction: "up" | "down" | "left" | "right"
      scroll_amount: number
    }
  | { action: "type"; text: string }
  | { action: "key"; text: string }
  | { action: "hold_key"; text: string; duration: number }
  | { action: "wait"; duration: number }
  | { action: "cursor_position" }

/**
 * Result envelope returned to the model. Shape mirrors
 * `plugins/computer-use/rust/src/types.rs::ComputerResult` — we use
 * snake_case for `display_width_px` / `display_height_px` because the
 * Rust serialization is `#[derive(Serialize)]` without a rename_all and
 * the existing model-facing contract uses snake_case.
 */
export interface ComputerActionResult {
  ok: boolean
  output?: string
  error?: string
  display_width_px?: number
  display_height_px?: number
  cursor?: { x: number; y: number }
}

/**
 * Dispatch a single computer action via the renderer-side `desktop.*`
 * client. The caller is responsible for ensuring `ctx.surface` is set —
 * the Rust permission gate uses it to pick the right tier.
 *
 * Errors thrown by `desktop.*` are caught and surfaced inside the result
 * envelope (`ok: false`, `error: <message>`) so the plugin-tool MCP layer
 * can deliver them to the model as a `tool_result` rather than crashing
 * the turn.
 */
export async function dispatchAnthropicAction(
  action: ComputerAction,
  ctx: CallContext
): Promise<ComputerActionResult> {
  try {
    // Screen-off mode ENTER hook (live chat path). When the active character
    // opted in, ensure the bundled virtual display is active + primary before
    // dispatching so capture/clicks stay coordinate-consistent with the
    // monitor off. Strict: a missing driver returns an error to the model
    // rather than letting capture fall through to a black frame.
    if (ctx.screenOffMode) {
      const arm = await desktop.virtualDisplayArm()
      if (arm.status === "unavailable") {
        return { ok: false, error: `screen-off mode unavailable: ${arm.error}` }
      }
    }
    switch (action.action) {
      case "screenshot": {
        const shot = await desktop.screenshot({}, ctx)
        return {
          ok: true,
          output: shot.bytes,
          display_width_px: shot.width,
          display_height_px: shot.height,
        }
      }
      case "left_click":
        return await clickAt(action.coordinate, { button: "left", count: 1 }, ctx)
      case "right_click":
        return await clickAt(action.coordinate, { button: "right", count: 1 }, ctx)
      case "middle_click":
        return await clickAt(action.coordinate, { button: "middle", count: 1 }, ctx)
      case "double_click":
        return await clickAt(action.coordinate, { button: "left", double: true, count: 2 }, ctx)
      case "triple_click":
        return await clickAt(action.coordinate, { button: "left", count: 3 }, ctx)
      case "mouse_move": {
        const [x, y] = action.coordinate
        await desktop.mouseMove({ x, y }, ctx)
        return { ok: true }
      }
      case "left_click_drag": {
        const [fx, fy] = action.start_coordinate
        const [tx, ty] = action.coordinate
        await desktop.drag({ x: fx, y: fy }, { x: tx, y: ty }, { button: "left" }, ctx)
        return { ok: true }
      }
      case "left_mouse_down":
        await desktop.mouseButton("left", "down", ctx)
        return { ok: true }
      case "left_mouse_up":
        await desktop.mouseButton("left", "up", ctx)
        return { ok: true }
      case "scroll": {
        const [x, y] = action.coordinate
        const units = (action.scroll_amount ?? 0) * WHEEL_DELTA_PER_AMOUNT
        const opts: ScrollOpts =
          action.scroll_direction === "up"
            ? { dy: -units }
            : action.scroll_direction === "down"
              ? { dy: units }
              : action.scroll_direction === "left"
                ? { dx: -units }
                : { dx: units }
        const target: ScrollTarget = { kind: "point", x, y }
        await desktop.scroll(target, opts, ctx)
        return { ok: true }
      }
      case "type":
        await desktop.type(action.text, {}, ctx)
        return { ok: true }
      case "key":
        await desktop.keys(keyChord(action.text), ctx)
        return { ok: true }
      case "hold_key": {
        const ms = Math.max(0, Math.round((action.duration ?? 0) * 1000))
        await desktop.holdKey(keyChord(action.text), ms, ctx)
        return { ok: true }
      }
      case "wait": {
        // Implemented renderer-side — no Rust round-trip needed. The
        // setTimeout floor of 4ms isn't a concern because the model would
        // never emit a wait shorter than ~250ms in practice.
        const ms = Math.max(0, Math.round((action.duration ?? 0) * 1000))
        await new Promise((resolve) => setTimeout(resolve, ms))
        return { ok: true }
      }
      case "cursor_position": {
        const point = await desktop.cursorPosition(ctx)
        return {
          ok: true,
          output: JSON.stringify({ x: point.x, y: point.y }),
          cursor: { x: point.x, y: point.y },
        }
      }
      default: {
        // Exhaustiveness check — TypeScript will flag a missing branch here
        // if a new ComputerAction variant is added without a handler.
        const _exhaustive: never = action
        void _exhaustive
        return { ok: false, error: "unknown action" }
      }
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

function clickAt(
  coordinate: [number, number],
  opts: ClickOpts,
  ctx: CallContext
): Promise<ComputerActionResult> {
  const target: ClickTarget = { kind: "point", x: coordinate[0], y: coordinate[1] }
  return desktop.click(target, opts, ctx).then(() => ({ ok: true }))
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === "string") return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

/**
 * Bash tool input shape — mirrors `BashAction` on the Rust side.
 */
export interface BashAction {
  command: string
  restart?: boolean
  timeout?: number
}

export interface BashResult {
  stdout: string
  stderr: string
  exit_code: number
  duration_ms: number
}

/**
 * Text-editor tool input — mirrors `TextEditorAction`. Action variants
 * surface the same fields Anthropic's tool spec lists.
 */
export type TextEditorAction =
  | { action: "view"; path: string }
  | { action: "create"; path: string; file_text: string }
  | {
      action: "str_replace"
      path: string
      old_str: string
      new_str: string
    }
  | { action: "insert"; path: string; insert_line: number; new_str: string }
  | { action: "undo_edit"; path: string }

export interface TextEditorResult {
  ok: boolean
  content?: string
  error?: string
}

/**
 * Re-export `elementRefValue` so callers can extract opaque-ref strings
 * without pulling `types.ts` directly. Kept here so the External-Bridge
 * handler — which uses the same mapper — has a single import source for
 * automation types.
 */
export { elementRefValue }
