/**
 * Route a user's gesture on a chat-rendered A2UI surface back to the agent.
 *
 * IM callbacks already start a turn (`connector-callback-handler.ts`) and the
 * TUI sends `formatActionForAI` to its agent, but a button in desktop/web chat
 * stopped at the global emitter: nothing turned it into the next message. This
 * module closes that path with three rules (ADR-0240):
 *
 * - Only surfaces a transcript row bound to a session route
 *   (`bindA2UISurfaceToChat`). Mini Apps, the workspace editor, previews and
 *   template galleries are never bound, so their actions stay local.
 * - Only deliberate gestures route: Button clicks, FormGroup submits and Link
 *   actions. Tables, charts, pagination, tabs and every data change stay in
 *   the surface; the agent sees their state in the data snapshot of the next
 *   gesture instead.
 * - The built-in mini-app handlers keep their action names
 *   (`A2UI_LOCAL_ACTION_NAMES`); those are handled in place and never reach
 *   this router. Everything they do not own falls through to it.
 *
 * The message is an ordinary user message sent through the chat's own `send`,
 * so a running turn steers or queues it exactly as typed text would.
 */

import type { A2UISurfaceState, A2UIUserAction } from "@/types/a2ui/schema"

export interface A2UIChatSurfaceBinding {
  sessionId: string
  messageId?: string
}

interface BindingEntry {
  binding: A2UIChatSurfaceBinding
  token: symbol
}

/** Live render sites per surface, oldest first; the newest one owns the clicks. */
const bindings = new Map<string, BindingEntry[]>()

/**
 * Bind a surface to the session whose transcript renders it. Returns the
 * unbind. A surface id rendered by several sites at once (a remount, or a
 * model reusing an id across sessions or a fork) routes to the newest live
 * site; releasing it falls back to the previous one, never to a released one.
 */
export function bindA2UISurfaceToChat(
  surfaceId: string,
  binding: A2UIChatSurfaceBinding
): () => void {
  const token = Symbol(surfaceId)
  const entries = bindings.get(surfaceId) ?? []
  entries.push({ binding, token })
  bindings.set(surfaceId, entries)
  return () => {
    const current = bindings.get(surfaceId)
    if (!current) return
    const remaining = current.filter((entry) => entry.token !== token)
    if (remaining.length > 0) bindings.set(surfaceId, remaining)
    else bindings.delete(surfaceId)
  }
}

export function getA2UIChatBinding(surfaceId: string): A2UIChatSurfaceBinding | undefined {
  return bindings.get(surfaceId)?.at(-1)?.binding
}

/** Component types whose actions are a user's deliberate request to the agent. */
export const AGENT_ROUTED_COMPONENT_TYPES: ReadonlySet<string> = new Set([
  "Button",
  "FormGroup",
  "Link",
])

/**
 * Action names the built-in mini-app handlers own (`hooks/a2ui/app-builder/
 * action-handlers.ts`). A surface that uses one gets the built-in behavior in
 * place; the model is told to pick its own names for actions it wants back.
 * `action-handlers.test.ts` pins this list against the handler's switch.
 */
export const A2UI_LOCAL_ACTION_NAMES: readonly string[] = [
  "add_task",
  "toggle_task",
  "delete_task",
  "filter_all",
  "filter_pending",
  "filter_done",
  "input_decimal",
  "op_add",
  "op_sub",
  "op_mul",
  "op_div",
  "op_subtract",
  "op_multiply",
  "op_divide",
  "op_percent",
  "negate",
  "calculate",
  "clear",
  "backspace",
  "delete",
  "start",
  "start_timer",
  "pause",
  "pause_timer",
  "reset",
  "reset_timer",
  "save_note",
  "select_note",
  "delete_note",
  "convert",
  "add_item",
  "toggle_item",
  "clear_list",
  "add_habit",
  "toggle_habit",
  "add_expense",
  "view_expense",
  "delete_expense",
  "clear_form",
  "calculate_bmi",
  "calculate_age",
  "calculate_loan",
  "add_steps",
  // Keypad, timer-preset and tracker buttons carry their value in the name.
  ...Array.from({ length: 10 }, (_, digit) => `input_${digit}`),
  ...Array.from({ length: 10 }, (_, digit) => `num_${digit}`),
  ...["1", "1min", "5", "5min", "10", "10min", "15", "25", "25min"].map(
    (preset) => `set_${preset}`
  ),
  "add_water_1",
  "add_water_2",
  "add_water_3",
]

