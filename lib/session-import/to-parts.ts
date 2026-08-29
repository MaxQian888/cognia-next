// Shared builders that turn parsed transcript blocks into the canonical
// `StoredMessage` / `ChatSession` shapes. The emitted parts use ONLY the shapes
// the chat `MessageRenderer` already handles — cross-checked against
// `lib/ai/agent/external/event-to-parts.ts` (text / reasoning / tool-<name> /
// file). Imports are fully resolved (not streaming), so terminal `state` is set
// directly.

import type { UIMessage } from "ai"
import type { ChatSession, StoredMessage } from "@cognia/agent-config-types"

type Part = UIMessage["parts"][number]

/** Text part. */
export function textPart(text: string): Part {
  return { type: "text", text, state: "done" } as unknown as Part
}

/** Reasoning ("thinking") part. */
export function reasoningPart(text: string): Part {
  return { type: "reasoning", text, state: "done" } as unknown as Part
}

/**
 * A fully-resolved tool call part (`tool-<name>`), carrying its input and the
 * result. `isError` flips the render state and routes the output to errorText.
 */
export function toolPart(opts: {
  name: string
  toolCallId: string
  input?: unknown
  output?: unknown
  isError?: boolean
}): Part {
  const hasOutput = opts.output !== undefined
  const state = !hasOutput ? "input-available" : opts.isError ? "output-error" : "output-available"
  return {
    type: `tool-${opts.name}`,
    toolCallId: opts.toolCallId,
    state,
    input: opts.input ?? {},
    ...(hasOutput ? { output: opts.isError ? undefined : opts.output } : {}),
    ...(opts.isError && hasOutput ? { errorText: stringifyResult(opts.output) } : {}),
  } as unknown as Part
}

/** File / image part (data: URL or absolute URL). */
export function filePart(opts: { mediaType: string; url: string; filename?: string }): Part {
  return {
    type: "file",
    mediaType: opts.mediaType,
    url: opts.url,
    ...(opts.filename ? { filename: opts.filename } : {}),
  } as unknown as Part
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}

/**
 * Stable, collision-resistant session id derived from the source + upstream id
 * so re-scanning the same on-disk session upserts (via `bulkPut`) instead of
 * creating a duplicate.
 */
export function importedSessionId(sourceId: string, originalSessionId: string): string {
  return `import:${sourceId}:${originalSessionId}`
}

/** Deterministic per-message id under an imported session. */
export function importedMessageId(sessionId: string, index: number): string {
  return `${sessionId}:m${index}`
}

/** First-line, whitespace-collapsed, truncated title. */
export function deriveTitle(firstUserText: string, fallback: string): string {
  const cleaned = firstUserText.replace(/\s+/g, " ").trim()
  if (!cleaned) return fallback
  return cleaned.length > 80 ? `${cleaned.slice(0, 79)}…` : cleaned
}

/** Assemble one StoredMessage. Skips senderKind for system rows. */
export function buildMessage(opts: {
  id?: string
  sessionId: string
  projectId?: string
  index: number
  role: StoredMessage["role"]
  parts: Part[]
  createdAt: number
  /**
   * Optional metadata attached verbatim (spread-guarded). Imported assistant
   * turns carry `{ usage, model }` here so `deriveImportedUsageRows`
   * (`./usage`) can reconstruct token/cost stats the raw transcripts hold.
   */
  metadata?: StoredMessage["metadata"]
}): StoredMessage {
  return {
    id: opts.id ?? importedMessageId(opts.sessionId, opts.index),
    sessionId: opts.sessionId,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    role: opts.role,
    parts: opts.parts,
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
    createdAt: opts.createdAt,
  }
}

/**
 * Render a plain-text transcript of the imported turns for the branch seed, so
 * continuing an imported session carries its pre-import context into the first
 * send (consumed by `resolveSendOptions`). Tool calls collapse to a one-line
 * marker; images to a placeholder.
 */
export function renderTranscriptSeed(messages: StoredMessage[], maxChars = 12_000): string {
  const blocks: string[] = []
  for (const m of messages) {
    const label = m.role === "user" ? "USER" : m.role === "assistant" ? "ASSISTANT" : "SYSTEM"
    const body = (m.parts as Array<Record<string, unknown>>)
      .map((p) => partToText(p))
      .filter(Boolean)
      .join("\n")
    if (body) blocks.push(`${label}:\n${body}`)
  }
  const joined = blocks.join("\n\n")
  return joined.length > maxChars ? joined.slice(joined.length - maxChars) : joined
}

function partToText(p: Record<string, unknown>): string {
  const type = typeof p.type === "string" ? p.type : ""
  if (type === "text" || type === "reasoning") return typeof p.text === "string" ? p.text : ""
  if (type === "file") return "[file]"
  if (type.startsWith("tool-")) {
    const name = type.slice("tool-".length)
    return `[tool: ${name}]`
  }
  return ""
}

/**
 * Build the imported ChatSession skeleton (continuable via branchSeed).
 *
 * `kind` defaults to `"direct"`; a hidden nested subagent transcript passes
 * `"subagent"`. `suppressSeed` omits the `branchSeed` entirely — read-only
 * nested subagent sessions (ADR-0062) have no continuation path, so they carry
 * no seed and never reach `resolveSendOptions`.
 */
export function buildSession(opts: {
  id: string
  projectId?: string
  title: string
  model?: string
  workingDir?: string
  createdAt: number
  updatedAt: number
  seedMessages: StoredMessage[]
  kind?: ChatSession["kind"]
  suppressSeed?: boolean
}): ChatSession {
  const seed = opts.suppressSeed ? "" : renderTranscriptSeed(opts.seedMessages)
  return {
    id: opts.id,
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    title: opts.title,
    titleAuto: true,
    kind: opts.kind ?? "direct",
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.workingDir ? { workingDir: opts.workingDir } : {}),
    ...(seed
      ? {
          branchKind: "direct" as const,
          branchSeed: { kind: "transcript" as const, content: seed },
        }
      : {}),
    createdAt: opts.createdAt,
    updatedAt: opts.updatedAt,
  } as ChatSession
}
