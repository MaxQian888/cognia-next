/**
 * Surface-aware Monaco editor action registry — the shared engine behind
 * every cognia editor surface (canvas / skill / artifact / project `file`).
 *
 * A single `editor.addAction({ …, contextMenuGroupId })` call registers an
 * action into BOTH the right-click context menu AND the F1 command palette,
 * so this one mechanism keeps menus, palette, and keybindings in lockstep and
 * "conforming to the system":
 *   - labels are supplied pre-localized by the calling React layer (next-intl
 *     `useTranslations` is only available there),
 *   - keybindings come from the user's keybinding store via `keyComboToMonaco`,
 *   - plugin `contributes.commands` (the command registry) are surfaced into
 *     the F1 palette (NOT the context menu — there is no `editor/context`
 *     menu contribution processor, so injecting arbitrary plugin commands into
 *     the right-click menu would be wrong).
 *
 * Each surface passes its own `actions` array (closures over that surface's
 * handlers), so this module carries no surface-specific behavior.
 */

import { keyComboToMonaco } from "@/lib/canvas/keybinding-monaco"
import { getCommand, getCommands, executeCommand } from "@/lib/plugin/commands/registry"

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Monaco is dynamic-imported.
type MonacoNamespace = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MonacoEditor = any

export interface EditorActionDisposable {
  dispose: () => void
}

export interface EditorActionDef {
  /** Logical id; also the key looked up in the bindings map. */
  id: string
  /** Fallback label when `opts.labels[id]` is absent. */
  label?: string
  /** Built-in Monaco command id to `editor.trigger` when the action runs. */
  monacoCommand?: string
  /** Custom run — overrides `monacoCommand`. */
  run?: (editor: MonacoEditor) => void
  /** Right-click context-menu group. Omit to keep the action out of the menu. */
  contextMenuGroupId?: string
  /** Order within the context-menu group. */
  contextMenuOrder?: number
  /**
   * When true the action is registered even without a resolvable keybinding
   * (it still appears in the menu / palette, just without a shortcut). When
   * false (the canvas model) an action with no resolvable binding is skipped.
   */
  alwaysAvailable?: boolean
}

export interface RegisterEditorActionsOptions {
  /** Produced Monaco action id = `${idPrefix}${def.id}`. */
  idPrefix: string
  /** Localized `actionId → label`. Falls back to `def.label`, then `def.id`. */
  labels?: Record<string, string>
  /** `actionId → user keybinding combo` (e.g. "Ctrl+Shift+P"). */
  bindings: Record<string, string>
  /** This surface's action set. */
  actions: EditorActionDef[]
  /** `source` label handed to `editor.trigger`. */
  triggerSource?: string
  /** Also surface non-internal plugin commands into the F1 palette. */
  includePluginCommands?: boolean
}

/**
 * Register a surface's actions on a live Monaco editor. Returns the
 * disposables (empty when the editor/monaco pair can't register actions).
 */
export function registerEditorActions(
  editor: MonacoEditor,
  monaco: MonacoNamespace,
  opts: RegisterEditorActionsOptions
): EditorActionDisposable[] {
  if (!editor?.addAction || !monaco) return []
  const disposables: EditorActionDisposable[] = []
  const source = opts.triggerSource ?? "editor-action"

  for (const def of opts.actions) {
    const combo = opts.bindings[def.id]
    let keybindings: number[] = []
    if (combo) {
      const kb = keyComboToMonaco(combo, monaco)
      if (kb === null) {
        // Unresolvable combo: skip unless the action is always available.
        if (!def.alwaysAvailable) continue
      } else {
        keybindings = [kb]
      }
    } else if (!def.alwaysAvailable) {
      // No binding and not always-available → nothing to register.
      continue
    }

    const run = def.run ?? ((ed: MonacoEditor) => ed.trigger?.(source, def.monacoCommand, null))
    const label = opts.labels?.[def.id] ?? def.label ?? def.id
    const disposable = editor.addAction({
      id: `${opts.idPrefix}${def.id}`,
      label,
      keybindings,
      contextMenuGroupId: def.contextMenuGroupId,
      contextMenuOrder: def.contextMenuOrder,
      run,
    })
    if (disposable?.dispose) disposables.push(disposable)
  }

  if (opts.includePluginCommands) {
    disposables.push(...registerPluginCommandActions(editor))
  }

  return disposables
}

/**
 * Register every non-internal, plugin-owned command as an F1 palette action
 * (no keybinding, no context-menu group). Cognia-native commands (pluginId
 * === null) are excluded — the editor already exposes its own actions and the
 * built-in Monaco commands.
 */
function registerPluginCommandActions(editor: MonacoEditor): EditorActionDisposable[] {
  const disposables: EditorActionDisposable[] = []
  for (const id of getCommands(true)) {
    const cmd = getCommand(id)
    if (!cmd || cmd.pluginId == null) continue
    const base = cmd.title ?? id
    const label = cmd.category ? `${cmd.category}: ${base}` : base
    const disposable = editor.addAction({
      id: `plugin.cmd.${id}`,
      label,
      keybindings: [],
      run: () => {
        void executeCommand(id).catch(() => {
          /* command handlers surface their own errors */
        })
      },
    })
    if (disposable?.dispose) disposables.push(disposable)
  }
  return disposables
}
