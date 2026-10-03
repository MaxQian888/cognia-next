/**
 * The members of `window`, `workspace` and `languages` that Cognia does not
 * provide (`unsupported.ts` gives each one's reason).
 *
 * They are mounted so an extension that registers or subscribes at
 * activation keeps running, and they behave as their reason says:
 *
 *   - registrations return a `Disposable` and nothing ever calls the provider;
 *   - events never fire;
 *   - the notebook editor lists are empty and there is no active one;
 *   - `createTreeView` and `createLanguageStatusItem` return an object that
 *     is never displayed;
 *   - a call that has to produce something (`showNotebookDocument`,
 *     `openNotebookDocument`, `saveAs`, a tree view's `reveal`, the tab
 *     groups) fails with `NotSupportedError`;
 *   - `withScmProgress` runs its task without showing progress.
 *
 * The first time an extension meets one, the renderer writes the reason to
 * that extension's log (`vscode:unsupportedApi`).
 */

import type { RpcConnection } from "../rpc"
import { Disposable, EventEmitter, NotSupportedError } from "./types"

type Listener = (event: unknown) => unknown
type Event = (listener: Listener, thisArgs?: unknown, disposables?: Disposable[]) => Disposable

export interface UnsupportedApiReporter {
  /** Tell the renderer the extension met `vscode.<api>`, once per api. */
  report(api: string): void
}

export function createUnsupportedApiReporter(
  connection: RpcConnection,
  extensionId: string
): UnsupportedApiReporter {
  const reported = new Set<string>()
  return {
    report(api) {
      if (reported.has(api)) return
      reported.add(api)
      void connection.sendRequest("vscode:unsupportedApi", { extensionId, api }).catch(() => {})
    },
  }
}

function registration(reporter: UnsupportedApiReporter, api: string) {
  return (..._args: unknown[]): Disposable => {
    reporter.report(api)
    return new Disposable(() => {})
  }
}

function silentEvent(reporter: UnsupportedApiReporter, api: string): Event {
  return (_listener, _thisArgs, disposables) => {
    reporter.report(api)
    const disposable = new Disposable(() => {})
    disposables?.push(disposable)
    return disposable
  }
}

function refusal(reporter: UnsupportedApiReporter, api: string) {
  return async (..._args: unknown[]): Promise<never> => {
    reporter.report(api)
    throw new NotSupportedError(api)
  }
}

/** A tree view nothing displays: never visible, no selection, its events never fire. */
function inertTreeView(reporter: UnsupportedApiReporter, viewId: string) {
  const never = new EventEmitter<unknown>().event
  return {
    id: viewId,
    visible: false,
    selection: [] as unknown[],
    message: undefined as string | undefined,
    title: undefined as string | undefined,
    description: undefined as string | undefined,
    badge: undefined as unknown,
    onDidExpandElement: never,
    onDidCollapseElement: never,
    onDidChangeSelection: never,
    onDidChangeVisibility: never,
    onDidChangeCheckboxState: never,
    reveal: refusal(reporter, "window.createTreeView"),
    dispose() {},
  }
}

