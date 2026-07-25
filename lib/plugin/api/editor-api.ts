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
 * Permissions (`editor:read` / `editor:write`) are re-checked on every call, the
 * same rule the rest of `lib/plugin/api` follows: a grant revoked mid-session
 * must take effect immediately, not at the next reload.
 */

import {
  deferProjectEditorOpen,
  notifyActiveEditorChanged,
  openInProjectEditor,
  readActiveFromProjectEditor,
  reflectEditInProjectEditor,
  subscribeActiveEditor,
  type ActiveEditorContext,
} from "@/lib/files/project-editor-bridge"

export interface PluginEditorOpenOptions {
  /** 1-based line to reveal. */
  line?: number
  /** 1-based column to reveal. */
  column?: number
  /**
   * Bring the project editor forward when none is mounted, instead of only
   * queueing the open for whenever one appears.
   *
   * Off by default on purpose: a plugin that can silently take over the user's
   * right rail will, and the surface it would displace is whatever the user was
   * actually looking at. Opting in is the plugin stating the jump *is* the
   * point (a "go to definition" affordance, say).
   */
  reveal?: boolean
}

/**
 * What actually happened, so a plugin can tell "the user is now looking at it"
 * from "they will be, eventually". Without this the three outcomes are
 * indistinguishable and plugins guess.
 */
export type PluginEditorOpenResult =
  /** An editor was mounted and has opened the file. */
  | "opened"
  /** No editor was mounted; the open is queued for the next one to mount. */
  | "deferred"
  /** No editor was mounted; one was requested and the open is queued for it. */
  | "revealing"

export interface PluginEditorAPI {
  /**
   * Open `absolutePath` in the live project editor. Requires `editor:write`.
   *
   * The path must be absolute — a plugin has no reliable notion of "the current
   * project root", and a relative path would resolve against whichever editor
   * happened to mount last.
   */
  openFile: (
    absolutePath: string,
    options?: PluginEditorOpenOptions
  ) => Promise<PluginEditorOpenResult>
  /**
   * Reflect a file this plugin just wrote to disk as an undo-able in-editor
   * edit rather than a plain open. Requires `editor:write`. Returns false when
   * no editor is rooted at that path — unlike `openFile` this never queues,
   * because a reflect that lands minutes later would reflect stale content.
   */
  reflectEdit: (absolutePath: string, options?: PluginEditorOpenOptions) => Promise<boolean>
  /**
   * Read what the user is currently looking at: focused file, 1-based
   * selection and its text, that file's diagnostics, and the open editors.
   * Requires `editor:read`.
   *
   * PII-screened at this boundary with the same gate the agent tool uses. When
   * it trips the text-bearing fields are withheld and the non-sensitive shape
   * survives, so a plugin can still tell an editor is focused.
   *
   * Returns null when no editor is mounted. Never returns whole file bodies —
   * read files through the filesystem API for that.
   */
  readActive: () => Promise<PluginActiveEditorContext | null>
  /**
   * Fires when the mounted editors change, and whenever a mounted editor
   * reports the user moved. Re-read with `readActive`; the event carries no
   * payload so it can never hand out an un-screened snapshot.
   *
   * Requires `editor:read` — a listener registered without it never fires,
   * rather than firing with nothing, so a plugin cannot use the event itself as
   * an oracle for editor activity it is not allowed to see.
   */
  onDidChangeActiveEditor: (listener: () => void) => () => void
}

/**
 * `ActiveEditorContext` as a plugin sees it: identical, plus a `redacted` flag
 * set when the PII gate withheld the text-bearing fields.
 */
export type PluginActiveEditorContext = ActiveEditorContext & { redacted?: true }

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
