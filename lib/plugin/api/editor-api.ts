/**
 * `ctx.editor` — the plugin-facing project-editor API.
 *
 * Engine-agnostic by construction: every call routes through
 * `lib/files/project-editor-bridge`, so whichever editor is mounted (the
 * built-in Monaco workbench or the embedded code-server "Pro IDE") answers.
 * Plugins never learn which, and never learn project roots they were not
 * already given.
 *
 * This closes a real asymmetry — first-party code could already open files,
 * reflect agent edits, and read the active editor (`lib/claude/editor-builtin-tools.ts`),
 * while `lib/plugin/api/` had no editor surface at all.
 *
 * Permissions (`editor:read` / `editor:write`, plus `terminal:write` for shell
 * commands) are re-checked on every call, the same rule the rest of
 * `lib/plugin/api` follows: a grant revoked mid-session must take effect
 * immediately, not at the next reload.
 */

import { checkFileAccess, normalizeFsPath } from "@/lib/files/permissions"
import {
  deferProjectEditorOpen,
  flushProjectEditorEdits,
  notifyActiveEditorChanged,
  notifyInProjectEditor,
  openInProjectEditor,
  readActiveFromProjectEditor,
  reflectEditInProjectEditor,
  revealInProjectEditor,
  runInProjectEditorTerminal,
  showDiffInProjectEditor,
  subscribeActiveEditor,
  type ActiveEditorContext,
} from "@/lib/files/project-editor-bridge"
import type {
  PluginActiveEditorContext,
  PluginEditorAPI,
} from "@cognia/plugin-contract/lib/plugin/api/editor-api"
export type {
  PluginActiveEditorContext,
  PluginEditorAPI,
  PluginEditorOpenOptions,
  PluginEditorOpenResult,
} from "@cognia/plugin-contract/lib/plugin/api/editor-api"

/** PII gate — injected so this module stays unit-testable without `@cognia/redact`. */
export type EditorPiiGate = (payload: unknown) => boolean

let piiGateOverride: EditorPiiGate | null = null

/** Test seam: replace the PII gate. Pass null to restore the real one. */
export function __setEditorPiiGateForTesting(gate: EditorPiiGate | null): void {
  piiGateOverride = gate
}

async function screen(context: ActiveEditorContext): Promise<PluginActiveEditorContext> {
  // Bound before the await: TypeScript discards the narrowing of a mutable
  // module-level binding across one, so `piiGateOverride ?? await …` reads as
  // possibly-null again on the other side.
  const override = piiGateOverride
  const gate: EditorPiiGate =
    override ?? (await import("@cognia/redact").then((m) => m.hasNoLeakingPiiDeep))
  if (gate(context)) return context
  // Withhold everything that can carry text; keep the shape so a plugin can
  // still see that an editor is focused and how much is open. Mirrors
  // `runEditorBuiltinTool`'s redaction so the two boundaries agree.
  return {
    path: null,
    selection: context.selection,
    selectedText: null,
    diagnostics: [],
    openEditors: [],
    redacted: true,
  }
}

function isAbsoluteFsPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path)
}

function confineTerminalOptions(
  root: string,
  options: { cwd?: string; name?: string } | undefined
): { root: string; options: { cwd: string; name?: string } } {
  const normalizedRoot = normalizeFsPath(root)
  const cwd = normalizeFsPath(options?.cwd ?? root)
  if (!isAbsoluteFsPath(normalizedRoot) || !isAbsoluteFsPath(cwd)) {
    throw new Error("Terminal root and cwd must be absolute filesystem paths")
  }
  const decision = checkFileAccess(cwd, "list", { allowedRoots: [normalizedRoot] })
  if (!decision.allowed) {
    throw new Error(`Terminal cwd must remain inside the project root "${normalizedRoot}"`)
  }
  return { root: normalizedRoot, options: { cwd, name: options?.name } }
}

export function createEditorAPI(
  pluginId: string,
  hasPermission: (permission: string) => boolean
): PluginEditorAPI {
  const requireWrite = (method: string) => {
    if (!hasPermission("editor:write")) {
      throw new Error(
        `Plugin "${pluginId}" lacks the "editor:write" permission required by "${method}"`
      )
    }
  }

  return {
    async openFile(absolutePath, options = {}) {
      requireWrite("openFile")
      const { line, column, reveal } = options
      if (openInProjectEditor(absolutePath, line, column)) return "opened"

      // Nothing mounted. Queue it either way — the bridge replays a pending
      // open at the next registration, so the file still lands once an editor
      // appears, whether the plugin asked to summon one or the user opens one.
      deferProjectEditorOpen(absolutePath, line, column)
      if (!reveal) return "deferred"

      // Bring the workspace panel forward rather than driving the dock
      // directly: the reveal intent is the one-shot channel the mounted
      // workbench already consumes, and it works on the mobile sheet too.
      const { useArtifactDockLayoutStore } =
        await import("@/stores/artifact/artifact-dock-layout-store")
      useArtifactDockLayoutStore.getState().requestReveal({ panelId: "workspace", mode: "wide" })
      return "revealing"
    },

    async reflectEdit(absolutePath, options = {}) {
      requireWrite("reflectEdit")
      return reflectEditInProjectEditor(absolutePath, options.line, options.column)
    },

    async saveDirty() {
      requireWrite("saveDirty")
      return flushProjectEditorEdits()
    },

    async showDiff(absolutePath, content, title) {
      requireWrite("showDiff")
      return showDiffInProjectEditor(absolutePath, content, title)
    },

    async revealInExplorer(absolutePath) {
      requireWrite("revealInExplorer")
      return revealInProjectEditor(absolutePath)
    },

    async runInTerminal(root, command, options) {
      if (!hasPermission("terminal:write")) {
        throw new Error(
          `Plugin "${pluginId}" lacks the "terminal:write" permission required by "runInTerminal"`
        )
      }
      const confined = confineTerminalOptions(root, options)
      return runInProjectEditorTerminal(confined.root, command, confined.options)
    },

    async notify(message, kind) {
      requireWrite("notify")
      return notifyInProjectEditor(message, kind)
    },

    async readActive() {
      if (!hasPermission("editor:read")) {
        throw new Error(
          `Plugin "${pluginId}" lacks the "editor:read" permission required by "readActive"`
        )
      }
      let context: ActiveEditorContext | null
      try {
        context = await readActiveFromProjectEditor()
      } catch {
        // The mounted engine's transport failed (code-server's companion
        // extension dropping, say). Same outcome as no editor: plugins get a
        // null, never a rejection they have to special-case.
        return null
      }
      return context ? screen(context) : null
    },

    onDidChangeActiveEditor(listener) {
      return subscribeActiveEditor(() => {
        // Re-checked per fire, not once at subscribe: a revoked grant has to
        // stop the stream immediately.
        if (hasPermission("editor:read")) listener()
      })
    },
  }
}

/**
 * Re-exported so a host surface that changes the active editor can announce it
 * without importing the bridge directly.
 */
export { notifyActiveEditorChanged }
