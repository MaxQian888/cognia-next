import { bareToolName, toolIconKeyForName } from "@/lib/chat/tool-summary"
import type { RunActivityCategory, RunActivityTarget } from "@/types/execution/run"
import { hasNoLeakingPiiDeep, redactText } from "@cognia/redact"

const LABEL_LIMIT = 120

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

export function safeStableActivityId(value: string): string {
  if (
    /^[A-Za-z0-9._:-]{1,96}$/.test(value) &&
    !/^\d{7,}$/.test(value) &&
    !value.includes("..") &&
    hasNoLeakingPiiDeep(value)
  ) {
    return value
  }
  let hash = 2_166_136_261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return `opaque-${(hash >>> 0).toString(16).padStart(8, "0")}`
}

export function sanitizeActivityLabel(value: unknown, fallback: string, max = LABEL_LIMIT): string {
  const normalized =
    stringValue(value)
      ?.replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  const fallbackText =
    stringValue(fallback)
      ?.replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim() ?? ""
  const redacted = redactText(normalized || fallbackText).redacted
  const containsRawExecutionText =
    /\bhttps?:\/\/\S+/i.test(redacted) ||
    /(?:`[^`]+`|\$\([^)]*\))/.test(redacted) ||
    /(?:^|\s)(?:curl|wget|git|npm|pnpm|yarn|bash|zsh|sh|python|node)\s/i.test(redacted) ||
    /\b(?:select|insert|update|delete)\b.+\b(?:from|into|set|where)\b/i.test(redacted)
  const safe = containsRawExecutionText ? redactText(fallbackText).redacted : redacted
  return safe.length <= max ? safe : `${safe.slice(0, max - 1)}…`
}

function normalizePathSegments(
  value: string
): { absolute: boolean; segments: string[] } | undefined {
  const normalized = value.trim().replace(/\\/g, "/")
  if (!normalized || normalized.startsWith("~")) return undefined
  const drive = /^[A-Za-z]:\//.exec(normalized)?.[0]
  const absolute = normalized.startsWith("/") || drive !== undefined
  const body = drive ? normalized.slice(drive.length) : normalized.replace(/^\/+/, "")
  const segments: string[] = []
  for (const segment of body.split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return undefined
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return { absolute, segments: drive ? [drive.slice(0, 2).toLowerCase(), ...segments] : segments }
}

function workspaceRelativePath(path: string, workspaceRoot: string): string | undefined {
  const candidate = normalizePathSegments(path)
  const root = normalizePathSegments(workspaceRoot)
  if (!candidate || !root || !root.absolute) return undefined
  if (!candidate.absolute) return candidate.segments.join("/") || undefined
  if (candidate.segments.length <= root.segments.length) return undefined
  const matchesRoot = root.segments.every(
    (segment, index) => candidate.segments[index]?.toLowerCase() === segment.toLowerCase()
  )
  if (!matchesRoot) return undefined
  return candidate.segments.slice(root.segments.length).join("/") || undefined
}

function categoryForTool(toolName: string): RunActivityCategory {
  switch (toolIconKeyForName(toolName)) {
    case "read":
    case "folder":
    case "notebook":
      return "read"
    case "write":
    case "edit":
      return "write"
    case "search":
    case "glob":
    case "web":
      return "search"
    case "terminal":
      return "command"
    case "task":
      return "skill"
    default:
      return "integration"
  }
}

function pathInput(toolName: string, input: Record<string, unknown>): string | undefined {
  switch (bareToolName(toolName).toLowerCase()) {
    case "read":
    case "write":
    case "edit":
    case "multiedit":
      return stringValue(input.file_path)
    case "notebookedit":
      return stringValue(input.notebook_path) ?? stringValue(input.file_path)
    case "ls":
      return stringValue(input.path)
    default:
      return undefined
  }
}

export interface SafeToolActivityMetadata {
  toolName: string
  category: RunActivityCategory
  target?: RunActivityTarget
}

/**
 * Project a tool call into the only metadata allowed to cross the IM boundary.
 * Raw input is inspected only for a path that can be proven workspace-relative.
 */
export function safeToolActivityMetadata(
  rawToolName: string,
  rawInput?: unknown,
  options: { workspaceRoot?: string } = {}
): SafeToolActivityMetadata {
  const toolName = sanitizeActivityLabel(bareToolName(rawToolName), "Tool")
  const metadata: SafeToolActivityMetadata = {
    toolName,
    category: categoryForTool(rawToolName),
  }
  if (
    !options.workspaceRoot ||
    !rawInput ||
    typeof rawInput !== "object" ||
    Array.isArray(rawInput)
  ) {
    return metadata
  }
  const rawPath = pathInput(rawToolName, rawInput as Record<string, unknown>)
  const relative = rawPath ? workspaceRelativePath(rawPath, options.workspaceRoot) : undefined
  return relative ? { ...metadata, target: { kind: "workspace_path", label: relative } } : metadata
}

export function safeActivityTarget(value: unknown): RunActivityTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const kind = row.kind
  const rawLabel = stringValue(row.label)
  if ((kind !== "workspace_path" && kind !== "resource") || !rawLabel) return undefined
  if (kind === "resource" && row.safe !== true) return undefined
  const label = sanitizeActivityLabel(rawLabel, "")
  if (!label) return undefined
  if (kind === "workspace_path") {
    const normalized = label.replace(/\\/g, "/")
    if (
      normalized.startsWith("/") ||
      normalized.startsWith("~") ||
      /^[A-Za-z]:\//.test(normalized) ||
      normalized.split("/").includes("..") ||
      /[?#]/.test(normalized)
    ) {
      return undefined
    }
    return { kind, label: normalized }
  }
  if (label.includes("://") || label.startsWith("/") || label.startsWith("~")) return undefined
  return { kind, label, safe: true }
}
