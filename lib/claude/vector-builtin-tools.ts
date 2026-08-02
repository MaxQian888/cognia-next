/**
 * Host-routed vector agent tools — `vector_search`, `vector_add_document`,
 * `vector_delete_document`.
 *
 * Surfaced to the agent as plugin-manifest entries (the same wire as
 * `ask_user` / `web_search` / `Skill`) and resolved host-side in
 * `plugin-tool-ipc`, because the native vector store is reachable only from
 * the renderer/CLI host: it is a Tauri command surface plus TS the pure `.mjs`
 * sidecar cannot import. No MCP process is involved and no second vector
 * backend is introduced — `lib/vector/agent-vector-service` instantiates the
 * existing `NativeVectorStore` directly.
 *
 * Isolation contract, in order of enforcement:
 *
 *   1. **Project comes from context, never from arguments.** The tool schemas
 *      have no project field; `resolveProjectId(sessionId)` is the only source.
 *      A session with no linked project cannot use the tools at all.
 *   2. **Permission gate.** `vector:read` + `ai:embed` to search,
 *      `vector:write` + `ai:embed` to add, `vector:write` to delete — checked
 *      against the same `PluginAPIPermission` space plugins use.
 *   3. **PII gate.** Query text, document content and metadata all pass
 *      `@cognia/redact` before anything is embedded or stored.
 *   4. **Collection mapping.** The agent's logical name is validated and
 *      prefixed into the project's namespace by `lib/vector/agent-collections`.
 *
 * Every outcome — allowed or refused — writes one redaction-safe row to the
 * `lib/vector/agent-tool-audit` ring. Failures are returned as structured
 * `{ ok: false, code, error }` results the model can read, never thrown.
 */

import { hasNoLeakingPii, hasNoLeakingPiiDeep } from "@cognia/redact"
import type { PluginAPIPermission } from "@/types/plugin/plugin"
import type { PayloadFilter } from "@cognia/vector/store"
import {
  DEFAULT_AGENT_VECTOR_COLLECTION,
  checkLogicalCollection,
  describeLogicalCollectionRejection,
  resolveAgentCollection,
} from "@/lib/vector/agent-collections"
import type { AgentVectorService } from "@/lib/vector/agent-vector-service"
import { VectorServiceError } from "@/lib/vector/agent-vector-service"
import {
  recordVectorToolAudit,
  type VectorToolDenialReason,
  type VectorToolOperation,
} from "@/lib/vector/agent-tool-audit"

export const VECTOR_SEARCH_TOOL_NAME = "vector_search"
export const VECTOR_ADD_DOCUMENT_TOOL_NAME = "vector_add_document"
export const VECTOR_DELETE_DOCUMENT_TOOL_NAME = "vector_delete_document"

/** Synthetic plugin id tagging the promoted built-in vector manifest entries. */
export const VECTOR_BUILTIN_PLUGIN_ID = "cognia-vector-builtin"

/** Default per-call wall-clock budget. Embedding + search over a cold index. */
export const DEFAULT_VECTOR_TOOL_TIMEOUT_MS = 30_000

const VECTOR_TOOL_NAMES = new Set<string>([
  VECTOR_SEARCH_TOOL_NAME,
  VECTOR_ADD_DOCUMENT_TOOL_NAME,
  VECTOR_DELETE_DOCUMENT_TOOL_NAME,
])

/** Permissions each tool requires, in the shared `PluginAPIPermission` space. */
export const VECTOR_TOOL_PERMISSIONS: Record<string, readonly PluginAPIPermission[]> = {
  [VECTOR_SEARCH_TOOL_NAME]: ["vector:read", "ai:embed"],
  [VECTOR_ADD_DOCUMENT_TOOL_NAME]: ["vector:write", "ai:embed"],
  [VECTOR_DELETE_DOCUMENT_TOOL_NAME]: ["vector:write"],
}

const COLLECTION_PROPERTY = {
  type: "string",
  description: `Logical collection name. Defaults to "${DEFAULT_AGENT_VECTOR_COLLECTION}". Scoped to the current project automatically.`,
} as const

