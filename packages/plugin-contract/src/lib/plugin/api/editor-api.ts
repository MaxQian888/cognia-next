/**
 * The plugin contract's share of `lib/plugin/api/editor-api.ts`, which re-exports these.
 */
import type { ActiveEditorContext } from "../../files/project-editor-bridge"

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
   * Flush the editor's unsaved buffers to disk, returning the absolute paths it
   * could not save (empty means disk is now trustworthy). Requires `editor:write`.
   *
   * Call this before reading project files: the plugin filesystem API — like the
   * agent's own tools — reads disk, so a buffer the user edited but never saved is
   * invisible to it, and a subsequent write would clobber that work.
   */
  saveDirty: () => Promise<string[]>
  /**
   * Show `content` against the on-disk `absolutePath` as a diff, so the user can
   * review a proposed change before the plugin writes it. Requires `editor:write`.
   * Returns false when the mounted engine has no diff surface, so the caller can
   * decide between writing directly and doing nothing.
   */
  showDiff: (absolutePath: string, content: string, title?: string) => Promise<boolean>
  /**
   * Reveal `absolutePath` in the editor's file tree without opening it. Requires
   * `editor:write` (it moves the user's view). False when no editor can.
   */
  revealInExplorer: (absolutePath: string) => Promise<boolean>
  /**
   * Run `command` in the editor's own terminal, visible to the user. Requires
   * `terminal:write`, because writing a command to a terminal is arbitrary shell
   * execution. `cwd` defaults to `root` and must remain inside it. Output is
   * deliberately not readable back — this is "show the user this running", not
   * a shell API; plugins with `process` permission have one of those already.
   */
  runInTerminal: (
    root: string,
    command: string,
    options?: { cwd?: string; name?: string }
  ) => Promise<boolean>
  /**
   * Surface a message inside the editor. Requires `editor:write` — it puts plugin
   * text in front of the user. False when no editor can show one.
   */
  notify: (message: string, kind?: "info" | "warning" | "error") => Promise<boolean>
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
