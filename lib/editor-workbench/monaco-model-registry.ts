/**
 * Monaco model lifetime registry — owns *when a model dies*, nothing else.
 *
 * Why this exists
 * ---------------
 * `mountMonacoWorkbench` deliberately does not dispose models so they survive
 * editor remounts ("models can be reused across remounts"). That promise was
 * silently defeated in the project editor: `<Editor>` from
 * `@monaco-editor/react` disposes the current model on unmount unless
 * `keepCurrentModel` is set, and the project editor both omitted that prop and
 * forced a remount per file with `key={absolutePath}`. Every tab switch
 * therefore destroyed the `ITextModel` — and with it the undo/redo stack, the
 * folding state, and the LSP document at that URI.
 *
 * Turning `keepCurrentModel` on fixes the destruction but replaces it with a
 * leak: nothing would ever dispose a model again. This registry is the missing
 * owner. It refcounts by URI on *document* lifetime (a file being open in the
 * editor), never on *editor mount* lifetime — that distinction is the whole
 * point. A tab switch unmounts nothing and changes no count; closing the file
 * is what releases it.
 *
 * Refcounting rather than a boolean because the unified dock lets the same file
 * be open in several panels at once; the model must outlive the first panel
 * that closes it.
 *
 * Scope: lifetime only. View state (cursor, scroll, folding) stays with
 * `@monaco-editor/react`'s own `saveViewState` + `path` handling while there is
 * exactly one `<Editor>` per surface. A second concurrent editor over the same
 * URI needs a view-state owner here too — add it then, with the panel that
 * needs it, not before.
 */

/** The slice of a monaco `ITextModel` this registry needs. */
export interface RegistryTextModel {
  isDisposed(): boolean
  dispose(): void
}

/** The slice of the monaco namespace this registry needs. */
export interface ModelRegistryMonaco {
  Uri: { parse(value: string): unknown }
  editor: { getModel(uri: never): RegistryTextModel | null }
}

interface RegistryState {
  monaco: ModelRegistryMonaco | null
  /** uri → number of open documents holding it. Entries at 0 are removed. */
  retained: Map<string, number>
  /** URIs released to zero before any monaco namespace was available. */
  pendingDisposal: Set<string>
}

const state: RegistryState = {
  monaco: null,
  retained: new Map(),
  pendingDisposal: new Set(),
}

/**
 * Hand the registry a live monaco namespace. Called by the first editor to
 * mount; safe to call repeatedly. Flushes any disposal that was requested
 * while no namespace was bound (a file closed before an editor ever mounted).
 */
export function bindMonacoModelRegistry(monaco: ModelRegistryMonaco): void {
  state.monaco = monaco
  if (state.pendingDisposal.size === 0) return
  const pending = [...state.pendingDisposal]
  state.pendingDisposal.clear()
  for (const uri of pending) disposeModelNow(uri)
}

/** The bound namespace, or `null` before any editor has mounted. */
export function getMonacoModelRegistryNamespace(): ModelRegistryMonaco | null {
  return state.monaco
}

/**
 * Declare that one more open document needs the model at `uri`. Does not touch
 * monaco — the model itself is created lazily by whichever editor addresses the
 * URI first (`<Editor path>` / `mountMonacoWorkbench`).
 */
export function retainModel(uri: string): void {
  if (!uri) return
  state.pendingDisposal.delete(uri)
  state.retained.set(uri, (state.retained.get(uri) ?? 0) + 1)
}

/**
 * Release one hold on `uri`. The model is disposed when the last holder lets
 * go. Releasing an unknown URI is a no-op, so double-close is safe.
 */
export function releaseModel(uri: string): void {
  const count = state.retained.get(uri)
  if (count === undefined) return
  if (count > 1) {
    state.retained.set(uri, count - 1)
    return
  }
  state.retained.delete(uri)
  disposeModelNow(uri)
}

/** Release several URIs at once (root switch, editor teardown). */
export function releaseModels(uris: readonly string[]): void {
  for (const uri of uris) releaseModel(uri)
}

/**
 * Drop every hold on `uri` and dispose the model immediately, regardless of
 * refcount. For the cases where the document itself stopped existing — a file
 * deleted on disk, or a project root switched out from under its open files.
 */
export function disposeModel(uri: string): void {
  state.retained.delete(uri)
  disposeModelNow(uri)
}

/** How many open documents currently hold `uri`. Zero when untracked. */
export function getModelRetainCount(uri: string): number {
  return state.retained.get(uri) ?? 0
}

/** Every URI the registry currently holds. Stable order is not guaranteed. */
export function getRetainedModelUris(): string[] {
  return [...state.retained.keys()]
}

/** Drop all registry state without touching monaco. Test isolation only. */
export function resetMonacoModelRegistry(): void {
  state.monaco = null
  state.retained.clear()
  state.pendingDisposal.clear()
}

function disposeModelNow(uri: string): void {
  const monaco = state.monaco
  if (!monaco) {
    // No namespace yet — remember the intent so binding one settles it.
    state.pendingDisposal.add(uri)
    return
  }
  const model = monaco.editor.getModel(monaco.Uri.parse(uri) as never)
  if (!model || model.isDisposed()) return
  model.dispose()
}
