// Drives `vscode.workspace`'s folders and files; each command returns what
// the extension saw, so the test can check both sides.
const vscode = require("vscode")

const describeError = (error) => ({ code: error.code, name: error.name, message: error.message })

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const folderEvents = []
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders((event) =>
      folderEvents.push({
        added: event.added.map((folder) => folder.name),
        removed: event.removed.map((folder) => folder.name),
      })
    )
  )

  register("workspaceFixture.folders", (path) => ({
    names: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.name),
    name: vscode.workspace.name,
    rootPath: vscode.workspace.rootPath,
    folderOf: vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))?.name,
    relative: vscode.workspace.asRelativePath(path),
    relativeUri: vscode.workspace.asRelativePath(vscode.Uri.file(path), true),
    outside: vscode.workspace.asRelativePath("/elsewhere/x.ts"),
    updated: vscode.workspace.updateWorkspaceFolders(0, 0, { uri: vscode.Uri.file("/x") }),
    events: folderEvents,
  }))

  register("workspaceFixture.fs", async (folder) => {
    const fs = vscode.workspace.fs
    const at = (rel) => vscode.Uri.joinPath(vscode.Uri.file(folder), rel)
    await fs.createDirectory(at("made/deeper"))
    await fs.writeFile(at("made/bin.dat"), new Uint8Array([0, 255, 1]))
    const bytes = await fs.readFile(at("made/bin.dat"))
    const stat = await fs.stat(at("made/bin.dat"))
    await fs.copy(at("made/bin.dat"), at("made/copy.dat"))
    let copyAgain
    try {
      await fs.copy(at("made/bin.dat"), at("made/copy.dat"))
    } catch (error) {
      copyAgain = describeError(error)
    }
    await fs.rename(at("made/copy.dat"), at("made/renamed.dat"))
    const listing = (await fs.readDirectory(at("made"))).sort()
    let missing
    try {
      await fs.stat(at("nope"))
    } catch (error) {
      missing = describeError(error)
    }
    let trash
    try {
      await fs.delete(at("made/renamed.dat"), { useTrash: true })
    } catch (error) {
      trash = describeError(error)
    }
    await fs.delete(at("made"), { recursive: true })
    let outside
    try {
      await fs.readFile(vscode.Uri.file("/etc/hosts"))
    } catch (error) {
      outside = describeError(error)
    }
    let scheme
    try {
      await fs.readFile(vscode.Uri.parse("git:/x"))
    } catch (error) {
      scheme = describeError(error)
    }
    // The extension's own storage needs no one's say.
    await fs.writeFile(
      vscode.Uri.joinPath(context.globalStorageUri, "state.json"),
      new Uint8Array([123, 125])
    )
    const own = await fs.readFile(vscode.Uri.joinPath(context.globalStorageUri, "state.json"))
    return {
      bytes: [...bytes],
      isUint8Array: bytes instanceof Uint8Array,
      stat: { type: stat.type, size: stat.size, hasTimes: stat.mtime > 0 && stat.ctime > 0 },
      copyAgain,
      listing,
      missing,
      trash,
      outside,
      scheme,
      own: [...own],
      writable: fs.isWritableFileSystem("file"),
    }
  })

  register("workspaceFixture.escape", async (link) => {
    try {
      await vscode.workspace.fs.readFile(vscode.Uri.file(link))
      return "read"
    } catch (error) {
      return describeError(error)
    }
  })

  register("workspaceFixture.find", async () => {
    const found = await vscode.workspace.findFiles(
      new vscode.RelativePattern(vscode.Uri.file("/repo/src"), "**/*.ts"),
      null,
      5
    )
    return found.map((uri) => uri.toString())
  })

  const seen = []
  let watcher
  register("workspaceFixture.watch", () => {
    watcher = vscode.workspace.createFileSystemWatcher("**/*.ts", false, true, false)
    watcher.onDidCreate((uri) => seen.push(`create ${uri.path}`))
    watcher.onDidChange((uri) => seen.push(`change ${uri.path}`))
    watcher.onDidDelete((uri) => seen.push(`delete ${uri.path}`))
    return { ignoreChangeEvents: watcher.ignoreChangeEvents }
  })
  register("workspaceFixture.seen", () => seen)

  const configEvents = []
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) =>
      configEvents.push({
        fixture: event.affectsConfiguration("fixture"),
        port: event.affectsConfiguration("fixture.server.port"),
        greeting: event.affectsConfiguration("fixture.greeting"),
      })
    )
  )
  register("workspaceFixture.config", () => {
    const config = vscode.workspace.getConfiguration("fixture")
    return {
      greeting: config.get("greeting"),
      server: config.get("server"),
      port: vscode.workspace.getConfiguration("fixture.server").port,
      missing: config.get("missing", "fallback"),
      inspect: config.inspect("server.port"),
      tabSize: vscode.workspace.getConfiguration("editor").get("tabSize"),
      events: configEvents,
    }
  })
  register("workspaceFixture.setGreeting", (value) =>
    vscode.workspace.getConfiguration("fixture").update("greeting", value, true)
  )
  register("workspaceFixture.unwatch", () => watcher.dispose())
}
