/**
 * First-class `read_active_editor` tool (editor → agent).
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
 */

import type { ActiveEditorContext } from "@/lib/files/project-editor-bridge"

export const READ_ACTIVE_EDITOR_TOOL_NAME = "read_active_editor"

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

/** Is this tool name the promoted editor built-in? */
export function isEditorBuiltinTool(name: string): boolean {
  return name === READ_ACTIVE_EDITOR_TOOL_NAME
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
  _args: Record<string, unknown>,
  deps: EditorToolRunDeps,
  ctx: EditorToolRunContext
): Promise<unknown> {
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

  if (!deps.gate(active)) {
    // Withhold the text-bearing fields; keep the non-sensitive shape so the model
    // still knows an editor is focused and how many files are open.
    return {
      available: true as const,
      redacted: true as const,
      reason:
        "The editor context was withheld because it may contain PII (emails, keys, IPs, cards, …).",
      selection: active.selection,
      openEditorCount: active.openEditors.length,
    }
  }

  return { available: true as const, ...active }
}
