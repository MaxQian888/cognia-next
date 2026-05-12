/**
 * Operator action protocol — unified action vocabulary that all Computer
 * Use backends (browser/Playwright, Windows/UIA, macOS/AX, pure-vision)
 * implement. Plugin authors register a backend via the
 * `native-anthropic-tool` capability (for Anthropic's native protocol)
 * OR via a future `operator-backend` capability (for non-Anthropic
 * runtimes like the ai-sdk path).
 *
 * Based on the union of:
 *   - Anthropic computer_20251124 action space
 *   - Playwright MCP DOM actions
 *   - Windows UIA / macOS AX primitives
 *   - UI-TARS pure-vision action set
 */

export type OperatorActionType =
  | "screenshot"
  | "left_click"
  | "right_click"
  | "middle_click"
  | "double_click"
  | "triple_click"
  | "mouse_move"
  | "left_click_drag"
  | "left_mouse_down"
  | "left_mouse_up"
  | "scroll"
  | "type"
  | "key"
  | "hold_key"
  | "wait"
  | "zoom"

export interface Coordinate {
  x: number
  y: number
}

export interface ScrollAction {
  action: "scroll"
  coordinate: Coordinate
  scroll_direction: "up" | "down" | "left" | "right"
  scroll_amount: number
  /** Modifier keys held during scroll (e.g. ["shift"] for horizontal scroll). */
  text?: string
}

export interface ClickAction {
  action: "left_click" | "right_click" | "middle_click" | "double_click" | "triple_click"
  coordinate: Coordinate
  /** Modifier keys held during click. */
  text?: string
}

export interface MoveAction {
  action: "mouse_move"
  coordinate: Coordinate
}

export interface DragAction {
  action: "left_click_drag"
  start_coordinate: Coordinate
  coordinate: Coordinate
}

export interface MouseButtonAction {
  action: "left_mouse_down" | "left_mouse_up"
  coordinate?: Coordinate
}

export interface TypeAction {
  action: "type"
  text: string
}

export interface KeyAction {
  action: "key"
  text: string
}

export interface HoldKeyAction {
  action: "hold_key"
  text: string
  /** Hold duration in seconds. */
  duration: number
}

export interface WaitAction {
  action: "wait"
  /** Pause duration in seconds. */
  duration: number
}

export interface ScreenshotAction {
  action: "screenshot"
}

export interface ZoomAction {
  action: "zoom"
  /** [x1, y1, x2, y2] — top-left and bottom-right of the region to inspect. */
  region: [number, number, number, number]
}

export type OperatorAction =
  | ScreenshotAction
  | ClickAction
  | MoveAction
  | DragAction
  | MouseButtonAction
  | ScrollAction
  | TypeAction
  | KeyAction
  | HoldKeyAction
  | WaitAction
  | ZoomAction

export interface OperatorActionResult {
  /** True if the action completed successfully. */
  ok: boolean
  /** For screenshot/zoom: base64-encoded PNG. For other actions: optional confirmation message. */
  output?: string
  /** Error message when ok === false. */
  error?: string
  /** Source dimensions reported by the backend (used for coordinate scaling — see coordinates.ts). */
  display_width_px?: number
  display_height_px?: number
}
