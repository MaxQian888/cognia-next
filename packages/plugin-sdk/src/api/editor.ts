/**
 * Public contract for `ctx.editor` — the live project editor.
 *
 * Engine-agnostic: the built-in Monaco workbench and the embedded code-server
 * "Pro IDE" both answer these calls, and a plugin cannot tell which is mounted.
 * Gated by `editor:read` / `editor:write`, re-checked on every call.
 */

export type {
  PluginActiveEditorContext,
  PluginEditorAPI,
  PluginEditorOpenOptions,
  PluginEditorOpenResult,
} from "@/lib/plugin/api/editor-api"

/** The snapshot shape `readActive` resolves to, shared with the host. */
export type { ActiveEditorContext, ActiveEditorDiagnostic } from "@/lib/files/project-editor-bridge"
