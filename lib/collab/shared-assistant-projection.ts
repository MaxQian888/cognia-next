/**
 * The shareable form of a shared run's assistant messages (ADR-0241).
 *
 * One projector per run: the stored corrections and, later, the live frames
 * read the same output, so members never see two versions of what a reply
 * held. The projection keeps:
 *
 * - **Text, redacted as a whole message.** Every text part is joined in order
 *   before redaction, so a secret split across two parts is still caught.
 *   While the reply streams, only the redacted text up to
 *   {@link SHARED_STREAMING_WINDOW} characters before the end is released: any
 *   bounded secret that crosses that cut was already complete in the full text
 *   and so redacted. Secrets with no length bound (private keys, JWTs, URL
 *   credentials) are held from their opener while the redactor has not matched
 *   them, and still held at settle if it never does.
 * - **Tools, by tier.** `summary` (the default) shares the tool's name, the
 *   workspace-relative paths it touched, diff stats and a fetched URL's
 *   origin. `full` (a session owner's opt-in) adds the inputs each card reads,
 *   per tool, redacted and capped. MCP and plugin tools never share inputs, and
 *   a tool's input is shared only once its arguments are complete.
 * - Nothing else: reasoning, files, sources and data parts stay with the
 *   executor (files cross through FileSpace grants, ADR-0222).
 *
 * Every projected part passes the PII gate on its own; one that fails becomes
 * a withheld placeholder instead of failing the message. Callers count the
 * placeholders in the output (`isSharedWithheldPart`) to say so.
 *
 * Unchanged source parts project to the same objects, so a frame encoder that
 * diffs by identity sends only what changed. Tool parts are memoised by
 * identity: the chat adapter replaces a part when it changes, never mutates it.
 */

import {
  hasNoLeakingPiiDeep,
  normalizeForRedaction,
  PII_PLACEHOLDER_SOURCE,
  redactText,
  translateOffsetsThroughRedaction,
  type RedactionRecord,
} from "@cognia/redact"
import { normalizeProjectPaths } from "@cognia/memory/extract/project-path-normalize"
import { safeToolActivityMetadata, workspaceRelativePath } from "@/lib/execution/run-activity"
import { bareToolName } from "@/lib/chat/tool-summary"
import { shellCommandOf } from "@/lib/chat/shell-command"
import { extractEditInput } from "@/lib/connectors/activity/diff-producer"
import { parseUnifiedPatch, patchFilePath } from "@/lib/git/unified-patch"
import { redactCredentialText, redactCredentialUrl } from "@/lib/security/redact-credentials"
import type { SharedToolDetail } from "@cognia/agent-config-types"
import { sharedWithheldPart } from "./shared-withheld-part"

/** Characters of a streaming reply's tail held back until more text follows. */
export const SHARED_STREAMING_WINDOW = 256

/**
 * Openers of secrets the redactor matches only once complete and that have no
 * length bound, so the window cannot cover them: a private-key header, a JWT
 * header, a URL whose authority carries `user:` (a port is not a credential).
 * Searched in REDACTED text, where a matched secret is already a placeholder.
 */
const UNBOUNDED_SECRET_OPENER = new RegExp(
  [
    String.raw`-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----`,
    String.raw`\beyJ[A-Za-z0-9_-]{4,}`,
    // A port is not a credential, nor is a password the redactor already took.
    String.raw`\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:?#]+:(?!\d{1,5}(?:[/?#\s]|$)|${PII_PLACEHOLDER_SOURCE})`,
  ].join("|"),
  "i"
)

const CAPS = {
  command: 2_048,
  edit: 16_384,
  patch: 65_536,
  short: 512,
  todo: 500,
} as const

/** Tool states in which a call's arguments are complete. */
const INPUT_COMPLETE_STATES = new Set([
  "input-available",
  "approval-requested",
  "approval-responded",
  "output-available",
  "output-error",
  "output-denied",
])

/** The diff a summary tool card shows in place of its body. */
export interface SharedDiffStats {
  added: number
  removed: number
  files?: number
}

export interface SharedAssistantProjectorOptions {
  tier?: SharedToolDetail
  /** The executor's workspace root: paths outside it are never shared. */
  workspaceRoot?: string
}

