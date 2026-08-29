/**
 * Pi session-history source (ADR-0119, ADR-0062).
 *
 * Reads `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`. The wire
 * format is taken from the `docs/session-format.md` that ships inside
 * `@earendil-works/pi-coding-agent`, so the entry names below are
 * authoritative rather than inferred from one sample file.
 *
 * Three properties of Pi's format shape this adapter:
 *
 *   - **It is a tree, not a list.** `/fork`, `/clone` and `/tree` branch in
 *     place. The active leaf becomes the main conversation; every other leaf
 *     imports as a nested conversation so abandoned branches are not silently
 *     dropped (see `pi-tree.ts`).
 *   - **Three format versions exist.** v1 is a linear legacy sequence, v2
 *     introduced the tree, v3 renamed the `hookMessage` role to `custom`. Pi
 *     migrates old files on load; because Cognia reads them directly it must
 *     accept all three rather than only the current one.
 *   - **`custom` entries never reach the LLM.** They are extension state, and
 *     Pi's own context builder excludes them. They are recorded as a loss
 *     entry rather than rendered, so the report stays honest without inventing
 *     turns the model never saw.
 */

import type { ImportedConversation } from "@/lib/data/importers/types"
import type { UIMessage } from "ai"
import type { StoredMessage } from "@cognia/agent-config-types"
import { joinPath } from "@/lib/claude/instructions/paths"

type Part = UIMessage["parts"][number]

import {
  buildMessage,
  buildSession,
  deriveTitle,
  filePart,
  importedSessionId,
  reasoningPart,
  textPart,
  toolPart,
} from "../to-parts"
import { scanFileSummaries } from "../scan"
import { buildImportedSessionGraph } from "../graph"
import { importedUsageMetadata } from "../usage"
import type {
  AgentSessionSourceAdapter,
  PickedSessionFile,
  SessionDetectVerdict,
  SessionRef,
  SessionScanInput,
  SessionSummary,
} from "../types"
import { piActiveChain, piAlternateLeafIds, piChainToLeaf } from "./pi-tree"
import { piCodec } from "../codecs/pi-codec"

export const PI_SOURCE_ID = "pi"

/** Format versions this adapter knows how to read. */
const SUPPORTED_SESSION_VERSIONS = new Set([1, 2, 3])

/**
 * Normalize Pi's on-disk token counts into the canonical `UsageInfo` shape.
 *
 * Pi writes `{ input, output, reasoning, cacheRead, cacheWrite, costUsd }`;
 * `deriveImportedUsageRows` reads `inputTokens` / `outputTokens` /
 * `cacheReadInputTokens` / `cacheCreationInputTokens` / `totalCostUsd`. Passing
 * the raw blob straight through — as this adapter used to, alone among the
 * seven — produced a usage row per assistant turn whose every figure was ZERO,
 * while `hasImportedUsage` still reported "yes". The Insights sheet therefore
 * showed Pi sessions an imported-spend section full of zeros: a wrong number,
 * which is worse than no number.
 *
 * Reasoning tokens are folded into output, matching `opencodeUsageMeta` and the
 * live adapters (they are billed as output).
 */
function piUsageMetadata(message: PiMessage): { metadata: StoredMessage["metadata"] } | null {
  const raw = message.usage
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = raw?.[key]
      if (typeof value === "number" && Number.isFinite(value)) return value
    }
    return 0
  }
  const hasUsage = !!raw && typeof raw === "object" && Object.keys(raw).length > 0
  if (!hasUsage && !message.model) return null
  if (!hasUsage) return { metadata: { model: message.model } }

  const cost = num("costUsd", "totalCostUsd", "cost")
  return {
    metadata: importedUsageMetadata(
      {
        inputTokens: num("input", "inputTokens", "promptTokens"),
        outputTokens: num("output", "outputTokens", "completionTokens") + num("reasoning"),
        cacheReadInputTokens: num("cacheRead", "cacheReadInputTokens"),
        cacheCreationInputTokens: num("cacheWrite", "cacheCreationInputTokens"),
        ...(cost > 0 ? { totalCostUsd: cost } : {}),
      },
      message.model
    ),
  }
}

