/**
 * First-class editor tools (editor ⇄ agent).
 *
 * Surfaced to the agent as a plugin-manifest entry (same wire as the promoted
 * web tools) but resolved host-side in `plugin-tool-ipc`, because it needs the
 * renderer's project-editor bridge AND the PII gate (`@cognia/redact`) —
 * neither reachable from the pure `.mjs` sidecar. `build-options` appends
 * {@link buildEditorBuiltinManifestEntries} when a workspace filesystem backend
 * exists (desktop).
 *
 * **Engine-agnostic.** The read resolves through `project-editor-bridge`, so
 * whichever editor is mounted answers — Monaco assembles the snapshot from its
 * model/selection/markers, code-server from its companion extension. It used to
 * read code-server directly, which meant the tool was permanently unavailable
 * for every user who never switched to Pro IDE even though Monaco could have
 * answered. Keep the description below engine-neutral for the same reason.
 *
 * The payload deliberately excludes whole-file bodies — the agent reads files
 * with its own tools; this answers "what is the user looking at". It is PII-gated
 * at this boundary: when the gate trips, the text-bearing fields are withheld and
 * only the non-sensitive shape (selection range, open-editor count) survives.
 *
 * ## The write side (ADR-0088 Phase 3)
 *
 * `read_active_editor` was for a long time the agent's ONLY editor reach, which
 * left it able to see the editor but not act on it — while a *plugin* could do
 * both through `context.editor`. The five tools below close that asymmetry:
 * `open_in_editor`, `reveal_in_editor`, `show_editor_diff`, `apply_editor_edit`
 * and `save_editor_buffers`.
 *
 * **They are Pro-IDE-only, unlike the read.** The read resolves through
 * `project-editor-bridge` so whichever engine is mounted answers; the writes
 * need capabilities only the embedded code-server has (a native diff view, an
 * undo-able external-edit reflection, an explorer to reveal into), so they
 * address the bound Pro IDE via `resolveProIdeRoot` and degrade to a structured
 * `{ available: false }` when none is bound.
 *
 * **Consent is tiered, not uniform** — see `./permissions/editor-tool-rules`.
 * Four of the five only move the user's viewport or reflect a write that already
 * happened on disk; `save_editor_buffers` is the one that forces the user's own
 * unsaved edits to disk, so it is the one that asks.
 */

import type { ActiveEditorContext } from "@/lib/files/project-editor-bridge"
import { screenActiveEditorContext } from "@/lib/files/active-editor-screen"

export const READ_ACTIVE_EDITOR_TOOL_NAME = "read_active_editor"
export const OPEN_IN_EDITOR_TOOL_NAME = "open_in_editor"
export const REVEAL_IN_EDITOR_TOOL_NAME = "reveal_in_editor"
export const SHOW_EDITOR_DIFF_TOOL_NAME = "show_editor_diff"
export const APPLY_EDITOR_EDIT_TOOL_NAME = "apply_editor_edit"
export const SAVE_EDITOR_BUFFERS_TOOL_NAME = "save_editor_buffers"

/**
 * The Pro-IDE-only write tools, in the order they are surfaced to the model.
 * `read_active_editor` is deliberately absent: it is engine-agnostic and
 * available wherever any editor is mounted, so it does not share their gating.
 */
export const EDITOR_WRITE_TOOL_NAMES = [
  OPEN_IN_EDITOR_TOOL_NAME,
  REVEAL_IN_EDITOR_TOOL_NAME,
  SHOW_EDITOR_DIFF_TOOL_NAME,
  APPLY_EDITOR_EDIT_TOOL_NAME,
  SAVE_EDITOR_BUFFERS_TOOL_NAME,
] as const

export type EditorWriteToolName = (typeof EDITOR_WRITE_TOOL_NAMES)[number]

const EDITOR_WRITE_TOOL_SET: ReadonlySet<string> = new Set(EDITOR_WRITE_TOOL_NAMES)