export type SharedProjectionPhase = "streaming" | "settled"

type Part = Record<string, unknown>

function isTextPart(part: Part): part is Part & { type: "text"; text: string } {
  return part.type === "text" && typeof part.text === "string"
}

function isToolPart(part: Part): boolean {
  return (
    typeof part.type === "string" && (part.type.startsWith("tool-") || part.type === "dynamic-tool")
  )
}

function capped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Redacted free text, or `undefined` when nothing remains. */
function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  return capped(redactText(redactCredentialText(normalizeForRedaction(value))).redacted, max)
}

/**
 * Free text that may quote paths: paths under the workspace become relative,
 * and the field is dropped when a path naming a person survives.
 */
function safePathText(value: unknown, max: number, workspaceRoot?: string): string | undefined {
  const text = safeText(value, max)
  if (!text) return undefined
  const normalized = normalizeProjectPaths(text, { roots: workspaceRoot ? [workspaceRoot] : [] })
  return normalized.ok ? normalized.text : undefined
}

/**
 * A path as the workspace sees it. Without a known root only an already
 * relative path is shared: an absolute one could name anything on the host.
 */
function relativePath(value: unknown, workspaceRoot?: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined
  if (!workspaceRoot && /^(?:[/\\~]|[A-Za-z]:)/.test(value.trim())) return undefined
  const relative = workspaceRelativePath(value, workspaceRoot ?? "/")
  return relative ? safeText(relative, CAPS.short) : undefined
}

function fileOf(input: Part): unknown {
  return input.file_path ?? input.filePath ?? input.notebook_path ?? input.path
}

function urlOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value)
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined
  } catch {
    return undefined
  }
}

function patchSummary(
  patch: unknown,
  workspaceRoot?: string
): { stats: SharedDiffStats; paths: string[] } | undefined {
  if (typeof patch !== "string" || !patch.trim()) return undefined
  const files = parseUnifiedPatch(patch)
  if (files.length === 0) return undefined
  const stats: SharedDiffStats = { added: 0, removed: 0, files: files.length }
  const paths: string[] = []
  for (const file of files) {
    stats.added += file.added
    stats.removed += file.removed
    const path = patchFilePath(file)
    const shared = path ? relativePath(path, workspaceRoot) : undefined
    if (shared) paths.push(shared)
  }
  return { stats, paths }
}

/** The input a summary card reads: what was touched and how much, never what was said. */
function summaryInput(tool: string, input: Part, workspaceRoot?: string): Part {
  if (tool === "apply_patch") {
    const summary = patchSummary(input.patch, workspaceRoot)
    return summary
      ? {
          sharedDiffStats: summary.stats,
          ...(summary.paths.length ? { paths: summary.paths } : {}),
        }
      : {}
  }
  if (tool === "webfetch" || tool === "web_fetch") {
    const origin = urlOrigin(input.url)
    return origin ? { url: origin } : {}
  }
  const path = relativePath(fileOf(input), workspaceRoot)
  const edit = extractEditInput(tool, input)
  return {
    ...(path ? { file_path: path } : {}),
    ...(edit.kind && path
      ? { sharedDiffStats: { added: edit.stats.added, removed: edit.stats.removed } }
      : {}),
  }
}

