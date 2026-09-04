/**
 * The agent-authored half of Artifacts and Canvas.
 *
 * `types/agent/tool.ts` has declared `artifact_create` / `artifact_update` /
 * `canvas_create` / … for a long time, and BOTH message-conversion paths
 * (`lib/claude/adapter.ts`, `lib/ai/agent/external/event-to-parts.ts`) already
 * knew how to turn such a call into an `ArtifactPart` — but nothing ever
 * defined, registered or executed one. Artifacts could only be born from the
 * heuristic fence detector (`lib/ai/generation/artifact-detector.ts`) at turn
 * end, so the model could not name one, choose its type, set a chart's shape,
 * or revise a specific one.
 *
 * ## Why this rides the plugin-tool relay
 *
 * `lib/claude/plugin-tool-ipc.ts` + `opts.pluginTools` is a generic host-routed
 * tool channel that is already live on both dispatch paths and already carries
 * six tool families (web, editor, skill, team, vector, session-peer). The
 * artifact store lives in the renderer and the sidecar cannot import `lib/`, so
 * this is exactly the shape that channel exists for. Building a second relay
 * beside it — the `sidecar/a2ui-tools/` MCP-server shape — would be duplicating
 * working machinery; A2UI needs its own only because an IM-projected surface
 * has a reader outside cognia, which an artifact never does.
 *
 * ## Why the create tools return the id
 *
 * `createArtifact` mints its own id. A `tool_use` block is seen *before* the row
 * exists, so a part built from the model's INPUT can only ever point at nothing
 * — which is precisely why an `ArtifactPart` from that path rendered the
 * "cleared" placeholder. The part is emitted from the `tool_result` instead
 * (`lib/artifacts/tool-part.ts`), and this is what puts the real id in it.
 */

import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import { revealCanvasDocument } from "@/lib/artifacts/reveal"
import { buildArtifactSourceMetadata } from "@/lib/artifacts/source-metadata"
import { ARTIFACT_TYPES } from "@/lib/artifacts/constants"
import type { Artifact, ArtifactLanguage, ArtifactType, CanvasDocument } from "@/types"

export const ARTIFACT_BUILTIN_PLUGIN_ID = "cognia-artifact-builtin"

export const ARTIFACT_CREATE_TOOL_NAME = "artifact_create"
export const ARTIFACT_UPDATE_TOOL_NAME = "artifact_update"
export const ARTIFACT_READ_TOOL_NAME = "artifact_read"
export const ARTIFACT_DELETE_TOOL_NAME = "artifact_delete"
export const CANVAS_CREATE_TOOL_NAME = "canvas_create"
export const CANVAS_UPDATE_TOOL_NAME = "canvas_update"
export const CANVAS_READ_TOOL_NAME = "canvas_read"
export const CANVAS_OPEN_TOOL_NAME = "canvas_open"

export const ARTIFACT_TOOL_NAMES = [
  ARTIFACT_CREATE_TOOL_NAME,
  ARTIFACT_UPDATE_TOOL_NAME,
  ARTIFACT_READ_TOOL_NAME,
  ARTIFACT_DELETE_TOOL_NAME,
] as const

export const CANVAS_TOOL_NAMES = [
  CANVAS_CREATE_TOOL_NAME,
  CANVAS_UPDATE_TOOL_NAME,
  CANVAS_READ_TOOL_NAME,
  CANVAS_OPEN_TOOL_NAME,
] as const

const ALL_TOOL_NAMES: ReadonlySet<string> = new Set([...ARTIFACT_TOOL_NAMES, ...CANVAS_TOOL_NAMES])

export function isArtifactBuiltinTool(name: string): boolean {
  return ALL_TOOL_NAMES.has(name)
}

export interface ArtifactManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

/**
 * Read results are capped. A 400 KB artifact pasted whole into the context
 * window is a worse answer than a truncated one plus its length, and the cap
 * also bounds what the caller's PII gate has to scan.
 */
export const READ_CONTENT_MAX_CHARS = 8000

/** Ceiling on a `artifact_read` listing, so a long session cannot flood a turn. */
export const READ_LIST_MAX_ITEMS = 25