/** Synthetic plugin id tagging the promoted editor built-in manifest entry. */
export const EDITOR_BUILTIN_PLUGIN_ID = "cognia-editor-builtin"

const READ_ACTIVE_EDITOR_SCHEMA = {
  type: "object",
  properties: {},
  required: [],
} as const

export interface EditorBuiltinManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

/**
 * Manifest entry for `read_active_editor`. Appended to `opts.pluginTools` by
 * `build-options` when a workspace filesystem backend is available.
 */
const PATH_PROPERTY = {
  type: "string",
  description: "File path. Absolute, or relative to the Pro IDE workspace root.",
} as const

const POSITION_PROPERTIES = {
  line: { type: "number", description: "Optional 1-based line to reveal." },
  column: { type: "number", description: "Optional 1-based column." },
} as const

/**
 * Manifest entries for the Pro-IDE-only write tools.
 *
 * Split from the read entry because they are appended under a different
 * condition: the read works with any mounted editor, these need code-server.
 */
export function buildEditorWriteManifestEntries(): EditorBuiltinManifestEntry[] {
  return [
    {
      name: OPEN_IN_EDITOR_TOOL_NAME,
      description:
        "Open a file in the user's embedded VS Code ('Pro IDE') and put the cursor on a line. Use this to show the user a file you are talking about instead of pasting it into the chat.",
      jsonSchema: {
        type: "object",
        properties: { path: PATH_PROPERTY, ...POSITION_PROPERTIES },
        required: ["path"],
      },
      pluginId: EDITOR_BUILTIN_PLUGIN_ID,
    },
    {
      name: REVEAL_IN_EDITOR_TOOL_NAME,
      description:
        "Reveal a path in the Pro IDE's file explorer without opening it. Use this to point the user at a directory or a file they should look at next.",
      jsonSchema: {
        type: "object",
        properties: { path: PATH_PROPERTY },
        required: ["path"],
      },
      pluginId: EDITOR_BUILTIN_PLUGIN_ID,
    },
    {
      name: SHOW_EDITOR_DIFF_TOOL_NAME,
      description:
        "Show proposed file contents beside the file on disk in the Pro IDE's native diff view, so the user can review a change before it is written. The proposal is held in memory and is NOT written to disk — write it with your file tools only after the user agrees.",
      jsonSchema: {
        type: "object",
        properties: {
          path: PATH_PROPERTY,
          content: {
            type: "string",
            description: "The full proposed contents of the file.",
          },
          title: { type: "string", description: "Optional label for the diff tab." },
        },
        required: ["path", "content"],
      },
      pluginId: EDITOR_BUILTIN_PLUGIN_ID,
    },
    {
      name: APPLY_EDITOR_EDIT_TOOL_NAME,
      description:
        "Reflect a file you have ALREADY written as an undo-able edit in the Pro IDE, instead of letting the editor reload it as an anonymous external change. Call this right after writing a file the user has open, so they can undo your change like their own.",
      jsonSchema: {
        type: "object",
        properties: { path: PATH_PROPERTY, ...POSITION_PROPERTIES },
        required: ["path"],
      },
      pluginId: EDITOR_BUILTIN_PLUGIN_ID,
    },
    {
      name: SAVE_EDITOR_BUFFERS_TOOL_NAME,
      description:
        "Flush the user's unsaved Pro IDE buffers to disk so your file tools read what the user is actually looking at. This writes the USER's pending edits, so it asks for confirmation. Narrow it to one file with 'path'.",
      jsonSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional. Only flush this file; omit to flush every dirty buffer.",
          },
        },
        required: [],
      },
      pluginId: EDITOR_BUILTIN_PLUGIN_ID,
    },
  ]
}