/** The inputs a full card reads, per tool; anything not listed is dropped. */
function fullInput(rawName: string, tool: string, input: Part, workspaceRoot?: string): Part {
  const command = shellCommandOf(tool, input) ?? shellCommandOf(rawName, input)
  if (command !== undefined) {
    const shared = safePathText(command, CAPS.command, workspaceRoot)
    const description = safeText(input.description, CAPS.short)
    return { ...(shared ? { command: shared } : {}), ...(description ? { description } : {}) }
  }
  const summary = summaryInput(tool, input, workspaceRoot)
  switch (tool) {
    case "edit":
    case "str_replace":
    case "replace": {
      if (!summary.file_path) return summary
      const oldString = safePathText(input.old_string ?? input.oldString, CAPS.edit, workspaceRoot)
      const newString = safePathText(input.new_string ?? input.newString, CAPS.edit, workspaceRoot)
      return {
        ...summary,
        ...(oldString !== undefined ? { old_string: oldString } : {}),
        ...(newString !== undefined ? { new_string: newString } : {}),
        ...(typeof input.replace_all === "boolean" ? { replace_all: input.replace_all } : {}),
      }
    }
    case "multiedit":
    case "multi_edit": {
      if (!summary.file_path || !Array.isArray(input.edits)) return summary
      const edits = input.edits.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return []
        const edit = raw as Part
        const oldString = safePathText(edit.old_string ?? edit.oldString, CAPS.edit, workspaceRoot)
        const newString = safePathText(edit.new_string ?? edit.newString, CAPS.edit, workspaceRoot)
        return oldString === undefined && newString === undefined
          ? []
          : [{ old_string: oldString ?? "", new_string: newString ?? "" }]
      })
      return edits.length ? { ...summary, edits } : summary
    }
    case "apply_patch": {
      if (typeof input.patch !== "string") return summary
      // Rebuilt from the files inside the workspace only: a file the agent
      // patched elsewhere crosses neither its path nor its content.
      const inside = parseUnifiedPatch(input.patch).filter((file) =>
        [file.oldPath, file.newPath].every(
          (path) => path === null || relativePath(path, workspaceRoot) !== undefined
        )
      )
      const patch = safePathText(
        inside.flatMap((file) => file.hunks.map((hunk) => hunk.patch)).join(""),
        CAPS.patch,
        workspaceRoot
      )
      return patch ? { ...summary, patch } : summary
    }
    case "grep":
    case "glob":
    case "find": {
      const pattern = safePathText(input.pattern, CAPS.short, workspaceRoot)
      const path = relativePath(input.path, workspaceRoot)
      return { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) }
    }
    case "webfetch":
    case "web_fetch": {
      const url =
        typeof input.url === "string" && urlOrigin(input.url)
          ? safeText(redactCredentialUrl(input.url), CAPS.short)
          : undefined
      return url ? { url } : {}
    }
    case "websearch":
    case "web_search": {
      const query = safeText(input.query, CAPS.short)
      return query ? { query } : {}
    }
    case "todowrite": {
      if (!Array.isArray(input.todos)) return {}
      const todos = input.todos.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return []
        const todo = raw as Part
        const content = safeText(todo.content, CAPS.todo)
        if (!content) return []
        const activeForm = safeText(todo.activeForm, CAPS.todo)
        return [
          {
            content,
            ...(typeof todo.status === "string" ? { status: todo.status } : {}),
            ...(activeForm ? { activeForm } : {}),
          },
        ]
      })
      return todos.length ? { todos } : {}
    }
    default:
      return summary
  }
}

function sharedOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined
  return redactText(
    JSON.stringify(output, (key, value) =>
      /password|secret|token|authorization|api[-_]?key|credential/i.test(key) ? "[REDACTED]" : value
    )
  ).redacted
}

function projectTool(
  part: Part,
  options: Required<Pick<SharedAssistantProjectorOptions, "tier">> & SharedAssistantProjectorOptions
): Part {
  const type = part.type as string
  const rawName = String(part.toolName ?? type.replace(/^tool-/, ""))
  const metadata = safeToolActivityMetadata(rawName, part.input)
  const tool = bareToolName(rawName).toLowerCase()
  // MCP and plugin tools have no card contract to project against.
  const mcp = /^mcp__/.test(rawName) && !rawName.startsWith("mcp__cognia-tools__")
  const complete = typeof part.state === "string" && INPUT_COMPLETE_STATES.has(part.state)
  const input =
    part.input && typeof part.input === "object" && !Array.isArray(part.input) && complete && !mcp
      ? options.tier === "full"
        ? fullInput(rawName, tool, part.input as Part, options.workspaceRoot)
        : summaryInput(tool, part.input as Part, options.workspaceRoot)
      : {}
  const output = sharedOutput(part.output)
  return {
    type: "dynamic-tool",
    toolName: metadata.toolName,
    toolCallId: String(part.toolCallId ?? ""),
    state: part.state,
    input,
    ...(output !== undefined ? { output } : {}),
    ...(typeof part.errorText === "string"
      ? { errorText: redactText(part.errorText).redacted }
      : {}),
  }
}

