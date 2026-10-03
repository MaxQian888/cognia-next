/**
 * The parts of the `vscode` API the shim mounts but Cognia does not provide,
 * each with the reason an extension author (and the user) is given.
 *
 * A key is a namespace (`debug`: every member), a namespace member
 * (`window.registerTreeDataProvider`) or a top-level export. Each one is
 * still present on the shim, so an extension that feature-detects or
 * registers at activation keeps running; calling it either throws
 * `NotSupportedError` or registers something nothing uses, as its module
 * documents.
 *
 * `scripts/gates/check-vscode-api-coverage.mjs` holds this list to the
 * `@types/vscode` the shim targets: every key must name real API that the
 * shim mounts, and the generated coverage report
 * (`lib/plugin/vscode-shim/vscode-api-coverage.generated.json`) lists it as
 * unsupported rather than implemented.
 */
const NO_DEBUGGER = "Cognia has no debugger."
const NO_NOTEBOOKS = "Cognia has no notebooks."
const NO_TREE_VIEWS = "Cognia shows no tree views from extensions"
const NO_FILE_EVENTS =
  "Cognia does not tell extensions about files created, deleted or renamed in its file tree; the event never fires."

export const UNSUPPORTED_VSCODE_API: Readonly<Record<string, string>> = {
  debug: NO_DEBUGGER,
  scm: "Cognia's source control does not take providers from extensions.",
  tests: "Cognia has no test explorer.",
  comments: "Cognia's editor has no comment threads.",
  notebooks: NO_NOTEBOOKS,

  "window.createTreeView": `${NO_TREE_VIEWS}; the view is created but never displayed.`,
  "window.registerTreeDataProvider": `${NO_TREE_VIEWS}; the provider is never asked for items.`,
  "window.registerCustomEditorProvider":
    "Cognia opens files in its own editor; custom editors from extensions are never used.",
  "window.registerFileDecorationProvider":
    "Cognia's file tree does not take decorations from extensions.",
  "window.registerTerminalLinkProvider": "Cognia's terminal does not take links from extensions.",
  "window.registerTerminalProfileProvider":
    "Cognia's terminal does not take profiles from extensions.",
  "window.tabGroups": "Cognia does not describe its editor tabs to extensions.",
  "window.withScmProgress":
    "Cognia has no source control view for extensions; the task runs without visible progress.",
  "window.activeNotebookEditor": NO_NOTEBOOKS,
  "window.visibleNotebookEditors": NO_NOTEBOOKS,
  "window.onDidChangeActiveNotebookEditor": NO_NOTEBOOKS,
  "window.onDidChangeVisibleNotebookEditors": NO_NOTEBOOKS,
  "window.onDidChangeNotebookEditorSelection": NO_NOTEBOOKS,
  "window.onDidChangeNotebookEditorVisibleRanges": NO_NOTEBOOKS,
  "window.showNotebookDocument": NO_NOTEBOOKS,

  "workspace.notebookDocuments": NO_NOTEBOOKS,
  "workspace.openNotebookDocument": NO_NOTEBOOKS,
  "workspace.registerNotebookSerializer": NO_NOTEBOOKS,
  "workspace.onDidOpenNotebookDocument": NO_NOTEBOOKS,
  "workspace.onDidChangeNotebookDocument": NO_NOTEBOOKS,
  "workspace.onDidSaveNotebookDocument": NO_NOTEBOOKS,
  "workspace.onDidCloseNotebookDocument": NO_NOTEBOOKS,
  "workspace.onWillSaveNotebookDocument": NO_NOTEBOOKS,
  "workspace.onWillCreateFiles": NO_FILE_EVENTS,
  "workspace.onDidCreateFiles": NO_FILE_EVENTS,
  "workspace.onWillDeleteFiles": NO_FILE_EVENTS,
  "workspace.onDidDeleteFiles": NO_FILE_EVENTS,
  "workspace.onWillRenameFiles": NO_FILE_EVENTS,
  "workspace.onDidRenameFiles": NO_FILE_EVENTS,
  "workspace.onWillSaveTextDocument":
    "Cognia saves without waiting on extensions; the event never fires, so no edits are made before a save.",
  "workspace.registerFileSystemProvider":
    "Cognia does not take file systems from extensions; documents under that scheme cannot be opened.",
  "workspace.saveAs": "Cognia does not let extensions save a document under a new name.",

  "languages.createLanguageStatusItem":
    "Cognia's status bar does not show language status items; the item is created but never displayed.",
  "languages.registerDocumentDropEditProvider":
    "Cognia's editor does not ask extensions what a drop inserts.",
  "languages.registerEvaluatableExpressionProvider": NO_DEBUGGER,
  "languages.registerInlineValuesProvider": NO_DEBUGGER,
}

/** The reason `vscode.<api>` is unsupported: its own entry, else its namespace's. */
export function unsupportedReason(api: string): string | undefined {
  return UNSUPPORTED_VSCODE_API[api] ?? UNSUPPORTED_VSCODE_API[api.split(".")[0]!]
}
