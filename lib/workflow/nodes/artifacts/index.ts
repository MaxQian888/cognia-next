/**
 * Artifact and Canvas workflow actions:
 * `action.artifact.{create,update,get,export}` and `action.canvas.{create,get}`.
 *
 * The scenario that earns these: a schedule runs a flow, an agent step produces
 * a chart, `action.artifact.create` turns it into a real artifact row, and
 * `action.artifact.export` hands the PNG to `action.connector.forward`. Until
 * now an artifact could only be born from a chat turn.
 *
 * Six kinds, deliberately:
 *
 *  - **No `delete`.** An unattended DAG that removes a user's saved output is a
 *    consent problem, and the dock has the button. `artifact_delete` is `ask`
 *    for the model for the same reason.
 *  - **No `canvas.update`.** A canvas document is an editor buffer the user may
 *    have open, where `editorRef.current.getValue()` is the authoritative copy
 *    and an external content change has to cancel the pending commit
 *    (`components/canvas/canvas-panel.tsx`). Writing into it from a background
 *    flow either stages a diff nobody is there to accept, or overwrites what
 *    someone is typing. An artifact is an output, not an open buffer, so
 *    `action.artifact.update` does not have that problem.
 *  - **No `canvas.open`.** Revealing a panel means nothing in a headless run.
 *
 * Writes go through `runArtifactBuiltinTool` — the same runner the model's
 * tools use — so the review gate, the source metadata and the version bump have
 * exactly one implementation. Reads deliberately do NOT: that runner truncates
 * content at 8 KB because its consumer is a context window, and a flow's
 * consumer is code. A `get → write to file` step that silently lost everything
 * past 8 KB would be worse than no node at all.
 */

import {
  ARTIFACT_CREATE_TOOL_NAME,
  ARTIFACT_UPDATE_TOOL_NAME,
  CANVAS_CREATE_TOOL_NAME,
  resolveArtifactToolDeps,
  runArtifactBuiltinTool,
} from "@/lib/claude/artifact-builtin-tools"
import { renderArtifactExport } from "@/lib/artifacts/export"
import { getArtifactExportFormats } from "@/components/artifacts/runtime-adapters"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { registerNodeExecutor } from "../registry"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { Artifact, ArtifactExportFormat, CanvasDocument } from "@/types/artifact/artifact"

/** Rasterising a large artifact is the slow one; the source formats are instant. */
const EXPORT_TIMEOUT_MS = 2 * 60_000

function requireString(ctx: StepExecutionContext, key: string, kind: string): string {
  const value = ctx.params[key]
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) throw new Error(`${kind}: ${key} is required`)
  return trimmed
}

function optionalString(ctx: StepExecutionContext, key: string): string | undefined {
  const value = ctx.params[key]
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || undefined
}

/**
 * Run one artifact tool and turn its structured failure into a thrown error.
 *
 * The runner never throws — a `{ok:false, code}` is something a model can act
 * on. A workflow step has the opposite contract: the runtime's retry, error
 * output and failure branch all key off a rejection, so swallowing the failure
 * here would report a successful step that did nothing.
 */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  kind: string,
  sessionId: string
): Promise<Record<string, unknown>> {
  const deps = resolveArtifactToolDeps()
  const result = (await runArtifactBuiltinTool(name, args, deps, {
    sessionId,
    // The review request id. A flow has no assistant message, so the step is
    // the thing being reviewed; without a stable id every re-run would open a
    // second pending diff for the same edit.
    messageId: `workflow:${kind}`,
  })) as Record<string, unknown>
  if (!result || result.ok !== true) {
    const message = typeof result?.error === "string" ? result.error : "artifact tool failed"
    const code = typeof result?.code === "string" ? result.code : "tool_failed"
    throw new Error(`${kind}: ${message} (${code})`)
  }
  return result
}

/**
 * The session a node's writes belong to.
 *
 * A flow may run with no conversation at all (a schedule, a webhook), and the
 * artifact store treats an empty session id as "not bound to a conversation" —
 * which is the honest answer, and keeps the row out of another conversation's
 * dock.
 */
function stepSessionId(ctx: StepExecutionContext): string {
  return optionalString(ctx, "sessionId") ?? ""
}

function artifactOutput(artifact: Artifact) {
  return {
    artifactId: artifact.id,
    title: artifact.title,
    type: artifact.type,
    language: artifact.language ?? null,
    version: artifact.version,
    sessionId: artifact.sessionId || null,
    updatedAt: artifact.updatedAt instanceof Date ? artifact.updatedAt.toISOString() : null,
  }
}

function canvasOutput(doc: CanvasDocument) {
  return {
    documentId: doc.id,
    title: doc.title,
    language: doc.language,
    type: doc.type,
    sessionId: doc.sessionId || null,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : null,
  }
}

registerNodeExecutor({
  kind: "action.artifact.create",
  typeVersion: 1,
  // A retry mints a second artifact rather than replacing the first: the store
  // assigns the id, so there is no key to be idempotent on.
  retryable: false,
  execute: async (ctx) => {
    const kind = "action.artifact.create"
    const result = await runTool(
      ARTIFACT_CREATE_TOOL_NAME,
      {
        title: requireString(ctx, "title", kind),
        type: requireString(ctx, "type", kind),
        content: typeof ctx.params.content === "string" ? ctx.params.content : "",
        ...(optionalString(ctx, "language") ? { language: optionalString(ctx, "language") } : {}),
        ...(optionalString(ctx, "chartType")
          ? { chartType: optionalString(ctx, "chartType") }
          : {}),
      },
      kind,
      stepSessionId(ctx)
    )
    return { output: result }
  },
})

