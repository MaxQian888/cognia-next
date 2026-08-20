/**
 * Embedded code-server "Pro IDE" workflow action nodes (ADR-0088 Phase 3):
 * `action.editor.{open,reveal,showDiff,readActive,applyEdit,saveAll}`.
 *
 * These let a workflow drive the editor the user is actually looking at —
 * surface a result, park a proposed change in the native diff view for review,
 * or read back what is focused — using the same agent channel the chat-side
 * agent tools use.
 *
 * **Addressing** mirrors `action.git.*` (`../source-control`): an explicit
 * `root` param, else the bound Pro IDE, else a throw naming the node. The rule
 * itself lives in `lib/codeserver/resolve-root` because agent tools, plan steps
 * and issue runs resolve the same way.
 *
 * **Starting** code-server is opt-in per node (`autoStart`), never implied by
 * addressing: the first `ensure` for a root can pull a several-hundred-megabyte
 * binary and raise a window, which is not something a step should do because it
 * happened to be pointed somewhere.
 *
 * No platform guard here — `requires: ["pro-ide"]` in the catalog makes the
 * runtime's capability preflight fail the whole run at t=0 with
 * `capability-missing:pro-ide`, which is a better failure than an executor
 * throwing halfway through a run that already had side effects.
 */

import { codeServerClient } from "@/lib/codeserver/client"
import { resolveProIdeRoot } from "@/lib/codeserver/resolve-root"
import { screenActiveEditorContext } from "@/lib/files/active-editor-screen"
import type { StepExecutionContext, WorkflowNodeKind } from "@/types/workflow/visual"
import { nonRetryable } from "../shared/executor-support"
import { registerNodeExecutor } from "../registry"

type Params = Record<string, unknown>

function strParam(params: Params, key: string): string | undefined {
  const v = params[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function intParam(params: Params, key: string): number | undefined {
  const v = params[key]
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined
}

/** A required string param, rejected non-retryably when absent. */
function requireStr(kind: WorkflowNodeKind, params: Params, key: string): string {
  const value = strParam(params, key)
  if (!value) throw nonRetryable(`${kind} requires a non-empty '${key}'`)
  return value
}

/**
 * Resolve the target root and, when the node opted in, make sure code-server is
 * actually up for it before the action runs.
 *
 * `resolveProIdeRoot` throws its own readable error; it is re-wrapped as
 * non-retryable because "no Pro IDE is bound" does not become true by retrying.
 */
async function resolveTarget(kind: WorkflowNodeKind, params: Params): Promise<string> {
  let root: string
  try {
    root = resolveProIdeRoot(kind, strParam(params, "root"))
  } catch (cause) {
    throw nonRetryable(cause instanceof Error ? cause.message : String(cause))
  }
  if (params.autoStart === true) await codeServerClient.ensure(root)
  return root
}

/**
 * Absolute path for a `path` param.
 *
 * The agent-channel commands all take absolute paths, while workflow authors
 * naturally write repo-relative ones. Joining here means both work, and matches
 * what the pane's own opener does (`joinProjectPath` in `code-server-pane`).
 */
function absolutePath(root: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path
  return `${root.replace(/[/\\]+$/, "")}/${path.replace(/^[/\\]+/, "")}`
}

registerNodeExecutor({
  kind: "action.editor.open",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const root = await resolveTarget("action.editor.open", ctx.params)
    const path = absolutePath(root, requireStr("action.editor.open", ctx.params, "path"))
    const line = intParam(ctx.params, "line")
    const column = intParam(ctx.params, "column")
    try {
      await codeServerClient.driveOpen(root, path, line, column)
    } catch {
      // The companion extension is not connected (workbench still booting, or
      // the side-load failed). The CLI path opens the same file without the
      // reveal fidelity — the same degradation the pane's own opener takes.
      await codeServerClient.openFile(root, path, line, column)
    }
    return { output: { root, path, line: line ?? null, column: column ?? null } }
  },
})

registerNodeExecutor({
  kind: "action.editor.reveal",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const root = await resolveTarget("action.editor.reveal", ctx.params)
    const path = absolutePath(root, requireStr("action.editor.reveal", ctx.params, "path"))
    await codeServerClient.reveal(root, path)
    return { output: { root, path } }
  },
})

registerNodeExecutor({
  kind: "action.editor.showDiff",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const root = await resolveTarget("action.editor.showDiff", ctx.params)
    const path = absolutePath(root, requireStr("action.editor.showDiff", ctx.params, "path"))
    // Deliberately not `requireStr`: an empty proposal is a meaningful diff
    // ("delete everything"), so only `undefined` is a param error.
    const content = ctx.params.content
    if (typeof content !== "string") {
      throw nonRetryable("action.editor.showDiff requires a string 'content'")
    }
    const title = strParam(ctx.params, "title")
    await codeServerClient.showDiff(root, path, content, title)
    return { output: { root, path, title: title ?? null, bytes: content.length } }
  },
})

registerNodeExecutor({
  kind: "action.editor.readActive",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const root = await resolveTarget("action.editor.readActive", ctx.params)
    const active = await codeServerClient.readActive(root)
    // Screened before it enters the run: node outputs flow into expressions,
    // downstream agent turns, and the persisted run log, so this is the same
    // boundary `read_active_editor` gates at — and the same policy module.
    const { hasNoLeakingPiiDeep } = await import("@cognia/redact")
    const screened = screenActiveEditorContext(active, hasNoLeakingPiiDeep)
    return { output: { root, ...screened } }
  },
})

registerNodeExecutor({
  kind: "action.editor.applyEdit",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const root = await resolveTarget("action.editor.applyEdit", ctx.params)
    const path = absolutePath(root, requireStr("action.editor.applyEdit", ctx.params, "path"))
    const line = intParam(ctx.params, "line")
    const column = intParam(ctx.params, "column")
    await codeServerClient.driveApplyEdit(root, path, line, column)
    return { output: { root, path, line: line ?? null, column: column ?? null } }
  },
})

registerNodeExecutor({
  kind: "action.editor.saveAll",
  typeVersion: 1,
  retryable: false,
  execute: async (ctx: StepExecutionContext) => {
    const root = await resolveTarget("action.editor.saveAll", ctx.params)
    const explicit = strParam(ctx.params, "path")
    const path = explicit ? absolutePath(root, explicit) : undefined
    const result = await codeServerClient.saveAll(root, path)
    // `failed` is data, not a step failure: a buffer that would not flush is
    // usually a read-only or externally-deleted file, and the workflow author
    // decides whether that matters by branching on it.
    return {
      output: { root, path: path ?? null, saved: result.saved, failed: result.failed },
      decision: result.failed.length === 0 ? "success" : "failure",
    }
  },
})
