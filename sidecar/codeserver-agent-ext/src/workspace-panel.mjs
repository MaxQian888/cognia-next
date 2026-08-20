// Cognia workspace panel — the status bar item and the three side-bar trees the
// app pushes into (ADR-0088 Phase 3).
//
// Strictly a renderer. Every string arrives already localized and every row
// already ordered, filtered and iconified by the app; this file decides
// nothing about the user's work. That split is deliberate: a bug here can make
// the panel look wrong, but it can never make it *say* something wrong about
// which issues are open or what a plan is doing.
//
// One whole-snapshot push replaces the previous state each time. A delta stream
// would be smaller, but a dropped delta leaves a silently stale tree that
// nothing ever corrects — and this panel's whole value is being trustworthy at
// a glance.

import * as vscode from "vscode"

/** View ids contributed in `package.json`, in the order they appear. */
export const WORKSPACE_VIEW_IDS = ["cognia.issues", "cognia.plans", "cognia.runs"]

/** Group id → contributed view id. */
function viewIdForGroup(groupId) {
  return `cognia.${groupId}`
}

/**
 * A tree over one group's flat rows.
 *
 * Flat by contract: nesting would need the extension to understand the
 * relationships between the user's items, which is exactly the knowledge this
 * side is not allowed to hold.
 */
class WorkspaceGroupTree {
  constructor(groupId) {
    this.groupId = groupId
    this.group = null
    this._emitter = new vscode.EventEmitter()
    this.onDidChangeTreeData = this._emitter.event
  }

  setGroup(group) {
    this.group = group ?? null
    this._emitter.fire(undefined)
  }

  getChildren() {
    return (this.group?.rows ?? []).map((row) => {
      const item = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None)
      item.id = row.id
      if (row.description) item.description = row.description
      if (row.icon) item.iconPath = new vscode.ThemeIcon(row.icon)
      item.tooltip = row.description ? `${row.label} — ${row.description}` : row.label
      // A row that names a file opens it in place; one that does not sends the
      // user back to Cognia, which is the only place that can show it.
      item.command = {
        command: "cognia.workspace.activateRow",
        title: row.label,
        arguments: [{ groupId: this.groupId, ...row }],
      }
      return item
    })
  }

  getTreeItem(item) {
    return item
  }

  dispose() {
    this._emitter.dispose()
  }
}

/**
 * Owns the status bar item and the three trees.
 *
 * Constructed once on activation, before any snapshot arrives, so the views
 * exist (and can say "not connected") rather than appearing only after the app
 * happens to push — a view container that materializes late reads as broken.
 */
export class WorkspacePanel {
  constructor(onActivateRow) {
    this.trees = new Map()
    this.disposables = []
    this.snapshot = null

    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
    this.status.command = "cognia.workspace.focus"
    this.disposables.push(this.status)

    for (const groupId of ["issues", "plans", "runs"]) {
      const tree = new WorkspaceGroupTree(groupId)
      this.trees.set(groupId, tree)
      this.disposables.push(
        tree,
        vscode.window.registerTreeDataProvider(viewIdForGroup(groupId), tree)
      )
    }

    this.disposables.push(
      vscode.commands.registerCommand("cognia.workspace.activateRow", (row) => onActivateRow(row))
    )
  }

  /**
   * Show "not connected" rather than the last snapshot when the bridge drops.
   *
   * Stale-but-plausible is the dangerous state for this panel: a user glancing
   * at three-minute-old issue counts has no way to tell. `text` is passed in
   * because even this string belongs to the app's message catalog.
   */
  setDisconnected(text) {
    this.snapshot = null
    this.status.text = `$(circle-slash) ${text}`
    this.status.tooltip = text
    this.status.backgroundColor = undefined
    this.status.show()
    for (const tree of this.trees.values()) tree.setGroup(null)
  }

  apply(snapshot) {
    this.snapshot = snapshot
    this.status.text = `$(circuit-board) ${snapshot.statusText ?? ""}`.trim()
    this.status.tooltip = snapshot.statusTooltip ?? snapshot.statusText ?? ""
    this.status.backgroundColor = snapshot.attention
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined
    this.status.show()

    const byId = new Map((snapshot.groups ?? []).map((group) => [group.id, group]))
    for (const [groupId, tree] of this.trees) tree.setGroup(byId.get(groupId) ?? null)
  }

  dispose() {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this.trees.clear()
  }
}
