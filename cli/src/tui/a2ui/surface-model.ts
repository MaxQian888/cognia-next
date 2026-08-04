import { sanitizeTerminalText } from "../render/terminal-block"
import type { TuiA2UINode, TuiA2UISurface } from "./surface"

export type A2UIRowKind = "display" | "control" | "fallback"

export interface A2UIRow {
  id: string
  component: string
  kind: A2UIRowKind
  text: string
  value?: unknown
  action?: string
  editable?: boolean
  destructive?: boolean
  node: TuiA2UINode
}

const CONTROLS = new Set([
  "Button",
  "TextField",
  "TextArea",
  "Select",
  "Checkbox",
  "Radio",
  "RadioGroup",
  "Toggle",
  "Slider",
  "DatePicker",
  "TimePicker",
  "DateTimePicker",
  "Tabs",
  "Accordion",
])

const LAYOUT = new Set(["Card", "Row", "Column", "List", "Dialog"])
const DISPLAY = new Set([
  "Text",
  "Table",
  "Divider",
  "Spacer",
  "Badge",
  "Alert",
  "Link",
  "Icon",
  "Progress",
  "Image",
  "Chart",
])

function label(node: TuiA2UINode): string {
  for (const field of ["label", "text", "title", "message", "name", "description"]) {
    const value = node[field]
    if (typeof value === "string" && value) return sanitizeTerminalText(value)
  }
  return node.component
}

function atPath(model: Record<string, unknown>, path: string): unknown {
  return path
    .split("/")
    .slice(1)
    .reduce<unknown>((value, token) => {
      if (!value || typeof value !== "object") return undefined
      return (value as Record<string, unknown>)[token.replaceAll("~1", "/").replaceAll("~0", "~")]
    }, model)
}

function resolveValue(value: unknown, model: Record<string, unknown>): unknown {
  return value &&
    typeof value === "object" &&
    typeof (value as { path?: unknown }).path === "string"
    ? atPath(model, (value as { path: string }).path)
    : value
}

function concise(value: unknown): string {
  if (typeof value === "string") return sanitizeTerminalText(value)
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === undefined || value === null) return ""
  try {
    return sanitizeTerminalText(JSON.stringify(value))
  } catch {
    return "[unavailable]"
  }
}

export function isDestructiveA2UIAction(node: { [key: string]: unknown }): boolean {
  return (
    node.variant === "destructive" ||
    (typeof node.action === "string" &&
      /(?:delete|remove|destroy|erase|revoke|reset)/i.test(node.action))
  )
}

function displayText(node: TuiA2UINode, model: Record<string, unknown>): string {
  switch (node.component) {
    case "Divider":
      return typeof node.text === "string" ? `── ${sanitizeTerminalText(node.text)} ──` : "────────"
    case "Spacer":
      return "↕ spacer"
    case "Link":
      return `${label(node)}${typeof node.href === "string" ? ` · ${sanitizeTerminalText(node.href)}` : ""}`
    case "Image":
      return `Image · ${typeof node.alt === "string" ? sanitizeTerminalText(node.alt) : "preview unavailable"} · remote content is not fetched automatically`
    case "Progress": {
      const value = Number(resolveValue(node.value, model) ?? 0)
      const max = Number(node.max ?? 100) || 100
      const filled = Math.max(0, Math.min(10, Math.round((value / max) * 10)))
      return `${label(node)} [${"█".repeat(filled)}${"░".repeat(10 - filled)}] ${Math.round((value / max) * 100)}%`
    }
    case "Table": {
      const columns = Array.isArray(node.columns) ? node.columns : []
      const data = resolveValue(node.data, model)
      const headers = columns.map((column) =>
        column && typeof column === "object"
          ? concise((column as Record<string, unknown>).header)
          : ""
      )
      const rows = Array.isArray(data)
        ? data.map((row) =>
            columns
              .map((column) => {
                const key =
                  column && typeof column === "object"
                    ? (column as Record<string, unknown>).key
                    : undefined
                return typeof key === "string" && row && typeof row === "object"
                  ? concise((row as Record<string, unknown>)[key])
                  : ""
              })
              .join(" │ ")
          )
        : []
      return [label(node), headers.join(" │ "), ...rows].filter(Boolean).join("\n")
    }
    case "Chart": {
      const data = resolveValue(node.data, model)
      const rows = Array.isArray(data)
        ? data.map((point) => {
            if (!point || typeof point !== "object") return concise(point)
            const record = point as Record<string, unknown>
            const name = concise(record.name)
            const value = Number(record.value ?? 0)
            return `${name}: ${"▇".repeat(Math.max(0, Math.min(20, Math.round(Math.abs(value)))))} ${value}`
          })
        : []
      return [`Chart · ${label(node)}`, ...rows, "Accessible data table included above"].join("\n")
    }
    default:
      return `${label(node)}${node.value !== undefined ? ` · ${concise(resolveValue(node.value, model))}` : ""}`
  }
}

function controlText(node: TuiA2UINode, value: unknown): string {
  const name = label(node)
  switch (node.component) {
    case "Button":
      return `[ ${name} ]`
    case "Checkbox":
    case "Toggle":
    case "Radio":
      return `${value ? "☑" : "☐"} ${name}`
    case "Slider":
      return `${name}: ${concise(value)} (${concise(node.min ?? 0)}–${concise(node.max ?? 100)})`
    case "Select":
    case "RadioGroup":
    case "Tabs":
    case "Accordion":
      return `${name}: ${concise(value)} · enter to change`
    default:
      return `${name}: ${concise(value)}█`
  }
}

export function buildA2UIRows(
  surface: TuiA2UISurface,
  localValues: Record<string, unknown>
): A2UIRow[] {
  const rows: A2UIRow[] = []
  const visited = new Set<string>()
  const walk = (id: string) => {
    if (visited.has(id)) return
    visited.add(id)
    const node = surface.components[id]
    if (!node) return
    const local = localValues[id]
    const value =
      local ?? resolveValue(node.value ?? node.checked ?? node.pressed, surface.dataModel)
    if (CONTROLS.has(node.component)) {
      rows.push({
        id,
        component: node.component,
        kind: "control",
        text: controlText(node, value),
        value,
        ...(typeof node.action === "string" ? { action: node.action } : {}),
        ...(["TextField", "TextArea", "DatePicker", "TimePicker", "DateTimePicker"].includes(
          node.component
        )
          ? { editable: true }
          : {}),
        ...(isDestructiveA2UIAction(node) ? { destructive: true } : {}),
        node,
      })
    } else if (DISPLAY.has(node.component) || LAYOUT.has(node.component)) {
      rows.push({
        id,
        component: node.component,
        kind: "display",
        text: displayText(node, surface.dataModel),
        node,
      })
    } else {
      const fallback = [node.fallbackText, node.fallbackContent, node.description].find(
        (item): item is string => typeof item === "string" && item.length > 0
      )
      rows.push({
        id,
        component: node.component,
        kind: "fallback",
        text: `${node.component}: ${sanitizeTerminalText(fallback ?? "No native terminal renderer")} · structured summary available · r raw data`,
        node,
      })
    }
    for (const field of [node.children, node.footer, node.actions]) {
      if (Array.isArray(field))
        for (const child of field) if (typeof child === "string") walk(child)
    }
  }
  walk(surface.rootId)
  return rows
}
