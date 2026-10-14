import { bareToolName, humanizeToolName, toolIconKeyForName } from "@/lib/chat/tool-summary"
import type {
  RunActivityCategory,
  RunActivitySnapshot,
  RunActivityTarget,
} from "@/types/execution/run"
import { hasNoLeakingPiiDeep, normalizeForRedaction, redactText } from "@cognia/redact"

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

export function safeStepActivityId(id: string): string {
  const prefix = id.startsWith("tool:")
    ? "tool:"
    : id.startsWith("commentary:")
      ? "commentary:"
      : undefined
  return prefix
    ? `${prefix}${safeStableActivityId(id.slice(prefix.length))}`
    : safeStableActivityId(id)
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

export function safeToolActivityLabel(toolName: string): string {
  const name = sanitizeActivityLabel(bareToolName(toolName), "Tool")
  const label = humanizeToolName(name)
  return sanitizeActivityLabel(
    label === "Tool" && name.toLowerCase() !== "tool" ? name : label,
    name
  )
}

/** Known bridge aliases share a request, not a second approval. */
export function activityApprovalRequestId(interruptId: string, runId?: string): string {
  if (interruptId.startsWith("action-review:")) return interruptId.slice("action-review:".length)
  const toolPrefix = runId ? `tool-interrupt:${runId}:` : undefined
  return toolPrefix && interruptId.startsWith(toolPrefix)
    ? interruptId.slice(toolPrefix.length)
    : interruptId
}

/** Fold only approvals whose structured identity identifies one tool unambiguously. */
export function foldToolApprovals(
  activities: readonly RunActivitySnapshot[],
  runId?: string
): RunActivitySnapshot[] {
  const approvals = new Map<string, RunActivitySnapshot>()
  const rows = activities.filter((activity) => activity.kind !== "approval")
  for (const activity of activities) {
    if (activity.kind !== "approval") continue
    const requestId = safeStableActivityId(
      activity.approval?.requestId ??
        activityApprovalRequestId(activity.id.replace(/^approval:/, ""), runId)
    )
    const prior = approvals.get(requestId)
    const status =
      activity.approval?.status ??
      (activity.status === "failed"
        ? "denied"
        : activity.status === "completed"
          ? "approved"
          : "pending")
    // A delayed duplicate request cannot re-open a settled decision.
    const current =
      status === "pending" && prior?.approval?.status !== "pending" && prior ? prior : activity
    approvals.set(requestId, {
      ...prior,
      ...current,
      id: `approval:${requestId}`,
      approval: { requestId, status: current === prior ? prior.approval!.status : status },
      startedAt: Math.min(activity.startedAt, prior?.startedAt ?? activity.startedAt),
      ...(activity.toolName || prior?.toolName
        ? { toolName: activity.toolName ?? prior?.toolName }
        : {}),
    })
  }
  for (const approval of approvals.values()) {
    const requestId = approval.approval!.requestId
    const direct = rows.filter((row) => row.kind === "tool" && row.id === `tool:${requestId}`)
    const matches = approval.toolName
      ? rows.filter(
          (row) =>
            row.kind === "tool" &&
            bareToolName(row.toolName ?? row.label).toLowerCase() ===
              bareToolName(approval.toolName!).toLowerCase()
        )
      : []
    const active = matches.filter(
      (row) =>
        row.startedAt <= approval.startedAt &&
        (row.endedAt === undefined || row.endedAt >= approval.startedAt)
    )
    const tool =
      direct.length === 1
        ? direct[0]
        : active.length === 1
          ? active[0]
          : matches.length === 1
            ? matches[0]
            : undefined
    if (!tool) {
      rows.push(approval)
      continue
    }
    const index = rows.indexOf(tool)
    rows[index] = { ...tool, approval: approval.approval }
  }
  return rows
}

function containsCommentaryExecution(text: string): boolean {
  // Executable names alone occur in ordinary narration. Require shell syntax,
  // a known subcommand, or an executable-specific argument before rejecting it.
  return (
    /\$\(|(?:&&|\|\|)|^\s*\$\s+\S/m.test(text) ||
    /\b(?:curl|wget|git|npm|pnpm|yarn|bash|zsh|sh|python\d?|node|npx|rm|cat|echo|printenv|export|source|cd|ls|sed|awk|grep|rg)\s+(?:-[\w-]|\.{0,2}\/|~\/|\$[\w{]|["'])/i.test(
      text
    ) ||
    /\b(?:git\s+(?:log|diff|show|status|checkout|switch|commit|push|pull|clone|fetch|branch|merge|rebase|restore|reset|clean|stash|add|worktree|config|grep|ls-files|rev-parse|tag)|(?:npm|pnpm|yarn|npx)\s+(?:run|exec|dlx|install|test|build|add|remove|config))\b/i.test(
      text
    ) ||
    /\b(?:node|python\d?|bash|zsh|sh)\s+\S+\.(?:[cm]?[jt]s|py|sh)\b/i.test(text) ||
    /\b(?:curl|wget)\s+(?:(?:[\w-]+\.)+[\w-]+|localhost\b|\[[a-f\d:]+\])/i.test(text) ||
    /\b(?:rm|cat|source|cd|ls|sed|awk|grep|rg)\s+(?:\S*[/.\\*]\S+|README\b|LICENSE\b)/i.test(
      text
    ) ||
    /\b(?:printenv\s+[A-Z_][A-Z\d_]*\b|export\s+[A-Z_][A-Z\d_]*=)/.test(text) ||
    /^\s*(?:(?:sudo|env)\s+)?(?:rm|cat|echo|printenv|export|source|cd|ls|sed|awk|grep|rg)\s+\S/im.test(
      text
    ) ||
    /^\s*(?:node|python\d?|bash|zsh|sh)\s+\S+\s*$/im.test(text) ||
    /^\s*(?:select\b.+\bfrom\b|insert\s+into\b|update\b.+\bset\b|delete\s+from\b)/im.test(text)
  )
}

/**
 * Commentary is public narration, not a tool label. Keep its prose while
 * projecting links to hosts and code spans to text; executable snippets and
 * unresolved secrets still cannot cross the IM boundary.
 */
export function sanitizeActivityCommentary(
  value: unknown,
  fallback: string,
  max = LABEL_LIMIT
): string {
  const projected = normalizeForRedaction(stringValue(value) ?? "").replace(
    /\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi,
    (url) => {
      try {
        return new URL(url).hostname
      } catch {
        return ""
      }
    }
  )
  let unsafe = containsCommentaryExecution(projected.replace(/`+/g, ""))
  const plain = projected
    .replace(/(`+)([\s\S]*?)\1/g, (_match, _ticks: string, code: string) => {
      unsafe ||=
        containsCommentaryExecution(code) ||
        /^\s*(?:curl|wget|git|npm|pnpm|yarn|bash|zsh|sh|python\d?|node|npx)\s+\S/im.test(code)
      return code
    })
    .replace(/`+/g, "")
    .replace(/\s+/g, " ")
    .trim()
  const redacted = redactText(plain).redacted
  unsafe ||=
    /\b(?:[a-z][\w]*_(?:key|token|secret|password)|api[_-]?key|secret|token|password)\s*[:=]\s*["']?(?!<[\w]+_\d+>|\$\{?\w|process\.env\.)[^\s"'<>]/i.test(
      redacted
    ) ||
    /\b[a-z][a-z\d+.-]*:\/\//i.test(redacted) ||
    !hasNoLeakingPiiDeep(redacted)
  if (!redacted || unsafe) return fallback ? sanitizeActivityCommentary(fallback, "", max) : ""
  return redacted.length <= max ? redacted : `${redacted.slice(0, max - 1)}…`
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