const VECTOR_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", description: "Natural-language text to search for." },
    collection: COLLECTION_PROPERTY,
    topK: { type: "number", description: "Maximum number of hits to return (default 5)." },
    threshold: {
      type: "number",
      description: "Minimum similarity score, 0–1. Hits below it are dropped.",
    },
    filters: {
      type: "array",
      description: "Optional metadata filters, all combined with AND.",
      items: {
        type: "object",
        properties: {
          key: { type: "string", description: "Metadata key to filter on." },
          value: { description: "Value to compare against." },
          operation: {
            type: "string",
            enum: [
              "equals",
              "not_equals",
              "greater_than",
              "greater_than_or_equals",
              "less_than",
              "less_than_or_equals",
              "contains",
              "in",
            ],
            description: "Comparison operator (default equals).",
          },
        },
        required: ["key", "value"],
      },
    },
  },
  required: ["query"],
} as const

const VECTOR_ADD_DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "Document text to embed and store." },
    collection: COLLECTION_PROPERTY,
    id: {
      type: "string",
      description: "Stable document id. Re-using an existing id overwrites that document.",
    },
    metadata: {
      type: "object",
      description: "Optional structured metadata stored alongside the document.",
    },
  },
  required: ["content"],
} as const

const VECTOR_DELETE_DOCUMENT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id of the document to remove." },
    collection: COLLECTION_PROPERTY,
  },
  required: ["id"],
} as const

export interface VectorBuiltinManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

/**
 * Manifest entries for the three vector tools. Appended to `opts.pluginTools`
 * by `build-options` when `selfInvokeTools.vector` is on.
 */
export function buildVectorManifestEntries(): VectorBuiltinManifestEntry[] {
  return [
    {
      name: VECTOR_SEARCH_TOOL_NAME,
      description:
        "Semantic search over the current project's vector memory. Returns ranked documents with their similarity scores and metadata. Use it to recall facts, notes or files you stored earlier in this project.",
      jsonSchema: VECTOR_SEARCH_SCHEMA as unknown as Record<string, unknown>,
      pluginId: VECTOR_BUILTIN_PLUGIN_ID,
    },
    {
      name: VECTOR_ADD_DOCUMENT_TOOL_NAME,
      description:
        "Store a document in the current project's vector memory so it can be recalled later with vector_search. The collection is created on first write.",
      jsonSchema: VECTOR_ADD_DOCUMENT_SCHEMA as unknown as Record<string, unknown>,
      pluginId: VECTOR_BUILTIN_PLUGIN_ID,
    },
    {
      name: VECTOR_DELETE_DOCUMENT_TOOL_NAME,
      description:
        "Remove a document from the current project's vector memory by id. Returns deleted:false when the id or collection does not exist.",
      jsonSchema: VECTOR_DELETE_DOCUMENT_SCHEMA as unknown as Record<string, unknown>,
      pluginId: VECTOR_BUILTIN_PLUGIN_ID,
    },
  ]
}

/** Is this tool name one of the promoted vector built-ins? */
export function isVectorBuiltinTool(name: string): boolean {
  return VECTOR_TOOL_NAMES.has(name)
}

export interface VectorToolRunDeps {
  /** Native vector service, already bound to the desktop store. */
  service: AgentVectorService
  /** Resolve the session's linked project. `null` disables the tools. */
  resolveProjectId: (sessionId: string) => Promise<string | null> | string | null
  /** Permission check in the shared `PluginAPIPermission` space. */
  hasPermission: (permission: PluginAPIPermission) => boolean
  /** PII gate for free text. Defaults to `@cognia/redact:hasNoLeakingPii`. */
  gateText?: (text: string) => boolean
  /** PII gate for structured values. Defaults to `hasNoLeakingPiiDeep`. */
  gateDeep?: (value: unknown) => boolean
  /** Id generator for `vector_add_document` when the model omits `id`. */
  newDocumentId?: () => string
  /** Per-call wall-clock budget. Defaults to {@link DEFAULT_VECTOR_TOOL_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Caller cancellation (turn abort). Composed with the timeout. */
  signal?: AbortSignal
}

export interface VectorToolContext {
  sessionId: string
}

