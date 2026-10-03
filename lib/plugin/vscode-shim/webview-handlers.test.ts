/**
 * @jest-environment jsdom
 */

type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockLog = jest.fn()
jest.mock("./vscode-log-buffer", () => ({
  appendVscodeLog: (...args: unknown[]) => mockLog(...args),
}))

const mockOpenExternal = jest.fn(async (_pluginId: string, _href: string) => true)
jest.mock("./env-handlers", () => ({
  openExternal: (pluginId: string, href: string) => mockOpenExternal(pluginId, href),
}))
const mockExecute = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/plugin/commands/registry", () => ({
  executeCommandWithOptions: (...args: unknown[]) => mockExecute(...args),
}))

import {
  __resetWebviewBridgeForTesting,
  getSelectedWebview,
  getWebview,
  listWebviews,
  postToWebview,
  selectWebview,
} from "./webview-bridge"
import { bytesToBase64, WEBVIEW_RESOURCE_ORIGIN } from "./webview-document"
import {
  __resetVscodeWebviewsForTesting,
  clearVscodeWebviewsForPlugin,
  closeWebview,
  configureVscodeWebviews,
  connectWebviewFrame,
  createVscodeWebviewDependencies,
  installVscodeWebviewHandlers,
  parseCommandUri,
  prepareWebviewFrame,
  reportWebviewVisibility,
  WEBVIEW_SHELL_PATH,
  type VscodeWebviewDependencies,
} from "./webview-handlers"

const MARK = "__vscodeWebview"
const R = (path: string) => `${WEBVIEW_RESOURCE_ORIGIN}${path}`

