// Reads the window's focus and theme, and meets API Cognia does not provide,
// the ways extensions do; each command returns what the extension saw.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const states = []
  const themes = []
  // What the extension saw while it activated.
  const atActivation = {
    state: { ...vscode.window.state },
    theme: vscode.window.activeColorTheme.kind,
  }
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => states.push({ ...state })),
    vscode.window.onDidChangeActiveColorTheme((theme) => themes.push(theme.kind)),
    // Registered at activation, as tree-view extensions do: activation goes on.
    vscode.window.registerTreeDataProvider("surfaceFixture.tree", {
      getChildren: () => [],
      getTreeItem: (item) => item,
    })
  )

  register("surfaceFixture.activation", () => atActivation)
  register("surfaceFixture.changes", () => ({ states, themes }))
  register("surfaceFixture.saveAs", async () => {
    try {
      await vscode.workspace.saveAs(vscode.Uri.file("/tmp/a.txt"))
      return { saved: true }
    } catch (error) {
      return { error: error.message, notSupported: error instanceof vscode.NotSupportedError }
    }
  })
  register("surfaceFixture.env", () => ({
    uiKind: vscode.env.uiKind,
    remoteName: vscode.env.remoteName ?? null,
    logLevel: vscode.env.logLevel,
    shell: typeof vscode.env.shell,
    appRoot: typeof vscode.env.appRoot,
  }))
  register("surfaceFixture.task", () => {
    const task = new vscode.Task(
      { type: "shell" },
      vscode.TaskScope.Workspace,
      "build",
      "surface",
      new vscode.ShellExecution("make"),
      "$gcc"
    )
    task.group = vscode.TaskGroup.Build
    return { name: task.name, group: task.group.id, matchers: task.problemMatchers }
  })
}
