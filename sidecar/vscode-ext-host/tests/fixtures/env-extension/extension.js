// Drives `vscode.env` and `window.registerUriHandler` the ways extensions do;
// each command returns what the extension saw.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const handled = []
  let handler = vscode.window.registerUriHandler({
    handleUri(uri) {
      handled.push({
        scheme: uri.scheme,
        authority: uri.authority,
        path: uri.path,
        query: uri.query,
        fragment: uri.fragment,
      })
    },
  })

  register("envFixture.clipboard", async () => {
    await vscode.env.clipboard.writeText("from extension")
    return vscode.env.clipboard.readText()
  })
  register("envFixture.openWeb", () =>
    vscode.env.openExternal(vscode.Uri.parse("https://example.com/login?a=1&b=2"))
  )
  register("envFixture.openString", () => vscode.env.openExternal("mailto:someone@example.com"))
  register("envFixture.callbackUri", async () => {
    const callback = vscode.Uri.parse(
      `${vscode.env.uriScheme}://${context.extension.id}/did-authenticate?nonce=1`
    )
    const external = await vscode.env.asExternalUri(callback)
    return { scheme: external.scheme, authority: external.authority, path: external.path }
  })
  register("envFixture.handled", () => handled)
  register("envFixture.secondHandler", () => {
    try {
      vscode.window.registerUriHandler({ handleUri() {} })
      return "registered"
    } catch (error) {
      return error.message
    }
  })
  register("envFixture.reregister", () => {
    handler.dispose()
    handler = vscode.window.registerUriHandler({ handleUri() {} })
    return "registered"
  })
}