/** A second identical gesture inside this window is a double click, not a new request. */
export const A2UI_ACTION_DEDUPE_MS = 1500

/** Longest label an action's message leads with. */
export const A2UI_ACTION_LABEL_LIMIT = 200

/** Cap on each serialized object (action data, data model) sent with an action. */
export const A2UI_ACTION_DATA_LIMIT = 8000

export type A2UIChatRouteResult = "sent" | "unbound" | "not-routable" | "duplicate" | "failed"

export interface A2UIChatActionRouterDeps {
  getSurface: (surfaceId: string) => A2UISurfaceState | undefined
  /** The chat send bridge; false when no chat runtime could take the message. */
  send: (sessionId: string, text: string) => boolean
  now?: () => number
}

/** Build the router the built-in actions provider installs as its fall-through. */
export function createA2UIChatActionRouter(deps: A2UIChatActionRouterDeps) {
  const lastSent = new Map<string, number>()
  const now = deps.now ?? Date.now

  return (action: A2UIUserAction): A2UIChatRouteResult => {
    const binding = getA2UIChatBinding(action.surfaceId)
    if (!binding) return "unbound"
    const surface = deps.getSurface(action.surfaceId)
    const componentType = surface?.components[action.componentId]?.component
    if (!surface || !componentType || !AGENT_ROUTED_COMPONENT_TYPES.has(componentType)) {
      return "not-routable"
    }
    // A connector callback replayed into the store is the IM path's turn, not ours.
    if (action.data?.source === "connector") return "not-routable"

    const key = `${binding.sessionId}\u0000${action.surfaceId}\u0000${action.componentId}\u0000${action.action}`
    const at = now()
    const previous = lastSent.get(key)
    if (previous !== undefined && at - previous < A2UI_ACTION_DEDUPE_MS) return "duplicate"

    const text = formatA2UIActionForAgent(action, surface, componentType)
    if (!deps.send(binding.sessionId, text)) return "failed"
    lastSent.set(key, at)
    return "sent"
  }
}

/**
 * The user message an action becomes: the control's own label first, so the
 * transcript reads like what the user did, then a fenced, machine-readable
 * record of the action and the surface's current data.
 */
export function formatA2UIActionForAgent(
  action: A2UIUserAction,
  surface: A2UISurfaceState,
  componentType: string
): string {
  const text = typeof action.data?.text === "string" ? action.data.text.trim() : ""
  const label = (text || action.action).slice(0, A2UI_ACTION_LABEL_LIMIT)

  const record: Record<string, unknown> = {
    surfaceId: action.surfaceId,
    ...(surface.title ? { surfaceTitle: surface.title } : {}),
    componentId: action.componentId,
    componentType,
    action: action.action,
  }
  // A form submit's data is its values, which can be the whole model; both
  // are capped the same way.
  const data = withoutKeys(action.data, ["text"])
  if (data) record.data = capped(data)
  if (Object.keys(surface.dataModel ?? {}).length > 0) record.dataModel = capped(surface.dataModel)

  return `${label}\n\n\`\`\`a2ui-action\n${JSON.stringify(record, null, 2)}\n\`\`\``
}

function capped(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value) ?? ""
  return json.length <= A2UI_ACTION_DATA_LIMIT ? value : { truncated: true, bytes: json.length }
}

function withoutKeys(
  data: Record<string, unknown> | undefined,
  keys: string[]
): Record<string, unknown> | undefined {
  if (!data) return undefined
  const entries = Object.entries(data).filter(([key]) => !keys.includes(key))
  return entries.length ? Object.fromEntries(entries) : undefined
}

export function __resetA2UIChatBindingsForTesting(): void {
  bindings.clear()
}