const ARTIFACT_LANGUAGES: readonly ArtifactLanguage[] = [
  "javascript",
  "typescript",
  "python",
  "plaintext",
  "html",
  "css",
  "json",
  "markdown",
  "jsx",
  "tsx",
  "sql",
  "bash",
  "yaml",
  "xml",
  "svg",
  "mermaid",
  "latex",
]

export function buildArtifactManifestEntries(): ArtifactManifestEntry[] {
  return [
    {
      name: ARTIFACT_CREATE_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Create an artifact and open it in the user's artifact dock. Prefer this over a fenced code block whenever the content is a deliverable the user will keep, re-read or export — a chart, a diagram, a page, a document. Load the `chart-design` skill before emitting a chart.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "content"],
        properties: {
          type: { type: "string", enum: [...ARTIFACT_TYPES] },
          title: { type: "string", minLength: 1, maxLength: 200 },
          content: { type: "string", minLength: 1 },
          language: { type: "string", enum: [...ARTIFACT_LANGUAGES] },
          chartType: {
            type: "string",
            enum: ["bar", "line", "area", "pie", "doughnut", "scatter", "radar"],
            description: "Only for `type: chart`. Picks the shape the renderer draws.",
          },
        },
      },
    },
    {
      name: ARTIFACT_UPDATE_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Revise an existing artifact. When the user has review-before-apply on (the default), the revision is staged as a diff for them to accept per hunk rather than overwriting.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["artifactId", "content"],
        properties: {
          artifactId: { type: "string", minLength: 1 },
          content: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1, maxLength: 200 },
          changeDescription: { type: "string", maxLength: 200 },
        },
      },
    },
    {
      name: ARTIFACT_READ_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Read one artifact by id, or list this conversation's artifacts. Pass `artifactId` for one; pass nothing (optionally with `query`) to list titles and types.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          artifactId: { type: "string", minLength: 1 },
          query: { type: "string", maxLength: 200 },
        },
      },
    },
    {
      name: ARTIFACT_DELETE_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Delete an artifact. Destroys user-visible work, so the user is asked before it runs.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["artifactId"],
        properties: { artifactId: { type: "string", minLength: 1 } },
      },
    },
  ]
}

export function buildCanvasManifestEntries(): ArtifactManifestEntry[] {
  return [
    {
      name: CANVAS_CREATE_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Create a Canvas document — an editable buffer the user will keep working in with you. Use this over an artifact when the point is continued editing rather than a finished result.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "content", "language"],
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          content: { type: "string" },
          language: { type: "string", enum: [...ARTIFACT_LANGUAGES] },
          type: { type: "string", enum: ["code", "text"] },
        },
      },
    },
    {
      name: CANVAS_UPDATE_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Rewrite a Canvas document's buffer. With review-before-apply on (the default) this is staged as a diff for the user to accept rather than replacing what they are editing.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["documentId", "content"],
        properties: {
          documentId: { type: "string", minLength: 1 },
          content: { type: "string" },
          title: { type: "string", minLength: 1, maxLength: 200 },
          changeDescription: { type: "string", maxLength: 200 },
        },
      },
    },
    {
      name: CANVAS_READ_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description:
        "Read one Canvas document by id, or list the open documents. Includes the user's current selection when there is one.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        properties: { documentId: { type: "string", minLength: 1 } },
      },
    },
    {
      name: CANVAS_OPEN_TOOL_NAME,
      pluginId: ARTIFACT_BUILTIN_PLUGIN_ID,
      description: "Bring a Canvas document on screen for the user.",
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["documentId"],
        properties: { documentId: { type: "string", minLength: 1 } },
      },
    },
  ]
}

export interface ArtifactToolContext {
  sessionId: string
  /** The assistant message this call belongs to, used as the review request id. */
  messageId?: string
}

type Failure = { ok: false; code: string; error: string }

function invalidArguments(error: string): Failure {
  return { ok: false, code: "invalid_arguments", error }
}

function notFound(kind: string, id: string): Failure {
  return { ok: false, code: "not_found", error: `no ${kind} with id ${id}` }
}

function str(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === "string" && value.trim() ? value : null
}

function truncate(content: string): { content: string; truncated: boolean; length: number } {
  if (content.length <= READ_CONTENT_MAX_CHARS) {
    return { content, truncated: false, length: content.length }
  }
  return {
    content: content.slice(0, READ_CONTENT_MAX_CHARS),
    truncated: true,
    length: content.length,
  }
}