export function createUnsupportedWindowMembers(reporter: UnsupportedApiReporter) {
  const tabGroups = {}
  for (const member of ["all", "activeTabGroup", "onDidChangeTabGroups", "onDidChangeTabs"]) {
    Object.defineProperty(tabGroups, member, {
      enumerable: true,
      get() {
        reporter.report("window.tabGroups")
        throw new NotSupportedError(`window.tabGroups.${member}`)
      },
    })
  }
  Object.defineProperty(tabGroups, "close", {
    enumerable: true,
    value: refusal(reporter, "window.tabGroups"),
  })
  return {
    createTreeView(viewId: string, _options?: unknown) {
      reporter.report("window.createTreeView")
      return inertTreeView(reporter, viewId)
    },
    registerTreeDataProvider: registration(reporter, "window.registerTreeDataProvider"),
    registerCustomEditorProvider: registration(reporter, "window.registerCustomEditorProvider"),
    registerFileDecorationProvider: registration(reporter, "window.registerFileDecorationProvider"),
    registerTerminalLinkProvider: registration(reporter, "window.registerTerminalLinkProvider"),
    registerTerminalProfileProvider: registration(
      reporter,
      "window.registerTerminalProfileProvider"
    ),
    tabGroups,
    async withScmProgress<R>(task: (progress: { report(value: number): void }) => Thenable<R>) {
      reporter.report("window.withScmProgress")
      return task({ report() {} })
    },
    activeNotebookEditor: undefined,
    visibleNotebookEditors: [] as readonly unknown[],
    onDidChangeActiveNotebookEditor: silentEvent(
      reporter,
      "window.onDidChangeActiveNotebookEditor"
    ),
    onDidChangeVisibleNotebookEditors: silentEvent(
      reporter,
      "window.onDidChangeVisibleNotebookEditors"
    ),
    onDidChangeNotebookEditorSelection: silentEvent(
      reporter,
      "window.onDidChangeNotebookEditorSelection"
    ),
    onDidChangeNotebookEditorVisibleRanges: silentEvent(
      reporter,
      "window.onDidChangeNotebookEditorVisibleRanges"
    ),
    showNotebookDocument: refusal(reporter, "window.showNotebookDocument"),
  }
}

export function createUnsupportedWorkspaceMembers(reporter: UnsupportedApiReporter) {
  return {
    notebookDocuments: [] as readonly unknown[],
    openNotebookDocument: refusal(reporter, "workspace.openNotebookDocument"),
    registerNotebookSerializer: registration(reporter, "workspace.registerNotebookSerializer"),
    onDidOpenNotebookDocument: silentEvent(reporter, "workspace.onDidOpenNotebookDocument"),
    onDidChangeNotebookDocument: silentEvent(reporter, "workspace.onDidChangeNotebookDocument"),
    onDidSaveNotebookDocument: silentEvent(reporter, "workspace.onDidSaveNotebookDocument"),
    onDidCloseNotebookDocument: silentEvent(reporter, "workspace.onDidCloseNotebookDocument"),
    onWillSaveNotebookDocument: silentEvent(reporter, "workspace.onWillSaveNotebookDocument"),
    onWillCreateFiles: silentEvent(reporter, "workspace.onWillCreateFiles"),
    onDidCreateFiles: silentEvent(reporter, "workspace.onDidCreateFiles"),
    onWillDeleteFiles: silentEvent(reporter, "workspace.onWillDeleteFiles"),
    onDidDeleteFiles: silentEvent(reporter, "workspace.onDidDeleteFiles"),
    onWillRenameFiles: silentEvent(reporter, "workspace.onWillRenameFiles"),
    onDidRenameFiles: silentEvent(reporter, "workspace.onDidRenameFiles"),
    onWillSaveTextDocument: silentEvent(reporter, "workspace.onWillSaveTextDocument"),
    registerFileSystemProvider: registration(reporter, "workspace.registerFileSystemProvider"),
    saveAs: refusal(reporter, "workspace.saveAs"),
  }
}

export function createUnsupportedLanguagesMembers(reporter: UnsupportedApiReporter) {
  return {
    /** A language status item nothing displays; its properties can still be set. */
    createLanguageStatusItem(id: string, selector: unknown) {
      reporter.report("languages.createLanguageStatusItem")
      return {
        id,
        selector,
        name: undefined as string | undefined,
        text: "",
        detail: undefined as string | undefined,
        command: undefined as unknown,
        severity: 0,
        busy: false,
        accessibilityInformation: undefined as unknown,
        dispose() {},
      }
    },
    registerDocumentDropEditProvider: registration(
      reporter,
      "languages.registerDocumentDropEditProvider"
    ),
    registerEvaluatableExpressionProvider: registration(
      reporter,
      "languages.registerEvaluatableExpressionProvider"
    ),
    registerInlineValuesProvider: registration(reporter, "languages.registerInlineValuesProvider"),
  }
}
