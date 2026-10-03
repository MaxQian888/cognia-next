// Webview panels and views through the real host: the test plays the
// renderer's extension rail.
import assert from "node:assert/strict"
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { activation, FIXTURES, startHost } from "./host-harness.mjs"

const ID = "cognia.webview-extension"
const PATH = join(FIXTURES, "webview-extension")
const RESOURCE = "https://file+.vscode-resource.cognia.invalid"

async function until(check, what) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const value = check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function startWebviews(answer = () => undefined) {
  const commands = new Map()
  const requests = []
  const host = startHost(ID, (method, params) => {
    requests.push({ method, params })
    if (method === "commands:register") {
      commands.set(params.command, params.token)
      return { registered: true }
    }
    return answer(method, params) ?? null
  })
  await host.request("extension:load", {
    extensionId: ID,
    extensionPath: PATH,
    main: "./extension.js",
    bundleFormat: "cjs",
    grantedModules: [],
  })
  await host.request("extension:activate", activation(ID, PATH))
  const run = (command) =>
    host.request("extension:call", { extensionId: ID, token: commands.get(command), payload: [] })
  const sent = (method) => requests.filter((entry) => entry.method === method)
  return { host, run, sent }
}

test("a panel: created with its options, then filled, titled, revealed, in order", async () => {
  const { host, run, sent } = await startWebviews()
  try {
    const opened = await run("webviewFixture.panel")
    assert.equal(opened.script, `${RESOURCE}${join(PATH, "media", "main.js")}`)
    assert.equal(opened.cspSource, "'unsafe-inline' blob: data:")
    assert.equal(opened.viewColumn, 1)
    assert.deepEqual(opened.options, { retainContextWhenHidden: true })
    assert.equal(opened.other, "https://example.com/a")
    const [create] = sent("window:createWebviewPanel")
    assert.match(create.params.handle, /^webview:cognia\.webview-extension:/)
    assert.deepEqual(
      { ...create.params, handle: undefined },
      {
        extensionId: ID,
        handle: undefined,
        viewType: "fixture.preview",
        title: "Preview",
        preserveFocus: true,
        options: {
          enableScripts: true,
          enableForms: true,
          enableCommandUris: ["fixture.ok"],
          localResourceRoots: [`file://${join(PATH, "media")}`],
          retainContextWhenHidden: true,
        },
      }
    )
    await run("webviewFixture.reveal")
    await until(() => sent("webview:reveal").length === 1, "reveal")
    assert.deepEqual(
      sent("webview:update").map((entry) => ({
        ...entry.params,
        handle: entry.params.handle === create.params.handle,
      })),
      [
        { extensionId: ID, handle: true, html: `<script src="${opened.script}"></script>` },
        { extensionId: ID, handle: true, title: "Preview (1)" },
      ]
    )
    assert.equal(sent("webview:reveal")[0].params.preserveFocus, true)
  } finally {
    host.stop()
  }
})

test("messages both ways, view state, and the renderer's answer to postMessage", async () => {
  const { host, run, sent } = await startWebviews((method) =>
    method === "webview:postMessage" ? true : undefined
  )
  try {
    await run("webviewFixture.panel")
    const handle = sent("window:createWebviewPanel")[0].params.handle
    assert.equal(await run("webviewFixture.post"), true)
    await host.request("webview:message", { handle, message: { from: "page" } })
    await until(() => sent("webview:postMessage").length === 2, "echo")
    assert.deepEqual(sent("webview:postMessage")[1].params.message, { echo: { from: "page" } })
    await host.request("webview:viewState", { handle, visible: false, active: false })
    await host.request("webview:viewState", { handle, visible: false, active: false })
    const state = await run("webviewFixture.state")
    assert.deepEqual(state.events, [
      { event: "message", message: { from: "page" } },
      { event: "viewState", visible: false, active: false },
    ])
    assert.deepEqual(state.panel, { visible: false, active: false, title: "Preview (1)" })
  } finally {
    host.stop()
  }
})