export function buildEditorBuiltinManifestEntries(): EditorBuiltinManifestEntry[] {
  return [
    {
      name: READ_ACTIVE_EDITOR_TOOL_NAME,
      description:
        "Read what the user is currently looking at in the project editor: the focused file, the selection (1-based) and selected text, that file's diagnostics, and the open editors. Works with either editor engine (the built-in editor or the embedded VS Code 'Pro IDE'). Returns { available: false } when no project editor is open for this session. Does not return whole-file contents — read files with your file tools.",
      jsonSchema: READ_ACTIVE_EDITOR_SCHEMA as unknown as Record<string, unknown>,
      pluginId: EDITOR_BUILTIN_PLUGIN_ID,
    },
  ]
}

/** Is this tool name one of the promoted editor built-ins? */
export function isEditorBuiltinTool(name: string): boolean {
  return name === READ_ACTIVE_EDITOR_TOOL_NAME || EDITOR_WRITE_TOOL_SET.has(name)
}

/** Is this tool name one of the Pro-IDE-only write tools? */
export function isEditorWriteTool(name: string): boolean {
  return EDITOR_WRITE_TOOL_SET.has(name)
}

export interface EditorToolRunDeps {
  /** Resolve the active project root for a chat session, or null when none. */
  resolveRoot: (sessionId: string) => Promise<string | null>
  /**
   * Read the live active-editor context for a root. Resolves to null when no
   * editor is mounted there; may still reject if the mounted engine's transport
   * fails (code-server's companion extension dropping, say), which is handled
   * the same way.
   */
  readActive: (root: string) => Promise<ActiveEditorContext | null>
  /** PII gate — returns true when `payload` is free of leaking PII. */
  gate: (payload: unknown) => boolean
  /**
   * Pro-IDE write side. Absent when code-server is not reachable at all (web,
   * mobile), which is exactly when the write tools are not surfaced either —
   * so a call arriving without these is a bug on the caller's side, reported as
   * an unavailable tool rather than a crash.
   */
  proIde?: EditorWriteDeps
}

/** The Pro-IDE-only half of the editor tool deps. */
export interface EditorWriteDeps {
  /**
   * Resolve the bound Pro IDE workspace, or null when none is bound.
   *
   * Not the session's project root: these tools act on what the user is
   * *looking at*, and a session root with no code-server behind it would only
   * turn a clear "no IDE is open" into an obscure transport error.
   */
  resolveProIdeRoot: () => string | null
  open: (root: string, path: string, line?: number, column?: number) => Promise<void>
  reveal: (root: string, path: string) => Promise<unknown>
  showDiff: (root: string, path: string, content: string, title?: string) => Promise<unknown>
  applyEdit: (root: string, path: string, line?: number, column?: number) => Promise<void>
  saveAll: (root: string, path?: string) => Promise<{ saved: string[]; failed: string[] }>
}

export interface EditorToolRunContext {
  sessionId: string
}

/**
 * Execute `read_active_editor` host-side. Resolves the session's project root,
 * reads the live editor context, and PII-gates it before returning. All the
 * failure modes degrade to a structured `{ available: false, reason }` the model
 * can read rather than throwing.
 */