function setup(files: Record<string, string> = {}) {
  const sent: Array<[string, string, Record<string, unknown>]> = []
  const deps: VscodeWebviewDependencies = {
    sendToHost: jest.fn(async (pluginId: string, method: string, payload: unknown) => {
      sent.push([pluginId, method, payload as Record<string, unknown>])
      if (method === "webview:resource") {
        const uri = (payload as { uri: string }).uri
        if (!(uri in files)) throw new Error(`${uri} is outside the webview's localResourceRoots`)
        return {
          data: bytesToBase64(new TextEncoder().encode(files[uri])),
          mime: "text/javascript",
        }
      }
      return null
    }),
    openLink: (pluginId, href) => mockOpenExternal(pluginId, href),
    executeCommand: (command, args) => mockExecute(command, { origin: "user" }, ...args),
    theme: () => ({ css: ":root { --vscode-foreground: red; }", kind: "vscode-dark" }),
    origin: () => "tauri://localhost",
  }
  configureVscodeWebviews(deps)
  const call = async (method: string, payload: Record<string, unknown>, pluginId = "acme.ext") =>
    handlers.get(method)!(
      { extensionId: pluginId, ...payload },
      {
        pluginId,
        method,
        requestId: null,
      }
    )
  const reports = (method: string) =>
    sent.filter(([, name]) => name === method).map(([, , payload]) => payload)
  return { deps, call, sent, reports }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

async function panel(
  h: ReturnType<typeof setup>,
  handle = "p1",
  options: Record<string, unknown> = { enableScripts: true },
  extra: Record<string, unknown> = {}
) {
  await h.call("window:createWebviewPanel", {
    handle,
    viewType: "acme.preview",
    title: "Preview",
    options,
    ...extra,
  })
}

beforeEach(() => {
  handlers.clear()
  jest.clearAllMocks()
  __resetWebviewBridgeForTesting()
  __resetVscodeWebviewsForTesting()
  installVscodeWebviewHandlers()
})

describe("panels", () => {
  it("open as a selected tab with their options, unless the extension keeps focus", async () => {
    const h = setup()
    await panel(h, "p1", {
      enableScripts: true,
      enableCommandUris: ["acme.run", 3],
      localResourceRoots: ["file:///ext"],
      retainContextWhenHidden: true,
    })
    expect(getWebview("p1")).toMatchObject({
      pluginId: "acme.ext",
      kind: "panel",
      viewType: "acme.preview",
      title: "Preview",
      resolved: true,
      options: {
        enableScripts: true,
        enableForms: false,
        enableCommandUris: ["acme.run"],
        localResourceRoots: ["file:///ext"],
        retainContextWhenHidden: true,
      },
    })
    await panel(h, "p2", {}, { preserveFocus: true })
    expect(getSelectedWebview()).toBe("p1")
    await expect(panel(h, "p1")).rejects.toThrow(/already exists/)
  })

  it("take html, options and titles, reveal and dispose, for their own extension only", async () => {
    const h = setup()
    await panel(h, "p1")
    await panel(h, "p2")
    await h.call("webview:update", { handle: "p1", html: "<p>1</p>", title: "One" })
    await h.call("webview:update", { handle: "p1", options: { enableScripts: false } })
    expect(getWebview("p1")).toMatchObject({ html: "<p>1</p>", title: "One", revision: 2 })
    expect(getWebview("p1")?.options.enableScripts).toBe(false)
    await h.call("webview:reveal", { handle: "p1" })
    expect(getSelectedWebview()).toBe("p1")
    await expect(h.call("webview:reveal", { handle: "p1" }, "other.ext")).rejects.toThrow(/is gone/)
    await h.call("webview:dispose", { handle: "p1" })
    expect(getWebview("p1")).toBeUndefined()
    expect(h.reports("webview:disposed")).toEqual([])
  })

  it("closed by the user tell the extension", async () => {
    const h = setup()
    await panel(h)
    closeWebview("p1")
    closeWebview("p1")
    await flush()
    expect(h.reports("webview:disposed")).toEqual([{ handle: "p1" }])
  })
})

describe("views", () => {
  it("wait for their tab to be shown, then ask the provider once to fill them", async () => {
    const h = setup()
    await panel(h)
    await h.call("window:registerWebviewViewProvider", {
      viewId: "acme.sidebar",
      token: "wvv:acme.ext:acme.sidebar",
      title: "Acme",
      retainContextWhenHidden: true,
    })
    const handle = "view:acme.ext:acme.sidebar"
    expect(getWebview(handle)).toMatchObject({ kind: "view", resolved: false, title: "Acme" })
    expect(h.reports("extension:call")).toEqual([])
    selectWebview(handle)
    selectWebview("p1")
    selectWebview(handle)
    await flush()
    expect(h.reports("extension:call")).toEqual([
      {
        extensionId: "acme.ext",
        token: "wvv:acme.ext:acme.sidebar",
        method: "resolveWebviewView",
        payload: { handle, title: "Acme", state: undefined },
      },
    ])
    // A view keeps its registration's retention whatever its webview options say.
    await h.call("webview:update", {
      handle,
      options: { enableScripts: true },
      description: "3 items",
      badge: { value: 3, tooltip: "Three" },
    })
    expect(getWebview(handle)).toMatchObject({
      description: "3 items",
      badge: { value: 3, tooltip: "Three" },
      options: { enableScripts: true, retainContextWhenHidden: true },
    })
    await h.call("webview:update", { handle, description: null, badge: null })
    expect(getWebview(handle)?.badge).toBeUndefined()
    await h.call("window:unregisterWebviewViewProvider", { viewId: "acme.sidebar" })
    expect(getWebview(handle)).toBeUndefined()
  })

  it("log a provider that cannot be reached", async () => {
    const h = setup()
    ;(h.deps.sendToHost as jest.Mock).mockRejectedValueOnce(new Error("host gone"))
    await h.call("window:registerWebviewViewProvider", { viewId: "v", token: "t" })
    await flush()
    expect(mockLog).toHaveBeenCalledWith(
      "acme.ext",
      expect.objectContaining({ level: "warn", message: expect.stringMatching(/host gone/) })
    )
    expect(getWebview("view:acme.ext:v")?.title).toBe("v")
  })
})

it("reports a tab's visibility only when it changes", async () => {
  const h = setup()
  await panel(h)
  reportWebviewVisibility("p1", true)
  reportWebviewVisibility("p1", true)
  reportWebviewVisibility("p1", false)
  reportWebviewVisibility("gone", true)
  await flush()
  expect(h.reports("webview:viewState")).toEqual([
    { handle: "p1", visible: true, active: true },
    { handle: "p1", visible: false, active: false },
  ])
})

it("prepares the frame's document from the host's files, sandboxed as the options allow", async () => {
  const h = setup({ [R("/ext/main.js")]: "run()" })
  await panel(h, "p1", { enableScripts: true, enableForms: true })
  await h.call("webview:update", {
    handle: "p1",
    html: `<base href="${R("/ext/")}"><script src="main.js"></script><img src="${R("/secret.png")}">`,
  })
  const prepared = await prepareWebviewFrame("p1")
  expect(prepared.sandbox).toBe("allow-scripts allow-forms")
  expect(prepared.scripts).toEqual([
    { code: "run()", nonce: undefined, module: false, url: R("/ext/main.js") },
  ])
  expect(prepared.baseUrl).toBe(R("/ext/"))
  expect(prepared.srcDoc).toContain(`tauri://localhost${WEBVIEW_SHELL_PATH}`)
  expect(mockLog).toHaveBeenCalledWith(
    "acme.ext",
    expect.objectContaining({ kind: "webview", message: expect.stringMatching(/secret\.png/) })
  )
  await h.call("webview:update", { handle: "p1", options: {} })
  expect((await prepareWebviewFrame("p1")).sandbox).toBe("")
  await expect(prepareWebviewFrame("gone")).rejects.toThrow(/is gone/)
})

describe("the frame connection", () => {
  async function connected(options: Record<string, unknown> = { enableScripts: true }) {
    const h = setup({ [R("/ext/data.json")]: '{"a":1}' })
    await panel(h, "p1", options)
    const posted: Array<Record<string, unknown>> = []
    const connection = connectWebviewFrame(
      "p1",
      {
        srcDoc: "",
        sandbox: "allow-scripts",
        scripts: [{ code: "x()", module: false }],
        baseUrl: R("/ext/"),
      },
      (envelope) => posted.push(envelope)
    )
    return { h, posted, connection }
  }

  it("hands over scripts and state when ready, and holds messages until they ran", async () => {
    const { posted, connection } = await connected()
    expect(postToWebview("p1", { n: 1 })).toBe(true)
    connection.receive({ [MARK]: "set-state", state: { saved: true } })
    connection.receive({ [MARK]: "ready" })
    expect(posted).toEqual([
      {
        [MARK]: "load",
        scripts: [{ code: "x()", module: false }],
        state: { saved: true },
        baseUrl: R("/ext/"),
      },
    ])
    connection.receive({ [MARK]: "loaded" })
    postToWebview("p1", { n: 2 })
    expect(posted.slice(1)).toEqual([
      { [MARK]: "message", data: { n: 1 } },
      { [MARK]: "message", data: { n: 2 } },
    ])
    connection.updateTheme()
    expect(posted.at(-1)).toEqual({
      [MARK]: "theme",
      css: ":root { --vscode-foreground: red; }",
      kind: "vscode-dark",
    })
    connection.dispose()
    expect(postToWebview("p1", { n: 3 })).toBe(false)
    connection.receive({ [MARK]: "ready" })
    expect(posted).toHaveLength(4)
  })

  it("forwards the page's messages and answers resources", async () => {
    const { h, posted, connection } = await connected()
    connection.receive({ [MARK]: "post", data: { command: "hi" } })
    connection.receive({ [MARK]: "resource", id: 1, url: R("/ext/data.json") })
    connection.receive({ [MARK]: "resource", id: 2, url: R("/elsewhere") })
    connection.receive({ unrelated: true })
    connection.receive(null)
    await flush()
    expect(h.reports("webview:message")).toEqual([{ handle: "p1", message: { command: "hi" } }])
    expect(posted).toEqual([
      {
        [MARK]: "resource",
        id: 1,
        ok: true,
        data: bytesToBase64(new TextEncoder().encode('{"a":1}')),
        mime: "text/javascript",
      },
      {
        [MARK]: "resource",
        id: 2,
        ok: false,
        error: `${R("/elsewhere")} is outside the webview's localResourceRoots`,
      },
    ])
  })

  it("opens links, and runs command links only as enableCommandUris allows", async () => {
    const { connection } = await connected({ enableScripts: true, enableCommandUris: ["acme.ok"] })
    connection.receive({ [MARK]: "link", href: "https://example.com" })
    connection.receive({
      [MARK]: "link",
      href: `command:acme.ok?${encodeURIComponent(JSON.stringify(["a", 1]))}`,
    })
    connection.receive({ [MARK]: "link", href: "command:acme.denied" })
    await flush()
    expect(mockOpenExternal).toHaveBeenCalledWith("acme.ext", "https://example.com")
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockExecute).toHaveBeenCalledWith("acme.ok", { origin: "user" }, "a", 1)
    expect(mockLog).toHaveBeenCalledWith(
      "acme.ext",
      expect.objectContaining({ message: expect.stringMatching(/acme\.denied/) })
    )
  })
})