// ============================================================================
// Wire types (docs/session-format.md, Pi 0.84.1)
// ============================================================================

interface PiHeader {
  type: "session"
  version?: number
  id?: string
  timestamp?: string
  cwd?: string
  /** Absolute path of the session this one was forked/cloned from. */
  parentSession?: string
}

interface PiContentBlock {
  type?: string
  text?: string
  thinking?: string
  data?: string
  mimeType?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}

interface PiMessage {
  role?: string
  content?: string | PiContentBlock[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
  provider?: string
  model?: string
  usage?: Record<string, unknown>
  command?: string
  output?: string
}

interface PiEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string
  message?: PiMessage
  provider?: string
  modelId?: string
  thinkingLevel?: string
  summary?: string
  customType?: string
  content?: string | PiContentBlock[]
  name?: string
}

// ============================================================================
// Parsing
// ============================================================================

interface ParsedFile {
  header: PiHeader | null
  entries: PiEntry[]
  /** Entry types that carry meaning Cognia cannot represent. */
  unrepresented: Map<string, number>
  corruptLines: number
}

/**
 * Parse a Pi JSONL file, skipping unparseable lines rather than failing.
 *
 * A single truncated line — common when Pi is killed mid-write — must not cost
 * the user the rest of the transcript.
 */
export function parsePiSessionFile(content: string): ParsedFile {
  const entries: PiEntry[] = []
  const unrepresented = new Map<string, number>()
  let header: PiHeader | null = null
  let corruptLines = 0

  for (const line of content.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      corruptLines++
      continue
    }
    // Arrays are `typeof "object"` too, so they need an explicit reject —
    // otherwise one would flow on as an entry with no `type` and be counted
    // as an unknown entry rather than as the malformed line it is.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      corruptLines++
      continue
    }
    const entry = parsed as PiEntry
    if (entry.type === "session") {
      header = parsed as PiHeader
      continue
    }
    entries.push(entry)
  }

  return { header, entries, unrepresented, corruptLines }
}

/** Is this a Pi session file we can read? */
function isSupported(header: PiHeader | null): boolean {
  if (!header) return false
  // A missing version predates the field; those files are v1-shaped.
  const version = header.version ?? 1
  return SUPPORTED_SESSION_VERSIONS.has(version)
}

function contentBlocks(content: string | PiContentBlock[] | undefined): PiContentBlock[] {
  if (!content) return []
  if (typeof content === "string") return [{ type: "text", text: content }]
  return Array.isArray(content) ? content : []
}

function blocksToParts(blocks: PiContentBlock[]): Part[] {
  const parts: Part[] = []
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text) parts.push(textPart(block.text))
        break
      case "thinking":
        if (block.thinking) parts.push(reasoningPart(block.thinking))
        break
      case "image":
        if (block.data) {
          parts.push({
            ...filePart({
              mediaType: block.mimeType ?? "image/png",
              url: `data:${block.mimeType ?? "image/png"};base64,${block.data}`,
            }),
          })
        }
        break
      case "toolCall":
        if (block.id) {
          parts.push(
            toolPart({
              name: block.name ?? "unknown",
              toolCallId: block.id,
              input: block.arguments ?? {},
            })
          )
        }
        break
      default:
        break
    }
  }
  return parts
}

function plainText(parts: Part[]): string {
  return parts
    .map((part) =>
      (part as { type?: string; text?: string }).type === "text"
        ? ((part as { text?: string }).text ?? "")
        : ""
    )
    .join("")
}

interface BuiltTurns {
  messages: StoredMessage[]
  firstUserText: string
  model?: string
  lossy: Map<string, number>
}

/**
 * Convert one root→leaf entry chain into canonical messages.
 *
 * Tool results are folded back onto the assistant turn that called them, so a
 * transcript renders as one assistant message with resolved tool parts rather
 * than an assistant turn followed by orphan "tool" rows.
 */
