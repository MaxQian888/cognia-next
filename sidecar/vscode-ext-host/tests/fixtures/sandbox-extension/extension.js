// Uses the globals extensions written for Node and the web expect; each
// command returns what the extension saw.
const vscode = require("vscode")

const GLOBALS = [
  "queueMicrotask",
  "structuredClone",
  "AbortController",
  "AbortSignal",
  "Event",
  "EventTarget",
  "performance",
  "atob",
  "btoa",
  "crypto",
  "Blob",
  "File",
  "FormData",
  "Headers",
  "Request",
  "Response",
  "MessageChannel",
  "MessagePort",
  "fetch",
  "WebSocket",
]

exports.activate = (context) => {
  const register = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn))

  register("sandboxFixture.globals", async () => {
    const microtask = await new Promise((resolve) => queueMicrotask(() => resolve("ran")))
    const controller = new AbortController()
    controller.abort()
    return {
      missing: GLOBALS.filter((name) => typeof globalThis[name] === "undefined"),
      global: global === globalThis,
      microtask,
      clone: structuredClone({ nested: [1, 2] }),
      aborted: controller.signal.aborted,
      base64: atob(btoa("cognia")),
      uuid: crypto.randomUUID().length,
      now: typeof performance.now(),
    }
  })
  register("sandboxFixture.fetch", async (url) => {
    try {
      const response = await fetch(url)
      return { status: response.status, body: await response.text() }
    } catch (error) {
      return { error: error.message }
    }
  })
  register("sandboxFixture.websocket", () => {
    try {
      const socket = new WebSocket("ws://127.0.0.1:9")
      const result = { opened: socket instanceof WebSocket, constant: WebSocket.OPEN }
      socket.addEventListener("error", () => {})
      socket.close()
      return result
    } catch (error) {
      return { error: error.message }
    }
  })
  register("sandboxFixture.websocketCall", () => {
    try {
      WebSocket("ws://127.0.0.1:9")
      return "called"
    } catch (error) {
      return { error: error.message }
    }
  })
}