export async function runEditorBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  deps: EditorToolRunDeps,
  ctx: EditorToolRunContext
): Promise<unknown> {
  if (isEditorWriteTool(name)) return runEditorWriteTool(name, args, deps)
  if (name !== READ_ACTIVE_EDITOR_TOOL_NAME) {
    return { available: false as const, error: `unknown editor tool: ${name}` }
  }

  const root = await deps.resolveRoot(ctx.sessionId)
  if (!root) {
    return { available: false as const, reason: "This session has no project workspace." }
  }

  let active: ActiveEditorContext | null
  try {
    active = await deps.readActive(root)
  } catch {
    // The mounted engine's transport failed — e.g. code-server's companion
    // extension is not connected yet. Same user-visible outcome as none.
    active = null
  }
  if (!active) {
    // No editor is mounted for this root at all: the workspace panel is closed,
    // or the session's project has no editor open.
    return {
      available: false as const,
      reason: "No project editor is open for this session.",
    }
  }

  // Shared with `action.editor.readActive` so the two cannot drift on what a
  // trip withholds; this tool only maps the verdict into its own wire shape.
  const screened = screenActiveEditorContext(active, deps.gate)
  if (screened.redacted) {
    return {
      available: true as const,
      redacted: true as const,
      reason: screened.reason,
      selection: screened.selection,
      openEditorCount: screened.openEditorCount,
    }
  }

  return { available: true as const, ...active }
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

/** A required string arg, reported to the model rather than thrown. */
function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

/** An optional 1-based position arg; anything else is treated as absent. */
function argPosition(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : undefined
}

/**
 * Absolutize a model-supplied path against the workspace root.
 *
 * Models write repo-relative paths far more often than absolute ones, while the
 * agent channel only accepts absolute — so joining here removes a whole class of
 * "file not found" turns. Mirrors `joinProjectPath` in `code-server-pane` and
 * the same helper in the `action.editor.*` executors.
 */
function absolutePath(root: string, path: string): string {
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return path
  return `${root.replace(/[/\\]+$/, "")}/${path.replace(/^[/\\]+/, "")}`
}

/**
 * Run one of the Pro-IDE-only write tools.
 *
 * Every failure is a structured `{ available: false, reason }` rather than a
 * throw, matching `read_active_editor`: the model can read a reason and adapt
 * (paste the code into chat instead of opening it), whereas a thrown tool error
 * mostly just derails the turn.
 */
async function runEditorWriteTool(
  name: string,
  args: Record<string, unknown>,
  deps: EditorToolRunDeps
): Promise<unknown> {
  const proIde = deps.proIde
  if (!proIde) {
    return {
      available: false as const,
      reason: "The embedded Pro IDE is not available on this device.",
    }
  }
  const root = proIde.resolveProIdeRoot()
  if (!root) {
    return {
      available: false as const,
      reason:
        "No Pro IDE workspace is open, so there is no editor to drive. " +
        "Show the user the content in your reply instead.",
    }
  }

  // Every write tool but saveAll needs a path; check once, up front, so a
  // missing one never reaches the backend as an empty string.
  const rawPath = argString(args, "path")
  if (!rawPath && name !== SAVE_EDITOR_BUFFERS_TOOL_NAME) {
    return { available: false as const, reason: `${name} requires a non-empty "path".` }
  }
  const path = rawPath ? absolutePath(root, rawPath) : undefined

  try {
    switch (name) {
      case OPEN_IN_EDITOR_TOOL_NAME: {
        await proIde.open(root, path!, argPosition(args, "line"), argPosition(args, "column"))
        return { available: true as const, opened: path }
      }
      case REVEAL_IN_EDITOR_TOOL_NAME: {
        await proIde.reveal(root, path!)
        return { available: true as const, revealed: path }
      }
      case SHOW_EDITOR_DIFF_TOOL_NAME: {
        // Absent is an error; empty is a legitimate proposal ("empty this file").
        const content = args.content
        if (typeof content !== "string") {
          return {
            available: false as const,
            reason: `${name} requires a string "content" — the full proposed file.`,
          }
        }
        await proIde.showDiff(root, path!, content, argString(args, "title"))
        return {
          available: true as const,
          shown: path,
          // Told explicitly because the model's next instinct is to assume the
          // change landed and move on.
          note: "The diff is shown for review only. Nothing was written to disk.",
        }
      }
      case APPLY_EDITOR_EDIT_TOOL_NAME: {
        await proIde.applyEdit(root, path!, argPosition(args, "line"), argPosition(args, "column"))
        return { available: true as const, reflected: path }
      }
      case SAVE_EDITOR_BUFFERS_TOOL_NAME: {
        const result = await proIde.saveAll(root, path)
        return { available: true as const, saved: result.saved, failed: result.failed }
      }
      default:
        return { available: false as const, error: `unknown editor tool: ${name}` }
    }
  } catch (cause) {
    // The companion extension is not connected, or the workbench rejected it.
    return {
      available: false as const,
      reason: `The Pro IDE did not accept this: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }
}