function buildTurns(chain: PiEntry[], sessionId: string, projectId?: string): BuiltTurns {
  const messages: StoredMessage[] = []
  const lossy = new Map<string, number>()
  let firstUserText = ""
  let model: string | undefined
  let index = 0

  /** toolCallId → the message index holding its call part. */
  const toolOwner = new Map<string, number>()

  const note = (kind: string) => lossy.set(kind, (lossy.get(kind) ?? 0) + 1)

  for (const entry of chain) {
    const createdAt = Date.parse(entry.timestamp ?? "") || Date.now()

    switch (entry.type) {
      case "message": {
        const message = entry.message ?? {}
        const role = message.role

        if (role === "toolResult") {
          // Attach to the assistant turn that issued the call.
          const ownerIndex = message.toolCallId ? toolOwner.get(message.toolCallId) : undefined
          const owner = ownerIndex !== undefined ? messages[ownerIndex] : undefined
          const output = plainText(blocksToParts(contentBlocks(message.content)))
          if (owner) {
            owner.parts = owner.parts.map((part) => {
              const candidate = part as { toolCallId?: string }
              if (candidate.toolCallId !== message.toolCallId) return part
              return toolPart({
                name: message.toolName ?? "unknown",
                toolCallId: message.toolCallId!,
                input: (part as { input?: unknown }).input,
                output,
                isError: message.isError === true,
              })
            })
          } else {
            // No matching call — keep the output rather than dropping it.
            messages.push(
              buildMessage({
                sessionId,
                projectId,
                index: index++,
                role: "assistant",
                parts: [textPart(output)],
                createdAt,
              })
            )
            note("orphan_tool_result")
          }
          break
        }

        if (role === "bashExecution") {
          // A direct `!command` the user ran; Pi records it as its own role.
          messages.push(
            buildMessage({
              sessionId,
              projectId,
              index: index++,
              role: "assistant",
              parts: [
                toolPart({
                  name: "bash",
                  toolCallId: entry.id ?? `bash-${index}`,
                  input: { command: message.command ?? "" },
                  ...(message.output !== undefined ? { output: message.output } : {}),
                }),
              ],
              createdAt,
            })
          )
          break
        }

        const parts = blocksToParts(contentBlocks(message.content))
        if (parts.length === 0) break

        if (role === "assistant" && message.model) {
          model = message.provider ? `${message.provider}/${message.model}` : message.model
        }
        if (role === "user" && !firstUserText) firstUserText = plainText(parts)

        const stored = buildMessage({
          sessionId,
          projectId,
          index: index++,
          role: role === "user" ? "user" : "assistant",
          parts,
          createdAt,
          ...(piUsageMetadata(message) ?? {}),
        })
        messages.push(stored)

        for (const part of parts) {
          const id = (part as { toolCallId?: string }).toolCallId
          if (id) toolOwner.set(id, messages.length - 1)
        }
        break
      }

      case "custom_message": {
        // Extension-injected context that DID reach the model, so it belongs
        // in the transcript.
        const parts = blocksToParts(contentBlocks(entry.content))
        if (parts.length > 0) {
          messages.push(
            buildMessage({
              sessionId,
              projectId,
              index: index++,
              role: "assistant",
              parts,
              createdAt,
            })
          )
        }
        break
      }

      case "compaction":
      case "branch_summary": {
        if (entry.summary) {
          messages.push(
            buildMessage({
              sessionId,
              projectId,
              index: index++,
              role: "assistant",
              parts: [textPart(entry.summary)],
              createdAt,
            })
          )
        }
        break
      }

      case "model_change":
        if (entry.modelId) {
          model = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId
        }
        break

      case "thinking_level_change":
      case "label":
      case "session_info":
        // Metadata with no transcript equivalent, and no model-visible content.
        break

      case "custom":
        // Extension state. Pi's own context builder excludes these, so they
        // never reached the model — reported, never rendered.
        note(`custom:${entry.customType ?? "unknown"}`)
        break

      default:
        note(`unknown:${entry.type ?? "untyped"}`)
        break
    }
  }

  return { messages, firstUserText, model, lossy }
}