/**
 * An offset in the original text moved into redacted space, snapped to either
 * edge of the placeholder it falls inside (the same offset twice when it falls
 * in plain text).
 */
function toRedacted(
  offset: number,
  redacted: string,
  map: Record<string, RedactionRecord>
): { down: number; up: number } {
  const [snapped] = translateOffsetsThroughRedaction(
    [{ charStart: offset, charEnd: offset }],
    redacted,
    map,
    { snap: true }
  )
  return { down: snapped!.charStart, up: snapped!.charEnd }
}

interface TextState {
  key: string
  parts: Part[]
}

export interface SharedAssistantProjector {
  /** The shareable parts of one assistant message. */
  project(messageId: string, parts: unknown[], phase: SharedProjectionPhase): unknown[]
}

export function createSharedAssistantProjector(
  options: SharedAssistantProjectorOptions = {}
): SharedAssistantProjector {
  const resolved = { tier: options.tier ?? "summary", ...options }
  const tools = new WeakMap<object, Part>()
  const texts = new Map<string, TextState>()

  const gate = (part: Part): Part =>
    hasNoLeakingPiiDeep(part) ? part : (sharedWithheldPart("pii") as unknown as Part)

  const toolPart = (part: Part): Part => {
    const cached = tools.get(part)
    if (cached) return cached
    const projected = gate(projectTool(part, resolved))
    tools.set(part, projected)
    return projected
  }

  /** Released text per source text part, plus whether the rest is withheld. */
  const releaseText = (
    sources: string[],
    phase: SharedProjectionPhase
  ): { texts: string[]; withheld: boolean } => {
    const joined = sources.join("")
    const { redacted, map } = redactText(joined)
    let end = redacted.length
    if (phase === "streaming") {
      const cut = joined.length - SHARED_STREAMING_WINDOW
      end = cut <= 0 ? 0 : toRedacted(cut, redacted, map).down
    }
    const opener = UNBOUNDED_SECRET_OPENER.exec(redacted)
    const withheld = opener !== null && opener.index < (phase === "settled" ? redacted.length : end)
    if (opener && opener.index < end) end = opener.index
    // A placeholder that spans two parts goes whole to the first.
    let origin = 0
    const bounds = [0]
    for (const text of sources) {
      origin += text.length
      bounds.push(toRedacted(origin, redacted, map).up)
    }
    return {
      texts: sources.map((_, index) => {
        const start = bounds[index]!
        return start >= end ? "" : redacted.slice(start, Math.min(bounds[index + 1]!, end))
      }),
      withheld,
    }
  }

  return {
    project(messageId, rawParts, phase) {
      const parts = rawParts.filter(
        (raw): raw is Part => !!raw && typeof raw === "object" && !Array.isArray(raw)
      )
      // Normalized first: an escape sequence or control character spliced
      // into a secret hides it from `redactText` (it keeps its input intact
      // outside placeholders), and a window cut would then release the
      // secret's prefix. The gate already scans the normalized view.
      const sources = parts.filter(isTextPart).map((part) => normalizeForRedaction(part.text))
      const key = `${phase}\u0000${JSON.stringify(sources)}`
      const previous = texts.get(messageId)
      let projectedTexts: Part[]
      if (previous?.key === key) {
        projectedTexts = previous.parts
      } else {
        const released = releaseText(sources, phase)
        projectedTexts = released.texts.map((text, index) => {
          const prior = previous?.parts[index]
          return prior && prior.text === text ? prior : gate({ type: "text", text })
        })
        if (released.withheld) projectedTexts.push(sharedWithheldPart("pii") as unknown as Part)
        texts.set(messageId, { key, parts: projectedTexts })
      }

      const out: Part[] = []
      let textIndex = 0
      for (const part of parts) {
        if (isTextPart(part)) {
          const projected = projectedTexts[textIndex++]
          if (projected && !(projected.type === "text" && projected.text === ""))
            out.push(projected)
          // A held span ends what this message may show of its text.
          if (textIndex === sources.length && projectedTexts.length > sources.length)
            out.push(projectedTexts[sources.length]!)
        } else if (isToolPart(part)) {
          out.push(toolPart(part))
        }
      }
      return out
    },
  }
}