registerNodeExecutor({
  kind: "action.artifact.update",
  typeVersion: 1,
  // Safe to repeat: the id is the author's, and a re-run saves another version
  // rather than duplicating the artifact.
  retryable: true,
  execute: async (ctx) => {
    const kind = "action.artifact.update"
    const result = await runTool(
      ARTIFACT_UPDATE_TOOL_NAME,
      {
        artifactId: requireString(ctx, "artifactId", kind),
        content: requireString(ctx, "content", kind),
        ...(optionalString(ctx, "title") ? { title: optionalString(ctx, "title") } : {}),
        ...(optionalString(ctx, "changeDescription")
          ? { changeDescription: optionalString(ctx, "changeDescription") }
          : {}),
      },
      kind,
      stepSessionId(ctx)
    )
    // `staged` is the field worth branching on: with "Review before apply" on,
    // the artifact is UNCHANGED and a diff is waiting for the user. A flow that
    // treated this as applied would publish the old content.
    return { output: result }
  },
})

registerNodeExecutor({
  kind: "action.artifact.get",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
    const kind = "action.artifact.get"
    const store = useArtifactStore.getState()
    const artifactId = optionalString(ctx, "artifactId")
    if (artifactId) {
      const artifact = store.getArtifact(artifactId)
      if (!artifact) throw new Error(`${kind}: no artifact with id ${artifactId}`)
      // Full content, deliberately — see the module header.
      return { output: { ...artifactOutput(artifact), content: artifact.content } }
    }
    const query = optionalString(ctx, "query")?.toLowerCase()
    const sessionId = stepSessionId(ctx)
    const rows = store
      .getArtifactsForWorkspace({ sessionId: sessionId || null })
      .filter((artifact) => !query || artifact.title.toLowerCase().includes(query))
    return { output: { artifacts: rows.map(artifactOutput) } }
  },
})

registerNodeExecutor({
  kind: "action.artifact.export",
  typeVersion: 1,
  retryable: true,
  timeoutMs: EXPORT_TIMEOUT_MS,
  execute: async (ctx) => {
    const kind = "action.artifact.export"
    const artifactId = requireString(ctx, "artifactId", kind)
    const format = (optionalString(ctx, "format") ?? "raw") as ArtifactExportFormat
    const artifact = useArtifactStore.getState().getArtifact(artifactId)
    if (!artifact) throw new Error(`${kind}: no artifact with id ${artifactId}`)
    const offered = getArtifactExportFormats(artifact)
    if (!offered.includes(format)) {
      throw new Error(
        `${kind}: a ${artifact.type} artifact cannot be exported as ${format} (offers ${offered.join(", ")})`
      )
    }

    // Rendered, never saved. `saveExport` opens a native save dialog on the
    // desktop, which would park an unattended run on a modal nobody is there to
    // answer. The bytes go into the flow instead, for `action.file.write` or
    // `action.connector.forward` to do something with.
    const rendered = await renderArtifactExport(artifact, format)
    if (typeof rendered.data === "string") {
      return {
        output: {
          artifactId,
          format,
          filename: rendered.filename,
          mimeType: rendered.mimeType,
          encoding: "utf-8" as const,
          content: rendered.data,
          byteLength: new TextEncoder().encode(rendered.data).length,
        },
      }
    }
    const bytes = new Uint8Array(await rendered.data.arrayBuffer())
    return {
      output: {
        artifactId,
        format,
        filename: rendered.filename,
        mimeType: rendered.mimeType,
        encoding: "base64" as const,
        content: base64FromBytes(bytes),
        byteLength: bytes.byteLength,
      },
    }
  },
})

/**
 * Chunked so a multi-megabyte PNG does not blow the argument limit of
 * `String.fromCharCode(...)`. `btoa` exists in every shell this runs in
 * (browser, WebView, and the headless brain's undici-backed global scope).
 */
function base64FromBytes(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

registerNodeExecutor({
  kind: "action.canvas.create",
  typeVersion: 1,
  // Same reason as `action.artifact.create`: the store mints the id.
  retryable: false,
  execute: async (ctx) => {
    const kind = "action.canvas.create"
    const result = await runTool(
      CANVAS_CREATE_TOOL_NAME,
      {
        title: requireString(ctx, "title", kind),
        language: requireString(ctx, "language", kind),
        content: typeof ctx.params.content === "string" ? ctx.params.content : "",
        type: ctx.params.type === "text" ? "text" : "code",
      },
      kind,
      stepSessionId(ctx)
    )
    return { output: result }
  },
})

registerNodeExecutor({
  kind: "action.canvas.get",
  typeVersion: 1,
  retryable: true,
  execute: async (ctx) => {
    const kind = "action.canvas.get"
    const documents = useArtifactStore.getState().canvasDocuments
    const documentId = optionalString(ctx, "documentId")
    if (documentId) {
      const doc = documents[documentId]
      if (!doc) throw new Error(`${kind}: no canvas document with id ${documentId}`)
      return { output: { ...canvasOutput(doc), content: doc.content } }
    }
    const sessionId = stepSessionId(ctx)
    const rows = Object.values(documents).filter(
      (doc) => !sessionId || !doc.sessionId || doc.sessionId === sessionId
    )
    return { output: { documents: rows.map(canvasOutput) } }
  },
})