it("parses command links with one argument, several, or none", () => {
  expect(parseCommandUri("command:a.b")).toEqual({ command: "a.b", args: [] })
  expect(parseCommandUri(`command:a.b?${encodeURIComponent('{"x":1}')}`)).toEqual({
    command: "a.b",
    args: [{ x: 1 }],
  })
  expect(parseCommandUri("command:a.b?not-json")).toEqual({ command: "a.b", args: [] })
  expect(parseCommandUri("https://x")).toBeUndefined()
})

it("closes a stopped extension's webviews without telling it", async () => {
  const h = setup()
  await panel(h, "p1")
  await panel(h, "o1", {}, {})
  await h.call(
    "window:createWebviewPanel",
    { handle: "x1", viewType: "x", title: "X" },
    "other.ext"
  )
  clearVscodeWebviewsForPlugin("acme.ext")
  await flush()
  expect(listWebviews().map((webview) => webview.handle)).toEqual(["x1"])
  expect(h.reports("webview:disposed")).toEqual([])
})

it("builds its production dependencies on the app's origin", () => {
  const deps = createVscodeWebviewDependencies({ sendToHost: jest.fn() })
  expect(deps.origin()).toBe(window.location.origin)
  expect(deps.theme().kind).toMatch(/^vscode-(light|dark)$/)
})

it("fails plainly before the loader configures it", async () => {
  await expect(
    (async () =>
      handlers.get("window:createWebviewPanel")!(
        { handle: "h", viewType: "v" },
        { pluginId: "a.b", method: "window:createWebviewPanel", requestId: null }
      ))().then(() => prepareWebviewFrame("h"))
  ).rejects.toThrow(/not available yet/)
})
