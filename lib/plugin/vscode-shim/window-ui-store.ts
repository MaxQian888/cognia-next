/**
 * What VS Code extensions currently show in Cognia's window: open quick
 * inputs, status bar items and messages, and running progress.
 *
 * The extension host owns these objects; `window-handlers.ts` mirrors their
 * reported state here, and the components under `components/plugins/vscode/`
 * read it through {@link useVscodeWindowState}-style subscriptions. Plain
 * module state with a revision counter, so a component re-renders when
 * anything it might read changes and tests can read it directly.
 */

export interface QuickInputButtonState {
  /** A codicon id (`ThemeIcon`), when the button has one. */
  icon?: string
  tooltip?: string
}

export interface QuickPickItemState {
  label: string
  separator?: boolean
  description?: string
  detail?: string
  alwaysShow?: boolean
  icon?: string
  buttons?: QuickInputButtonState[]
}

export interface QuickInputState {
  title?: string
  step?: number
  totalSteps?: number
  enabled?: boolean
  busy?: boolean
  ignoreFocusOut?: boolean
  value?: string
  placeholder?: string
  buttons?: QuickInputButtonState[]
  // Pick only.
  items?: QuickPickItemState[]
  activeIndices?: number[]
  selectedIndices?: number[]
  canSelectMany?: boolean
  matchOnDescription?: boolean
  matchOnDetail?: boolean
  keepScrollPosition?: boolean
  sortByLabel?: boolean
  // Input only.
  valueSelection?: [number, number]
  password?: boolean
  prompt?: string
  /** `severity`: 1 info, 2 warning, 3 error (`InputBoxValidationSeverity`). */
  validationMessage?: { message: string; severity: number }
}

export interface QuickInputSession {
  sessionId: string
  pluginId: string
  kind: "pick" | "input"
  state: QuickInputState
}

export interface StatusBarItemState {
  id: string
  /** `StatusBarAlignment`: 1 left, 2 right. */
  alignment: number
  priority?: number
  visible: boolean
  text: string
  name?: string
  tooltip?: string
  /** A CSS color, or `theme:<id>` for a `ThemeColor`. */
  color?: string
  backgroundColor?: string
  command?: { command: string; arguments?: unknown[] }
  ariaLabel?: string
}

export interface ProgressState {
  handle: string
  pluginId: string
  location: "notification" | "statusBar"
  title?: string
  message?: string
  /** Sum of the reported increments, 0–100; `undefined` until one is reported. */
  percent?: number
  cancellable: boolean
}

const quickInputs = new Map<string, QuickInputSession>()
/** plugin → item id → state. */
const statusItems = new Map<string, Map<string, StatusBarItemState>>()
/** plugin → handle → text, oldest first. */
const statusMessages = new Map<string, Map<string, string>>()
const progress = new Map<string, ProgressState>()
const listeners = new Set<() => void>()
let revision = 0

function changed(): void {
  revision += 1
  for (const listener of listeners) listener()
}

