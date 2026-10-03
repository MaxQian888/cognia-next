// Drives `window.createTerminal` and the terminal events the ways extensions
// do; `terminalFixture.events` returns everything the extension saw.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const events = []
  const record = { opens: [], dimensions: [], input: [], closes: 0 }
  const owner = { label: "listener" }
  vscode.window.onDidOpenTerminal(
    function (terminal) {
      events.push({ event: "open", name: terminal.name, self: this.label })
    },
    owner,
    context.subscriptions
  )
  vscode.window.onDidCloseTerminal((terminal) =>
    events.push({ event: "close", name: terminal.name, exitStatus: terminal.exitStatus })
  )
  vscode.window.onDidChangeActiveTerminal((terminal) =>
    events.push({ event: "active", name: terminal ? terminal.name : null })
  )
  vscode.window.onDidChangeTerminalState((terminal) =>
    events.push({
      event: "state",
      name: terminal.name,
      interacted: terminal.state.isInteractedWith,
    })
  )

  let build
  let pty
  const write = new vscode.EventEmitter()
  const close = new vscode.EventEmitter()
  const rename = new vscode.EventEmitter()

  register("terminalFixture.process", async () => {
    build = vscode.window.createTerminal({
      name: "Build",
      shellPath: "/bin/sh",
      shellArgs: ["-l"],
      cwd: vscode.Uri.file("/tmp/work"),
      env: { A: "1", B: null },
      color: new vscode.ThemeColor("terminal.ansiRed"),
    })
    build.sendText("echo hi")
    build.sendText("a\nb", false)
    build.show(true)
    build.hide()
    return {
      name: build.name,
      own: vscode.window.terminals.map((terminal) => terminal.name),
      noShellIntegration: build.shellIntegration === undefined,
      processId: await build.processId,
    }
  })
  register("terminalFixture.legacy", async () => {
    const terminal = vscode.window.createTerminal("Named", "/bin/bash", ["-c", "true"])
    return { name: terminal.name, noProcessId: (await terminal.processId) === undefined }
  })
  register("terminalFixture.unnamed", async () => {
    const terminal = vscode.window.createTerminal()
    await terminal.processId
    return terminal.name
  })
  register("terminalFixture.pty", async () => {
    pty = vscode.window.createTerminal({
      name: "REPL",
      pty: {
        onDidWrite: write.event,
        onDidClose: close.event,
        onDidChangeName: rename.event,
        open(dimensions) {
          record.dimensions.push(dimensions)
          write.fire("ready> ")
        },
        close() {
          record.closes += 1
        },
        handleInput(data) {
          record.input.push(data)
        },
        setDimensions(dimensions) {
          record.dimensions.push(dimensions)
        },
      },
    })
    pty.sendText("1+1")
    return { name: pty.name, noProcessId: (await pty.processId) === undefined }
  })
  register("terminalFixture.ptyRename", () => {
    rename.fire("REPL (busy)")
    return pty.name
  })
  register("terminalFixture.ptyClose", () => close.fire(3))
  register("terminalFixture.dispose", () => build.dispose())
  register("terminalFixture.state", () => ({
    events,
    record,
    active: vscode.window.activeTerminal ? vscode.window.activeTerminal.name : null,
    terminals: vscode.window.terminals.map((terminal) => terminal.name),
    build: build && { exitStatus: build.exitStatus, interacted: build.state.isInteractedWith },
    pty: pty && { exitStatus: pty.exitStatus },
    enums: [vscode.TerminalExitReason.Extension, vscode.TerminalLocation.Panel],
  }))
}