/** Structured failure the model reads verbatim. */
export interface VectorToolFailure {
  ok: false
  code: VectorToolDenialReason | "no-project"
  error: string
}

export type VectorToolResult =
  | {
      ok: true
      collection: string
      results: Array<{
        id: string
        content: string
        score: number
        metadata?: Record<string, unknown>
      }>
    }
  | { ok: true; collection: string; id: string; createdCollection: boolean }
  | { ok: true; collection: string; id: string; deleted: boolean }
  | VectorToolFailure

function fail(code: VectorToolFailure["code"], error: string): VectorToolFailure {
  return { ok: false, code, error }
}

/** Map a service error code onto the audit vocabulary. */
function reasonForServiceError(err: VectorServiceError): VectorToolDenialReason {
  return err.code === "cancelled" ? "cancelled" : "error"
}

/**
 * Compose the caller's signal with a timeout. Returns the signal plus a
 * disposer that clears the timer so a fast call does not keep it alive.
 */
function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
  const controller = new AbortController()
  let didTimeOut = false

  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener("abort", onAbort, { once: true })
  }
  const timer = setTimeout(() => {
    didTimeOut = true
    controller.abort()
  }, timeoutMs)

  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

function normalizeFilters(raw: unknown): PayloadFilter[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const filters: PayloadFilter[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const entry = item as Record<string, unknown>
    if (typeof entry.key !== "string" || !entry.key) continue
    filters.push({
      key: entry.key,
      value: entry.value,
      operation: (typeof entry.operation === "string"
        ? entry.operation
        : "equals") as PayloadFilter["operation"],
    })
  }
  return filters.length ? filters : undefined
}

function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined
}

/**
 * Execute a vector built-in host-side. Called from `plugin-tool-ipc`'s
 * `plugin_tool_exec` handler. Never throws.
 */
