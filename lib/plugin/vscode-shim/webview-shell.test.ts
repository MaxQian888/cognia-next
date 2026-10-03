/**
 * @jest-environment jsdom
 */

// The in-frame shell (`public/vscode-webview/webview-shell.js`), run in a real
// child frame whose parent is this test, standing in for the app.

import { readFileSync } from "node:fs"
import { join } from "node:path"

const SHELL = readFileSync(join(process.cwd(), "public/vscode-webview/webview-shell.js"), "utf-8")
const MARK = "__vscodeWebview"
const RESOURCE = "https://file+.vscode-resource.cognia.invalid"

type FrameWindow = Window & typeof globalThis & { eval(code: string): unknown }

/** jsdom has no fetch `Response`; this is the part the shell uses. */
class FakeResponse {
  readonly headers: Map<string, string>
  constructor(
    private readonly body: Uint8Array | string,
    init: { status?: number; headers?: Record<string, string> } = {}
  ) {
    this.headers = new Map(Object.entries(init.headers ?? {}))
  }
  async text(): Promise<string> {
    return typeof this.body === "string" ? this.body : new TextDecoder().decode(this.body)
  }
}

function startFrame() {
  const iframe = document.createElement("iframe")
  document.body.appendChild(iframe)
  const frame = iframe.contentWindow as FrameWindow
  frame.document.body.innerHTML = '<style id="_vscodeThemeVariables"></style><p>page</p>'
  let blobs = 0
  frame.URL.createObjectURL = jest.fn(() => `blob:frame/${++blobs}`)
  frame.URL.revokeObjectURL = jest.fn()
  ;(frame as unknown as { Response: unknown }).Response = FakeResponse
  const fetched: string[] = []
  frame.fetch = jest.fn(async (input: RequestInfo | URL) => {
    fetched.push(String(input))
    return new FakeResponse("network") as unknown as Response
  }) as typeof fetch
  // jsdom's postMessage carries no `source`, so the app's side is read where
  // the shell calls it: on its parent, this window.
  const sent: Array<Record<string, unknown>> = []
  const post = jest
    .spyOn(window, "postMessage")
    .mockImplementation((message: unknown) => void sent.push(message as Record<string, unknown>))
  frame.eval(SHELL)
  /** An envelope from the app, as the frame receives it. */
  const deliver = (data: unknown, source: Window | null = window) =>
    frame.dispatchEvent(new frame.MessageEvent("message", { data, source }))
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const scripts = () => [...frame.document.querySelectorAll("script")]
  return { iframe, frame, sent, deliver, settle, scripts, fetched, stop: () => post.mockRestore() }
}

afterEach(() => {
  document.body.innerHTML = ""
})

it("announces itself, and gives the page one VS Code API", async () => {
  const f = startFrame()
  await f.settle()
  expect(f.sent).toEqual([{ [MARK]: "ready" }])
  const acquire = (
    f.frame as unknown as { acquireVsCodeApi(): Record<string, (v?: unknown) => unknown> }
  ).acquireVsCodeApi
  const api = acquire()
  expect(() => acquire()).toThrow(/already been acquired/)
  api.postMessage({ hello: 1 })
  expect(api.setState({ count: 2 })).toEqual({ count: 2 })
  expect(api.getState()).toEqual({ count: 2 })
  await f.settle()
  expect(f.sent.slice(1)).toEqual([
    { [MARK]: "post", data: { hello: 1 } },
    { [MARK]: "set-state", state: { count: 2 } },
  ])
  f.stop()
})

it("runs the scripts one by one as blobs with their nonces, then fires the load events", async () => {
  const f = startFrame()
  // The frame's own load has happened by the time the app hands over scripts.
  await f.settle()
  const events: string[] = []
  f.frame.document.addEventListener("DOMContentLoaded", () => events.push("DOMContentLoaded"))
  f.frame.addEventListener("load", () => events.push("load"))
  f.deliver({
    [MARK]: "load",
    state: { restored: true },
    baseUrl: `${RESOURCE}/ext/`,
    scripts: [
      { code: "a()", nonce: "n1", module: false, url: `${RESOURCE}/ext/main.js` },
      { code: "b()", module: true },
    ],
  })
  let [first] = f.scripts()
  expect(first.getAttribute("src")).toBe("blob:frame/1")
  expect(first.getAttribute("nonce")).toBe("n1")
  // While it runs, the page sees the file it came from.
  expect(f.frame.document.currentScript?.getAttribute("src")).toBe(`${RESOURCE}/ext/main.js`)
  expect(f.scripts()).toHaveLength(1)
  first.dispatchEvent(new Event("load"))
  expect(f.frame.document.currentScript).toBeNull()
  const second = f.scripts()[1]
  expect(second.type).toBe("module")
  second.dispatchEvent(new Event("error"))
  ;[first] = f.scripts()
  first.dispatchEvent(new Event("load"))
  await f.settle()
  expect(events).toEqual(["DOMContentLoaded", "load"])
  expect(f.sent.at(-1)).toEqual({ [MARK]: "loaded" })
  const api = (
    f.frame as unknown as { acquireVsCodeApi(): { getState(): unknown } }
  ).acquireVsCodeApi()
  expect(api.getState()).toEqual({ restored: true })
  f.stop()
})