export function subscribeVscodeWindow(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getVscodeWindowRevision(): number {
  return revision
}

// ── Quick input ─────────────────────────────────────────────────────────

export function openQuickInputSession(session: QuickInputSession): void {
  quickInputs.set(session.sessionId, session)
  changed()
}

export function updateQuickInputSession(sessionId: string, state: QuickInputState): boolean {
  const session = quickInputs.get(sessionId)
  if (!session) return false
  quickInputs.set(sessionId, { ...session, state: { ...session.state, ...state } })
  changed()
  return true
}

export function closeQuickInputSession(sessionId: string): QuickInputSession | undefined {
  const session = quickInputs.get(sessionId)
  if (!session) return undefined
  quickInputs.delete(sessionId)
  changed()
  return session
}

export function getQuickInputSession(sessionId: string): QuickInputSession | undefined {
  return quickInputs.get(sessionId)
}

// ── Status bar ──────────────────────────────────────────────────────────

export function setStatusBarItem(
  pluginId: string,
  itemId: string,
  state: StatusBarItemState
): void {
  let items = statusItems.get(pluginId)
  if (!items) statusItems.set(pluginId, (items = new Map()))
  items.set(itemId, state)
  changed()
}

export function removeStatusBarItem(pluginId: string, itemId: string): void {
  if (statusItems.get(pluginId)?.delete(itemId)) changed()
}

export function setStatusBarMessage(pluginId: string, handle: string, text: string): void {
  let messages = statusMessages.get(pluginId)
  if (!messages) statusMessages.set(pluginId, (messages = new Map()))
  messages.set(handle, text)
  changed()
}

export function clearStatusBarMessage(pluginId: string, handle: string): void {
  if (statusMessages.get(pluginId)?.delete(handle)) changed()
}

/**
 * What a plugin shows on one side of the status bar, in VS Code's order:
 * higher priority further left on the left side and further right on the
 * right side, i.e. first here. The newest status message leads the left side.
 */
export function statusBarEntries(
  pluginId: string,
  alignment: 1 | 2
): Array<
  | { key: string; kind: "item"; item: StatusBarItemState }
  | { key: string; kind: "message"; text: string }
  | { key: string; kind: "progress"; progress: ProgressState }
> {
  const entries: ReturnType<typeof statusBarEntries> = []
  if (alignment === 1) {
    const messages = [...(statusMessages.get(pluginId) ?? new Map<string, string>())]
    const newest = messages.at(-1)
    if (newest) entries.push({ key: `message:${newest[0]}`, kind: "message", text: newest[1] })
    for (const state of progress.values()) {
      if (state.pluginId === pluginId && state.location === "statusBar") {
        entries.push({ key: `progress:${state.handle}`, kind: "progress", progress: state })
      }
    }
  }
  const items = [...(statusItems.get(pluginId) ?? new Map<string, StatusBarItemState>())]
    .filter(([, item]) => item.visible && item.alignment === alignment)
    .sort(([, a], [, b]) => (b.priority ?? 0) - (a.priority ?? 0))
  for (const [itemId, item] of items) entries.push({ key: `item:${itemId}`, kind: "item", item })
  return entries
}

/** The plugins with anything to show in the status bar. */
export function pluginsWithStatusBarEntries(): string[] {
  const plugins = new Set<string>()
  for (const [pluginId, items] of statusItems) {
    if ([...items.values()].some((item) => item.visible)) plugins.add(pluginId)
  }
  for (const [pluginId, messages] of statusMessages) if (messages.size > 0) plugins.add(pluginId)
  for (const state of progress.values())
    if (state.location === "statusBar") plugins.add(state.pluginId)
  return [...plugins]
}

// ── Progress ────────────────────────────────────────────────────────────

export function startProgress(state: ProgressState): void {
  progress.set(state.handle, state)
  changed()
}

export function reportProgress(
  handle: string,
  report: { message?: string; increment?: number }
): void {
  const state = progress.get(handle)
  if (!state) return
  progress.set(handle, {
    ...state,
    ...(report.message !== undefined ? { message: report.message } : {}),
    ...(typeof report.increment === "number"
      ? { percent: Math.min(100, Math.max(0, (state.percent ?? 0) + report.increment)) }
      : {}),
  })
  changed()
}

export function endProgress(handle: string): ProgressState | undefined {
  const state = progress.get(handle)
  if (!state) return undefined
  progress.delete(handle)
  changed()
  return state
}

export function getProgress(handle: string): ProgressState | undefined {
  return progress.get(handle)
}

// ── Lifecycle ───────────────────────────────────────────────────────────

/** Everything a plugin showed, removed when its host stops. Returns the closed quick inputs. */
export function clearVscodeWindowForPlugin(pluginId: string): {
  quickInputs: QuickInputSession[]
  progress: ProgressState[]
} {
  const closedInputs = [...quickInputs.values()].filter((session) => session.pluginId === pluginId)
  for (const session of closedInputs) quickInputs.delete(session.sessionId)
  const endedProgress = [...progress.values()].filter((state) => state.pluginId === pluginId)
  for (const state of endedProgress) progress.delete(state.handle)
  statusItems.delete(pluginId)
  statusMessages.delete(pluginId)
  changed()
  return { quickInputs: closedInputs, progress: endedProgress }
}

/**
 * VS Code's quick pick filter: every query character appears in order in the
 * label (or, when enabled, the description or detail), case-insensitively.
 * `alwaysShow` items stay, a separator stays only if an item below it does,
 * and matches on the label come before matches elsewhere when `sortByLabel`.
 */
export function filterQuickPickItems(
  items: QuickPickItemState[],
  query: string,
  options: { matchOnDescription?: boolean; matchOnDetail?: boolean; sortByLabel?: boolean } = {}
): number[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return items.map((_, index) => index)
  const matches = (text: string | undefined) => {
    if (!text) return false
    const haystack = text.toLowerCase()
    let at = 0
    for (const char of needle) {
      if (char === " ") continue
      at = haystack.indexOf(char, at)
      if (at === -1) return false
      at += 1
    }
    return true
  }
  const scored: Array<{ index: number; byLabel: boolean }> = []
  items.forEach((item, index) => {
    if (item.separator) return
    const byLabel = matches(item.label)
    if (
      byLabel ||
      item.alwaysShow ||
      (options.matchOnDescription && matches(item.description)) ||
      (options.matchOnDetail && matches(item.detail))
    ) {
      scored.push({ index, byLabel })
    }
  })
  if (options.sortByLabel !== false) {
    // Stable: label matches first, each group in the extension's order.
    scored.sort((a, b) => Number(b.byLabel) - Number(a.byLabel) || a.index - b.index)
    return scored.map((entry) => entry.index)
  }
  // Keep separators that head at least one visible item, in list order.
  const visible = new Set(scored.map((entry) => entry.index))
  const out: number[] = []
  let pendingSeparator: number | undefined
  items.forEach((item, index) => {
    if (item.separator) {
      pendingSeparator = index
    } else if (visible.has(index)) {
      if (pendingSeparator !== undefined) out.push(pendingSeparator)
      pendingSeparator = undefined
      out.push(index)
    }
  })
  return out
}

export function __resetVscodeWindowForTesting(): void {
  quickInputs.clear()
  statusItems.clear()
  statusMessages.clear()
  progress.clear()
  listeners.clear()
  revision = 0
}