export async function runVectorBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: VectorToolRunDeps,
  ctx: VectorToolContext
): Promise<VectorToolResult> {
  const operation: VectorToolOperation =
    name === VECTOR_SEARCH_TOOL_NAME
      ? "search"
      : name === VECTOR_ADD_DOCUMENT_TOOL_NAME
        ? "add"
        : "delete"
  const gateText = deps.gateText ?? hasNoLeakingPii
  const gateDeep = deps.gateDeep ?? hasNoLeakingPiiDeep

  // ── Logical collection ────────────────────────────────────────────────────
  const rawCollection =
    args.collection === undefined || args.collection === null
      ? DEFAULT_AGENT_VECTOR_COLLECTION
      : args.collection
  if (typeof rawCollection !== "string") {
    return fail("invalid-argument", "collection must be a string")
  }
  const checked = checkLogicalCollection(rawCollection)
  if (!checked.ok) {
    return fail("invalid-argument", describeLogicalCollectionRejection(checked.reason))
  }
  const collection = checked.name

  const audit = (
    ok: boolean,
    projectId: string,
    extra: { count?: number; documentId?: string; reason?: VectorToolDenialReason } = {}
  ) => {
    recordVectorToolAudit({ projectId, collection, operation, ok, ...extra })
  }

  // ── Project scope — context only, never an argument ───────────────────────
  let projectId: string | null
  try {
    projectId = await deps.resolveProjectId(ctx.sessionId)
  } catch {
    projectId = null
  }
  if (!projectId) {
    // No project row to attribute the refusal to; the ring stays project-keyed,
    // so an unattributable call is simply not recorded.
    return fail(
      "no-project",
      "Vector memory is project-scoped. Link this session to a project before using the vector tools."
    )
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  const required = VECTOR_TOOL_PERMISSIONS[name] ?? []
  const missing = required.filter((permission) => !deps.hasPermission(permission))
  if (missing.length) {
    audit(false, projectId, { reason: "permission" })
    return fail("permission", `Missing required permission(s): ${missing.join(", ")}.`)
  }

  const budget = withTimeout(deps.signal, deps.timeoutMs ?? DEFAULT_VECTOR_TOOL_TIMEOUT_MS)
  try {
    const nativeCollection = resolveAgentCollection(projectId, collection)

    if (name === VECTOR_SEARCH_TOOL_NAME) {
      const query = typeof args.query === "string" ? args.query.trim() : ""
      if (!query) {
        audit(false, projectId, { reason: "invalid-argument" })
        return fail("invalid-argument", "query must be a non-empty string")
      }
      // The query text is sent to the embedder — same red-line as ctx.vector.embed.
      if (!gateText(query)) {
        audit(false, projectId, { reason: "pii" })
        return fail("pii", "Query blocked by the PII redaction gate.")
      }
      const filters = normalizeFilters(args.filters)
      if (filters && !gateDeep(filters)) {
        audit(false, projectId, { reason: "pii" })
        return fail("pii", "Filters blocked by the PII redaction gate.")
      }
      const results = await deps.service.search(nativeCollection, query, {
        ...(positiveNumber(args.topK) !== undefined ? { topK: positiveNumber(args.topK) } : {}),
        ...(typeof args.threshold === "number" ? { threshold: args.threshold } : {}),
        ...(filters ? { filters } : {}),
        signal: budget.signal,
      })
      audit(true, projectId, { count: results.length })
      return { ok: true, collection, results }
    }

    if (name === VECTOR_ADD_DOCUMENT_TOOL_NAME) {
      const content = typeof args.content === "string" ? args.content : ""
      if (!content.trim()) {
        audit(false, projectId, { reason: "invalid-argument" })
        return fail("invalid-argument", "content must be a non-empty string")
      }
      if (args.id !== undefined && (typeof args.id !== "string" || !args.id.trim())) {
        audit(false, projectId, { reason: "invalid-argument" })
        return fail("invalid-argument", "id must be a non-empty string when supplied")
      }
      const metadata =
        args.metadata && typeof args.metadata === "object" && !Array.isArray(args.metadata)
          ? (args.metadata as Record<string, unknown>)
          : undefined
      if (args.metadata !== undefined && metadata === undefined) {
        audit(false, projectId, { reason: "invalid-argument" })
        return fail("invalid-argument", "metadata must be an object")
      }
      // Content is embedded; metadata is persisted alongside it.
      if (!gateText(content)) {
        audit(false, projectId, { reason: "pii" })
        return fail("pii", "Document content blocked by the PII redaction gate.")
      }
      if (metadata && !gateDeep(metadata)) {
        audit(false, projectId, { reason: "pii" })
        return fail("pii", "Document metadata blocked by the PII redaction gate.")
      }
      const id =
        typeof args.id === "string" ? args.id.trim() : (deps.newDocumentId ?? defaultDocumentId)()
      const outcome = await deps.service.addDocument(nativeCollection, {
        id,
        content,
        ...(metadata ? { metadata } : {}),
        signal: budget.signal,
      })
      audit(true, projectId, { count: 1, documentId: id })
      return { ok: true, collection, id, createdCollection: outcome.createdCollection }
    }

    // vector_delete_document
    const id = typeof args.id === "string" ? args.id.trim() : ""
    if (!id) {
      audit(false, projectId, { reason: "invalid-argument" })
      return fail("invalid-argument", "id must be a non-empty string")
    }
    const { deleted } = await deps.service.deleteDocument(nativeCollection, id, {
      signal: budget.signal,
    })
    audit(true, projectId, { count: deleted ? 1 : 0, documentId: id })
    return { ok: true, collection, id, deleted }
  } catch (err) {
    if (err instanceof VectorServiceError) {
      const reason =
        budget.timedOut() && err.code === "cancelled" ? "timeout" : reasonForServiceError(err)
      audit(false, projectId, { reason })
      return fail(reason, reason === "timeout" ? "Vector operation timed out." : err.message)
    }
    audit(false, projectId, { reason: "error" })
    return fail("error", err instanceof Error ? err.message : String(err))
  } finally {
    budget.dispose()
  }
}

let fallbackCounter = 0

/**
 * Id used when the model omits one. Deliberately local (not `nanoid`) so the
 * tool layer has no runtime dependency beyond what it already imports; the
 * value only has to be unique within the collection.
 */
function defaultDocumentId(): string {
  fallbackCounter = (fallbackCounter + 1) % 1_000_000
  return `vdoc_${Date.now().toString(36)}_${fallbackCounter.toString(36)}`
}