it("delivers the extension's messages and keeps the app's envelopes from the page", async () => {
  const f = startFrame()
  const seen: unknown[] = []
  f.frame.addEventListener("message", (event) => seen.push((event as MessageEvent).data))
  f.deliver({ [MARK]: "message", data: { command: "refresh" } })
  f.deliver({ [MARK]: "theme", css: ":root{--vscode-foreground: blue}", kind: "vscode-dark" })
  // Something else in the frame posting an envelope is not the app.
  f.deliver({ [MARK]: "message", data: "spoofed" }, null)
  expect(seen).toEqual([{ command: "refresh" }, { [MARK]: "message", data: "spoofed" }])
  expect(f.frame.document.getElementById("_vscodeThemeVariables")?.textContent).toBe(
    ":root{--vscode-foreground: blue}"
  )
  expect(f.frame.document.body.classList.contains("vscode-dark")).toBe(true)
  expect(f.frame.document.body.getAttribute("data-vscode-theme-kind")).toBe("vscode-dark")
  f.stop()
})

it("answers resource URIs the page sets or fetches with the file, through the app", async () => {
  const f = startFrame()
  f.deliver({ [MARK]: "load", scripts: [], baseUrl: `${RESOURCE}/ext/` })
  await f.settle()
  const image = f.frame.document.createElement("img")
  image.src = "img/logo.png"
  const chunk = f.frame.document.createElement("script")
  chunk.setAttribute("src", `${RESOURCE}/ext/chunk.js`)
  const plain = f.frame.document.createElement("img")
  plain.src = "data:image/png;base64,AA=="
  expect(plain.getAttribute("src")).toBe("data:image/png;base64,AA==")
  expect(image.getAttribute("src")).toBeNull()
  const requests = f.sent.filter((message) => message[MARK] === "resource")
  expect(requests).toEqual([
    { [MARK]: "resource", id: 1, url: `${RESOURCE}/ext/img/logo.png` },
    { [MARK]: "resource", id: 2, url: `${RESOURCE}/ext/chunk.js` },
  ])
  f.deliver({ [MARK]: "resource", id: 1, ok: true, data: btoa("PNG"), mime: "image/png" })
  f.deliver({ [MARK]: "resource", id: 2, ok: false, error: "outside the roots" })
  await f.settle()
  expect(image.getAttribute("src")).toBe("blob:frame/1")
  // A file the app refused fails as a missing file would.
  expect(chunk.getAttribute("src")).toBe(`${RESOURCE}/ext/chunk.js`)

  const response = f.frame.fetch("data.json")
  await f.settle()
  const fetchRequest = f.sent.filter((message) => message[MARK] === "resource").at(-1)!
  expect(fetchRequest.url).toBe(`${RESOURCE}/ext/data.json`)
  f.deliver({
    [MARK]: "resource",
    id: fetchRequest.id,
    ok: true,
    data: btoa('{"a":1}'),
    mime: "application/json",
  })
  const body = await response
  expect(body.headers.get("Content-Type")).toBe("application/json")
  expect(await body.text()).toBe('{"a":1}')
  await f.frame.fetch("https://example.com/x")
  expect(f.fetched).toEqual(["https://example.com/x"])
  f.stop()
})

it("sends link clicks to the app, leaving in-page anchors alone", async () => {
  const f = startFrame()
  f.deliver({ [MARK]: "load", scripts: [], baseUrl: `${RESOURCE}/ext/` })
  f.frame.document.body.innerHTML =
    '<a id="web" href="https://example.com/a">web</a><a id="cmd" href="command:acme.run?%5B1%5D">cmd</a>' +
    '<a id="rel" href="docs/readme.md">rel</a><a id="hash" href="#top">top</a><a id="handled" href="https://x">x</a>'
  f.frame.document
    .getElementById("handled")!
    .addEventListener("click", (event) => event.preventDefault())
  // After the shell has seen each click: was it left to the browser?
  const leftAlone: string[] = []
  f.frame.addEventListener("click", (event) => {
    if (!event.defaultPrevented) leftAlone.push((event.target as Element).id)
    // jsdom cannot follow even an in-page anchor in an about:blank frame.
    event.preventDefault()
  })
  for (const id of ["web", "cmd", "rel", "hash", "handled"]) {
    f.frame.document
      .getElementById(id)!
      .dispatchEvent(new f.frame.MouseEvent("click", { bubbles: true, cancelable: true }))
  }
  expect(leftAlone).toEqual(["hash"])
  await f.settle()
  expect(f.sent.filter((message) => message[MARK] === "link")).toEqual([
    { [MARK]: "link", href: "https://example.com/a" },
    { [MARK]: "link", href: "command:acme.run?%5B1%5D" },
    { [MARK]: "link", href: `${RESOURCE}/ext/docs/readme.md` },
  ])
  f.stop()
})