/** Does the user want AI revisions staged for review rather than applied? */
function reviewBeforeApply(): boolean {
  return useSettingsStore.getState().settings?.artifacts?.reviewBeforeApply !== false
}

function artifactSummary(artifact: Artifact) {
  return {
    artifactId: artifact.id,
    title: artifact.title,
    type: artifact.type,
    ...(artifact.language ? { language: artifact.language } : {}),
    version: artifact.version,
  }
}

function canvasSummary(doc: CanvasDocument) {
  return {
    documentId: doc.id,
    title: doc.title,
    language: doc.language,
    type: doc.type,
  }
}

export interface ArtifactToolDeps {
  store: ReturnType<typeof useArtifactStore.getState>
  activeSessionId: string | null
}

/** Resolve the renderer-side singletons the runner writes through. */
export function resolveArtifactToolDeps(): ArtifactToolDeps {
  return {
    store: useArtifactStore.getState(),
    activeSessionId: useChatStore.getState().activeSessionId,
  }
}

/**
 * Execute one artifact/canvas tool call.
 *
 * Never throws: the relay turns a rejection into an opaque transport error,
 * whereas a structured `{ok:false, code}` reaches the model as something it can
 * act on. Same contract as `runWorkingSetTool`.
 */
export async function runArtifactBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: ArtifactToolDeps,
  context: ArtifactToolContext
): Promise<unknown> {
  const { store } = deps
  const sessionId = context.sessionId || deps.activeSessionId || ""

  try {
    switch (name) {
      case ARTIFACT_CREATE_TOOL_NAME: {
        const title = str(args, "title")
        const content = typeof args.content === "string" ? args.content : null
        const type = str(args, "type") as ArtifactType | null
        if (!title || !content || !type) {
          return invalidArguments("type, title and content are required")
        }
        if (!ARTIFACT_TYPES.includes(type)) {
          return invalidArguments(`type must be one of ${ARTIFACT_TYPES.join(", ")}`)
        }
        const language = str(args, "language") as ArtifactLanguage | undefined
        const chartType = str(args, "chartType")
        const messageId = context.messageId ?? `tool:${name}`
        const artifact = store.createArtifact({
          sessionId,
          messageId,
          type,
          title,
          content,
          ...(language ? { language } : {}),
          metadata: {
            ...buildArtifactSourceMetadata({
              sessionId,
              messageId,
              type,
              content,
              ...(language ? { language } : {}),
              // The model asked for this by name; it is not a heuristic lift out
              // of a fenced block, and it is not the user's own click either.
              sourceOrigin: "tool",
              userInitiated: false,
            }),
            ...(chartType ? { chartType } : {}),
          },
        })
        return { ok: true as const, ...artifactSummary(artifact) }
      }

      case ARTIFACT_UPDATE_TOOL_NAME: {
        const artifactId = str(args, "artifactId")
        const content = typeof args.content === "string" ? args.content : null
        if (!artifactId || !content) return invalidArguments("artifactId and content are required")
        const existing = store.getArtifact(artifactId)
        if (!existing) return notFound("artifact", artifactId)

        // The same review gate a heuristic revision passes through
        // (`hooks/chat/claude-chat-events.ts`). An agent-authored edit must not
        // be the one way to bypass the user's own setting.
        if (reviewBeforeApply()) {
          const proposal = store.proposeArtifactUpdate(artifactId, content, {
            requestId: context.messageId ?? `tool:${artifactId}`,
          })
          if (proposal) {
            return {
              ok: true as const,
              ...artifactSummary(existing),
              staged: "review" as const,
              note: "Staged as a diff for the user to accept; the artifact is unchanged until they do.",
            }
          }
          // A null proposal means the content is identical or the row vanished
          // mid-flight; fall through to the direct write rather than reporting
          // a review the user will never see.
        }
        const changeDescription = str(args, "changeDescription") ?? undefined
        store.saveArtifactVersion(artifactId, changeDescription)
        const title = str(args, "title")
        store.updateArtifact(artifactId, { content, ...(title ? { title } : {}) })
        const updated = store.getArtifact(artifactId) ?? existing
        return { ok: true as const, ...artifactSummary(updated), staged: "applied" as const }
      }

      case ARTIFACT_READ_TOOL_NAME: {
        const artifactId = str(args, "artifactId")
        if (artifactId) {
          const artifact = store.getArtifact(artifactId)
          if (!artifact) return notFound("artifact", artifactId)
          const body = truncate(artifact.content)
          return {
            ok: true as const,
            ...artifactSummary(artifact),
            content: body.content,
            contentLength: body.length,
            truncated: body.truncated,
          }
        }
        const query = str(args, "query")?.toLowerCase()
        const rows = store
          .getArtifactsForWorkspace({ sessionId: sessionId || null, limit: READ_LIST_MAX_ITEMS })
          .filter((a) => !query || a.title.toLowerCase().includes(query))
        return { ok: true as const, artifacts: rows.map(artifactSummary) }
      }

      case ARTIFACT_DELETE_TOOL_NAME: {
        const artifactId = str(args, "artifactId")
        if (!artifactId) return invalidArguments("artifactId is required")
        if (!store.getArtifact(artifactId)) return notFound("artifact", artifactId)
        store.deleteArtifact(artifactId)
        return { ok: true as const, artifactId, deleted: true as const }
      }

      case CANVAS_CREATE_TOOL_NAME: {
        const title = str(args, "title")
        const language = str(args, "language") as ArtifactLanguage | null
        if (!title || !language) return invalidArguments("title and language are required")
        const documentId = store.createCanvasDocument({
          sessionId,
          title,
          content: typeof args.content === "string" ? args.content : "",
          language,
          type: args.type === "text" ? "text" : "code",
        })
        const doc = store.canvasDocuments[documentId]
        return {
          ok: true as const,
          ...(doc ? canvasSummary(doc) : { documentId, title, language }),
        }
      }

      case CANVAS_UPDATE_TOOL_NAME: {
        const documentId = str(args, "documentId")
        const content = typeof args.content === "string" ? args.content : null
        if (!documentId || content === null) {
          return invalidArguments("documentId and content are required")
        }
        const doc = store.getCanvasDocumentForWorkspace(documentId)
        if (!doc) return notFound("canvas document", documentId)

        if (reviewBeforeApply()) {
          const proposal = store.proposeCanvasReview(documentId, content, {
            requestId: context.messageId ?? `tool:${documentId}`,
          })
          if (proposal) {
            return {
              ok: true as const,
              ...canvasSummary(doc),
              staged: "review" as const,
              note: "Staged as a diff for the user to accept; the buffer is unchanged until they do.",
            }
          }
        }
        const title = str(args, "title")
        store.updateCanvasDocument(documentId, {
          content,
          updatedAt: new Date(),
          ...(title ? { title } : {}),
        })
        const updated = store.canvasDocuments[documentId] ?? doc
        return { ok: true as const, ...canvasSummary(updated), staged: "applied" as const }
      }

      case CANVAS_READ_TOOL_NAME: {
        const documentId = str(args, "documentId")
        if (documentId) {
          // Workspace-scoped: a turn running in one workspace cannot read a
          // document owned by another, and gets the same "not found" it would
          // get for a made-up id rather than a distinguishable refusal.
          const doc = store.getCanvasDocumentForWorkspace(documentId)
          if (!doc) return notFound("canvas document", documentId)
          const body = truncate(doc.content)
          return {
            ok: true as const,
            ...canvasSummary(doc),
            content: body.content,
            contentLength: body.length,
            truncated: body.truncated,
            ...(doc.editorContext?.selection ? { selection: doc.editorContext.selection } : {}),
          }
        }
        const docs = store.getCanvasDocumentsForWorkspace({
          sessionId: sessionId || null,
          limit: READ_LIST_MAX_ITEMS,
        })
        return { ok: true as const, documents: docs.map(canvasSummary) }
      }

      case CANVAS_OPEN_TOOL_NAME: {
        const documentId = str(args, "documentId")
        if (!documentId) return invalidArguments("documentId is required")
        const revealed = revealCanvasDocument(documentId)
        if (!revealed) return notFound("canvas document", documentId)
        return { ok: true as const, ...canvasSummary(revealed), opened: true as const }
      }

      default:
        return invalidArguments(`unknown artifact tool ${name}`)
    }
  } catch (err) {
    return {
      ok: false as const,
      code: "tool_failed",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