// ============================================================================
// Summaries
// ============================================================================

/** Cheap single-pass summary for the scan list (no message allocation). */
export function summarizePiFile(content: string, locator: string): SessionSummary | null {
  const { header, entries } = parsePiSessionFile(content)
  if (!isSupported(header)) return null

  let firstUserText = ""
  let messageCount = 0
  let lastTimestamp = header?.timestamp ?? ""

  for (const entry of entries) {
    if (entry.timestamp) lastTimestamp = entry.timestamp
    if (entry.type !== "message") continue
    messageCount++
    if (!firstUserText && entry.message?.role === "user") {
      firstUserText = plainText(blocksToParts(contentBlocks(entry.message.content)))
    }
  }

  if (messageCount === 0) return null

  const createdAt = Date.parse(header?.timestamp ?? "") || Date.now()
  return {
    ref: { sourceId: PI_SOURCE_ID, originalSessionId: header?.id ?? locator, locator },
    title: deriveTitle(firstUserText, "Pi session"),
    sourceId: PI_SOURCE_ID,
    messageCount,
    updatedAt: Date.parse(lastTimestamp) || createdAt,
    ...(header?.cwd ? { cwd: header.cwd } : {}),
  }
}

// ============================================================================
// Adapter
// ============================================================================

async function readFile(input: SessionScanInput, locator: string): Promise<string> {
  const picked = input.pickedFiles?.find((file) => file.path === locator)
  if (picked) return picked.content
  return input.fs.readTextFile(locator)
}

export function parsePiSession(ref: SessionRef, content: string): ImportedConversation {
  const { header, entries, corruptLines } = parsePiSessionFile(content)
  const sessionId = importedSessionId(PI_SOURCE_ID, header?.id ?? ref.originalSessionId)

  const chain = piActiveChain(entries)
  const main = buildTurns(chain, sessionId)

  const createdAt = Date.parse(header?.timestamp ?? "") || Date.now()
  const updatedAt =
    main.messages.length > 0 ? main.messages[main.messages.length - 1].createdAt : createdAt

  const messagesWithNotes = main.messages
  const lossNotes: Record<string, number> = Object.fromEntries(main.lossy)
  if (corruptLines > 0) lossNotes.corrupt_lines = corruptLines

  const session = buildSession({
    id: sessionId,
    title: deriveTitle(main.firstUserText, "Pi session"),
    ...(main.model ? { model: main.model } : {}),
    ...(header?.cwd ? { workingDir: header.cwd } : {}),
    createdAt,
    updatedAt,
    seedMessages: main.messages,
  })
  session.importRuntimeBinding = {
    presetId: "pi-rpc",
    nativeSessionId: header?.id ?? ref.originalSessionId,
    cwd: header?.cwd,
    resumeMethod: "api",
    verifiedAt: piSessionSource.verifiedAt,
  }
  if (header?.parentSession) {
    const parentFile = header.parentSession.replace(/\\/g, "/").split("/").pop() ?? ""
    const parentNativeSessionId = parentFile.replace(/\.jsonl$/i, "")
    session.importRelation = {
      kind: "fork",
      ...(parentNativeSessionId ? { parentNativeSessionId } : {}),
    }
  }

  // Alternate leaves are branches the user can still reach in Pi's `/tree`.
  // They import as nested conversations rather than being discarded.
  const nested: ImportedConversation[] = []
  for (const leafId of piAlternateLeafIds(entries)) {
    const branchChain = piChainToLeaf(entries, leafId)
    if (branchChain.length === 0) continue
    const branchSessionId = `${sessionId}:branch:${leafId}`
    const branch = buildTurns(branchChain, branchSessionId)
    if (branch.messages.length === 0) continue

    const branchSession = buildSession({
      id: branchSessionId,
      title: deriveTitle(branch.firstUserText, "Pi branch"),
      ...(branch.model ? { model: branch.model } : {}),
      ...(header?.cwd ? { workingDir: header.cwd } : {}),
      createdAt,
      updatedAt: branch.messages[branch.messages.length - 1].createdAt,
      seedMessages: branch.messages,
    })
    branchSession.parentSessionId = sessionId
    branchSession.importRelation = {
      kind: "branch",
      parentNativeSessionId: header?.id ?? ref.originalSessionId,
    }
    branchSession.importRuntimeBinding = {
      presetId: "pi-rpc",
      nativeSessionId: header?.id ?? ref.originalSessionId,
      cwd: header?.cwd,
      resumeMethod: "api",
      verifiedAt: piSessionSource.verifiedAt,
    }
    nested.push({ session: branchSession, messages: branch.messages })
  }

  // Import notes ride the FIRST message's metadata, not the session row:
  // `ChatSession` has no `metadata` field, so a note written there would be
  // outside the type contract and unreadable by anything downstream — a
  // built-but-dormant field rather than a report.
  // Written whenever there is anything to say. The fork origin is independent
  // of whether the file also had losses, so gating it on `lossNotes` would
  // drop it for every clean forked session.
  const hasNotes = Object.keys(lossNotes).length > 0
  if (messagesWithNotes.length > 0 && (hasNotes || header?.parentSession)) {
    const first = messagesWithNotes[0]
    first.metadata = {
      ...first.metadata,
      piImport: {
        sessionVersion: header?.version ?? 1,
        ...(header?.parentSession ? { forkedFrom: header.parentSession } : {}),
        ...(hasNotes ? { notes: lossNotes } : {}),
      },
    }
  }

  return {
    session,
    messages: messagesWithNotes,
    ...(nested.length > 0 ? { nested } : {}),
  }
}

