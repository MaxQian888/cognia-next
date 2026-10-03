// Drives `vscode.window` the ways extensions do; each command returns what
// the extension saw, so the test can check both sides.
const vscode = require("vscode")

exports.activate = (context) => {
  const log = vscode.window.createOutputChannel("Fixture", { log: true })
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  register("windowFixture.pick", () =>
    vscode.window.showQuickPick(
      Promise.resolve([{ label: "a" }, { label: "b", description: "second" }]),
      { placeHolder: "Pick one", title: "Fixture" }
    )
  )
  register("windowFixture.pickMany", () =>
    vscode.window.showQuickPick(["x", "y", "z"], { canPickMany: true })
  )
  register("windowFixture.input", () =>
    vscode.window.showInputBox({
      value: "ab",
      prompt: "Name",
      validateInput: (value) => (value.length < 3 ? "too short" : undefined),
    })
  )
  register("windowFixture.message", () =>
    vscode.window.showWarningMessage(
      "Proceed?",
      { modal: true, detail: "It cannot be undone" },
      { title: "Yes" },
      { title: "No", isCloseAffordance: true }
    )
  )
  register("windowFixture.progress", () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Work", cancellable: true },
      (progress, token) =>
        new Promise((resolve) => {
          progress.report({ message: "started", increment: 10 })
          token.onCancellationRequested(() => resolve("cancelled"))
        })
    )
  )
  register("windowFixture.status", () => {
    const item = vscode.window.createStatusBarItem(
      "fixture.status",
      vscode.StatusBarAlignment.Right,
      5
    )
    item.text = "$(check) Ready"
    item.tooltip = new vscode.MarkdownString("All **good**")
    item.command = { command: "windowFixture.pick", title: "Pick", arguments: [1] }
    item.show()
    vscode.window.setStatusBarMessage("Saved", 20)
    return { id: item.id, alignment: item.alignment, priority: item.priority }
  })
  register("windowFixture.log", () => {
    log.info("hello", { a: 1 })
    log.debug("hidden at the default level")
    log.appendLine("plain line")
    return log.logLevel
  })
  register("windowFixture.reject", () => {
    void Promise.reject(new Error("stray rejection"))
    return "returned"
  })
}
