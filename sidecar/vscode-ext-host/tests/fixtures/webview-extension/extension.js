// Drives webview panels and views the ways extensions do;
// `webviewFixture.state` returns what the extension saw.
const vscode = require("vscode")

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))
  const events = []
  let panel
  let view
  let provider

  register("webviewFixture.panel", () => {
    const media = vscode.Uri.joinPath(context.extensionUri, "media")
    panel = vscode.window.createWebviewPanel(
      "fixture.preview",
      "Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        enableCommandUris: ["fixture.ok"],
        localResourceRoots: [media],
        retainContextWhenHidden: true,
      }
    )
    const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "main.js"))
    panel.webview.html = `<script src="${script}"></script>`
    panel.title = "Preview (1)"
    panel.webview.onDidReceiveMessage((message) => {
      events.push({ event: "message", message })
      void panel.webview.postMessage({ echo: message })
    })
    panel.onDidChangeViewState(({ webviewPanel }) =>
      events.push({
        event: "viewState",
        visible: webviewPanel.visible,
        active: webviewPanel.active,
      })
    )
    panel.onDidDispose(() => events.push({ event: "panelDisposed" }))
    return {
      script: script.toString(),
      cspSource: panel.webview.cspSource,
      viewColumn: panel.viewColumn,
      options: panel.options,
      other: panel.webview.asWebviewUri(vscode.Uri.parse("https://example.com/a")).toString(),
    }
  })
  register("webviewFixture.post", () => panel.webview.postMessage({ hello: 1 }))
  register("webviewFixture.reveal", () => panel.reveal(undefined, true))
  register("webviewFixture.dispose", () => panel.dispose())
  register("webviewFixture.openRoot", () => {
    panel.webview.options = { enableScripts: false }
    return "ok"
  })

  register("webviewFixture.view", () => {
    provider = vscode.window.registerWebviewViewProvider(
      "webviewFixture.sidebar",
      {
        resolveWebviewView(resolved, { state }) {
          view = resolved
          resolved.webview.options = { enableScripts: true }
          resolved.webview.html = "<p>sidebar</p>"
          resolved.title = "Sidebar!"
          resolved.description = "2 items"
          resolved.badge = { value: 2, tooltip: "Two" }
          resolved.onDidChangeVisibility(() =>
            events.push({ event: "visibility", visible: resolved.visible })
          )
          resolved.onDidDispose(() => events.push({ event: "viewDisposed" }))
          events.push({ event: "resolved", state, viewType: resolved.viewType })
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
    try {
      vscode.window.registerWebviewViewProvider("webviewFixture.sidebar", {
        resolveWebviewView() {},
      })
      return "registered twice"
    } catch (error) {
      return error.message
    }
  })
  register("webviewFixture.showView", () => view.show(true))
  register("webviewFixture.unregisterView", () => provider.dispose())
  register("webviewFixture.serializer", () => {
    const disposable = vscode.window.registerWebviewPanelSerializer("fixture.preview", {
      deserializeWebviewPanel() {},
    })
    disposable.dispose()
    return "ok"
  })
  register("webviewFixture.state", () => ({
    events,
    panel: panel && { visible: panel.visible, active: panel.active, title: panel.title },
    view: view && {
      title: view.title,
      description: view.description,
      badge: view.badge,
      visible: view.visible,
    },
  }))
}