test("resources: files under the webview's roots, nothing outside them", async () => {
  const { host, run, sent } = await startWebviews()
  try {
    await run("webviewFixture.panel")
    const handle = sent("window:createWebviewPanel")[0].params.handle
    const file = await host.request("webview:resource", {
      handle,
      uri: `${RESOURCE}${join(PATH, "media", "main.js")}`,
    })
    assert.equal(Buffer.from(file.data, "base64").toString(), 'console.log("media")\n')
    assert.equal(file.mime, "text/javascript")
    await assert.rejects(
      host.request("webview:resource", { handle, uri: `${RESOURCE}${join(PATH, "package.json")}` }),
      /outside the webview's localResourceRoots/
    )
    await assert.rejects(
      host.request("webview:resource", { handle, uri: "https://example.com/x" }),
      /not a webview resource/
    )
    // A link out of a root is judged by where it leads.
    const outside = mkdtempSync(join(tmpdir(), "webview-outside-"))
    writeFileSync(join(outside, "secret.txt"), "secret")
    const link = join(PATH, "media", `escape-${process.pid}`)
    symlinkSync(join(outside, "secret.txt"), link)
    try {
      await assert.rejects(
        host.request("webview:resource", { handle, uri: `${RESOURCE}${link}` }),
        /outside the webview's localResourceRoots/
      )
    } finally {
      const { rmSync } = await import("node:fs")
      rmSync(link)
    }
    await assert.rejects(
      host.request("webview:resource", { handle: "nope", uri: `${RESOURCE}/x` }),
      /The webview is gone/
    )
  } finally {
    host.stop()
  }
})

test("disposed by the user or by the extension, the panel says so once", async () => {
  const { host, run, sent } = await startWebviews()
  try {
    await run("webviewFixture.panel")
    let handle = sent("window:createWebviewPanel")[0].params.handle
    await host.request("webview:disposed", { handle })
    await host.request("webview:disposed", { handle })
    let state = await run("webviewFixture.state")
    assert.deepEqual(state.events, [{ event: "panelDisposed" }])
    assert.equal(await run("webviewFixture.post"), false)

    await run("webviewFixture.panel")
    handle = sent("window:createWebviewPanel")[1].params.handle
    await run("webviewFixture.dispose")
    await until(() => sent("webview:dispose").length === 1, "dispose")
    assert.equal(sent("webview:dispose")[0].params.handle, handle)
    state = await run("webviewFixture.state")
    assert.deepEqual(state.events.at(-1), { event: "panelDisposed" })
  } finally {
    host.stop()
  }
})

test("a view: registered with its contributed name, resolved on request, shown, unregistered", async () => {
  const { host, run, sent } = await startWebviews()
  try {
    assert.match(await run("webviewFixture.view"), /already registered for webviewFixture\.sidebar/)
    const registration = await until(
      () => sent("window:registerWebviewViewProvider")[0],
      "registration"
    )
    assert.deepEqual(registration.params, {
      extensionId: ID,
      viewId: "webviewFixture.sidebar",
      token: "wvv:cognia.webview-extension:webviewFixture.sidebar",
      title: "Fixture Sidebar",
      retainContextWhenHidden: true,
    })
    const handle = "view:cognia.webview-extension:webviewFixture.sidebar"
    await host.request("extension:call", {
      extensionId: ID,
      token: registration.params.token,
      method: "resolveWebviewView",
      payload: { handle, title: "Fixture Sidebar", state: { saved: 1 } },
    })
    await until(() => sent("webview:update").length === 5, "view updates")
    assert.deepEqual(
      sent("webview:update").map((entry) => {
        const { extensionId, handle: _handle, ...rest } = entry.params
        return rest
      }),
      [
        { options: { enableScripts: true, enableForms: true, enableCommandUris: false } },
        { html: "<p>sidebar</p>" },
        { title: "Sidebar!" },
        { description: "2 items" },
        { badge: { value: 2, tooltip: "Two" } },
      ]
    )
    await run("webviewFixture.showView")
    await until(() => sent("webview:reveal").length === 1, "show")
    await host.request("webview:viewState", { handle, visible: false, active: false })
    await run("webviewFixture.unregisterView")
    await until(() => sent("window:unregisterWebviewViewProvider").length === 1, "unregister")
    const state = await run("webviewFixture.state")
    assert.deepEqual(state.events, [
      { event: "resolved", state: { saved: 1 }, viewType: "webviewFixture.sidebar" },
      { event: "visibility", visible: false },
      { event: "viewDisposed" },
    ])
    assert.deepEqual(state.view, {
      title: "Sidebar!",
      description: "2 items",
      badge: { value: 2, tooltip: "Two" },
      visible: false,
    })
    assert.equal(await run("webviewFixture.serializer"), "ok")
  } finally {
    host.stop()
  }
})