export const piSessionSource: AgentSessionSourceAdapter = {
  id: PI_SOURCE_ID,
  displayName: "Pi",
  labelKey: "pi",
  verifiedVersion: "0.84.4",
  verifiedAt: "2026-08-29",
  acceptedExtensions: [".jsonl"],

  scanRoots(home, roots) {
    // `piSessionDir` already folds in both `$PI_CODING_AGENT_SESSION_DIR` and
    // `$PI_CODING_AGENT_DIR` (sessions hang off the agent dir), resolved in
    // Rust where the environment is actually visible. The home-relative
    // fallback is only for web mode / tests, which have no IPC.
    const sessions = roots?.piSessionDir || (home ? joinPath(home, ".pi/agent/sessions") : "")
    return sessions ? [sessions] : []
  },

  detect(files: PickedSessionFile[]): SessionDetectVerdict {
    const hinted = files.some((file) => file.path.includes(`.pi${pathSep(file.path)}agent`))
    if (hinted) return "match"
    // Content sniff: a Pi file opens with a `session` header carrying `cwd`.
    const sniffed = files.some((file) => {
      const first = file.content.split("\n").find((line) => line.trim())
      if (!first) return false
      try {
        const parsed = JSON.parse(first) as PiHeader
        return parsed.type === "session" && typeof parsed.cwd === "string"
      } catch {
        return false
      }
    })
    return sniffed ? "match" : "no"
  },

  async listSessions(input: SessionScanInput): Promise<SessionSummary[]> {
    return scanFileSummaries(
      input,
      this.scanRoots(input.home, input.roots),
      (path) => path.endsWith(".jsonl"),
      summarizePiFile
    )
  },

  async parseSession(ref: SessionRef, input: SessionScanInput): Promise<ImportedConversation> {
    return parsePiSession(ref, await readFile(input, ref.locator))
  },
  async parseGraph(ref: SessionRef, input: SessionScanInput) {
    return buildImportedSessionGraph(await this.parseSession(ref, input), {
      sourceRuntime: this.id,
      sourceVersion: this.verifiedVersion,
      verifiedAt: this.verifiedAt,
      importFidelity: this.codec?.importFidelity ?? "structured",
      codec: this.codec,
    })
  },

  summarizeFile: summarizePiFile,
  codec: piCodec,
}

function pathSep(path: string): string {
  return path.includes("\\") ? "\\" : "/"
}
