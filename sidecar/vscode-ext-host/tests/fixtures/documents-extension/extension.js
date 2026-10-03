// Drives `vscode.workspace`'s documents and `window.showTextDocument`; each
// command returns what the extension saw, so the test can check both sides.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const saved = []
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => saved.push(document.uri.toString()))
  )

  let changeContent
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("fixture", {
      onDidChange: (listener) => {
        changeContent = listener
        return { dispose() {} }
      },
      provideTextDocumentContent: (uri) => `content of ${uri.path}`,
    })
  )

  register("documentsFixture.open", async (path) => {
    const document = await vscode.workspace.openTextDocument(path)
    return {
      uri: document.uri.toString(),
      text: document.getText(),
      languageId: document.languageId,
    }
  })
  register("documentsFixture.untitled", async () => {
    const document = await vscode.workspace.openTextDocument({
      content: "draft",
      language: "markdown",
    })
    return {
      uri: document.uri.toString(),
      text: document.getText(),
      isUntitled: document.isUntitled,
    }
  })
  register("documentsFixture.applyEdit", async (path) => {
    const uri = vscode.Uri.file(path)
    const edit = new vscode.WorkspaceEdit()
    edit.createFile(vscode.Uri.file(`${path}.new`), { contents: new TextEncoder().encode("made") })
    edit.insert(uri, new vscode.Position(0, 0), ">")
    const applied = await vscode.workspace.applyEdit(edit)
    // Resolved edits are visible at once.
    const document = await vscode.workspace.openTextDocument(uri)
    return { applied, text: document.getText() }
  })
  register("documentsFixture.show", async (path) => {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(path), {
      selection: new vscode.Range(0, 1, 0, 3),
    })
    const edited = await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), "!"))
    return {
      editorId: editor.id,
      edited,
      text: editor.document.getText(),
      selection: [editor.selection.start.character, editor.selection.end.character],
    }
  })
  register("documentsFixture.changeContent", () => changeContent(vscode.Uri.parse("fixture:/x")))
  register("documentsFixture.saved", () => saved)
}
