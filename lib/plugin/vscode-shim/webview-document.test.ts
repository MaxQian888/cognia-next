/**
 * @jest-environment jsdom
 */

import {
  bytesToBase64,
  isWebviewResource,
  prepareWebviewDocument,
  WEBVIEW_RESOURCE_ORIGIN,
  webviewFrameCsp,
  type WebviewResource,
} from "./webview-document"

const R = (path: string) => `${WEBVIEW_RESOURCE_ORIGIN}${path}`
const encoder = new TextEncoder()

function files(entries: Record<string, [string, string]>) {
  const read = jest.fn(async (url: string): Promise<WebviewResource> => {
    const entry = entries[url]
    if (!entry) throw new Error("outside the webview's localResourceRoots")
    return { bytes: encoder.encode(entry[1]), mime: entry[0] }
  })
  return read
}

const base64 = (text: string) => bytesToBase64(encoder.encode(text))

async function prepare(html: string, read: ReturnType<typeof files>, enableScripts = true) {
  const prepared = await prepareWebviewDocument({
    html,
    enableScripts,
    shellUrl: "tauri://localhost/vscode-webview/webview-shell.js",
    shellOrigin: "tauri://localhost",
    readResource: read,
    themeCss: ":root { --vscode-foreground: red; }",
    themeKind: "vscode-dark",
  })
  const doc = new DOMParser().parseFromString(prepared.srcDoc, "text/html")
  return { prepared, doc }
}

it("takes the scripts out in order, inline and from files, keeping nonces and modules", async () => {
  const read = files({ [R("/ext/main.js")]: ["text/javascript", "console.log('main')"] })
  const { prepared, doc } = await prepare(
    `<html><head><meta http-equiv="Content-Security-Policy" content="script-src 'nonce-n1'">
      <script nonce="n1">window.first = 1</script></head>
      <body><p>Hi</p><script nonce="n1" src="${R("/ext/main.js")}"></script>
      <script type="module">import "./x.js"</script>
      <script type="application/json" id="data">{"a":1}</script>
      <script src="https://cdn.example.com/lib.js"></script></body></html>`,
    read
  )
  expect(prepared.scripts).toEqual([
    { code: "window.first = 1", nonce: "n1", module: false },
    { code: "console.log('main')", nonce: "n1", module: false, url: R("/ext/main.js") },
    { code: 'import "./x.js"', nonce: undefined, module: true },
  ])
  // Data blocks stay; executable scripts are gone; the shell is first in <head>.
  const scripts = [...doc.querySelectorAll("script")]
  expect(scripts.map((script) => script.getAttribute("src") ?? script.id)).toEqual([
    "tauri://localhost/vscode-webview/webview-shell.js",
    "data",
  ])
  expect(doc.head.firstElementChild?.getAttribute("content")).toBe(
    webviewFrameCsp("tauri://localhost")
  )
  // The extension's own policy is kept.
  expect(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).toHaveLength(2)
  expect(prepared.warnings).toEqual([
    "Script https://cdn.example.com/lib.js is not a webview resource and cannot load",
  ])
})

it("runs nothing when scripts are off, and loads no shell", async () => {
  const { prepared, doc } = await prepare(
    `<body><script>alert(1)</script><p>static</p></body>`,
    files({}),
    false
  )
  expect(prepared.scripts).toEqual([])
  expect(doc.querySelectorAll("script")).toHaveLength(0)
  expect(doc.body.textContent).toContain("static")
})

it("inlines stylesheets with their urls and imports, and media as data", async () => {
  const read = files({
    [R("/ext/css/main.css")]: [
      "text/css",
      `@import "./base.css"; .icon { background: url('../img/icon.svg#a'); } .remote { background: url(https://x/y.png) }`,
    ],
    [R("/ext/css/base.css")]: ["text/css", `body { font: url(font.woff2) }`],
    [R("/ext/css/font.woff2")]: ["font/woff2", "FONT"],
    [R("/ext/img/icon.svg")]: ["image/svg+xml", "<svg/>"],
    [R("/ext/img/a.png")]: ["image/png", "PNG"],
    [R("/ext/img/a2.png")]: ["image/png", "PNG2"],
  })
  const { prepared, doc } = await prepare(
    `<head><base href="${R("/ext/")}"><link rel="stylesheet" media="screen" href="css/main.css">
      <link rel="icon" href="img/icon.svg"></head>
      <body><img src="img/a.png" srcset="img/a.png 1x, img/a2.png 2x">
      <div style="background: url(img/a.png)"></div>
      <img src="https://example.com/remote.png"></body>`,
    read
  )
  expect(prepared.baseUrl).toBe(R("/ext/"))
  expect(doc.querySelector("base")).toBeNull()
  expect(doc.querySelector("link")).toBeNull()
  const style = [...doc.querySelectorAll("style")].at(-1)!
  expect(style.getAttribute("media")).toBe("screen")
  expect(style.textContent).toContain(`url("data:font/woff2;base64,${base64("FONT")}")`)
  expect(style.textContent).toContain(`url("data:image/svg+xml;base64,${base64("<svg/>")}#a")`)
  expect(style.textContent).toContain("url(https://x/y.png)")
  expect(style.textContent).not.toContain("@import")
  const [image, remote] = [...doc.querySelectorAll("img")]
  expect(image.getAttribute("src")).toBe(`data:image/png;base64,${base64("PNG")}`)
  expect(image.getAttribute("srcset")).toBe(
    `data:image/png;base64,${base64("PNG")} 1x, data:image/png;base64,${base64("PNG2")} 2x`
  )
  expect(remote.getAttribute("src")).toBe("https://example.com/remote.png")
  expect(doc.querySelector("div")?.getAttribute("style")).toContain("data:image/png")
  // Each file is read once.
  expect(read.mock.calls.filter(([url]) => url === R("/ext/img/a.png"))).toHaveLength(1)
})

it("reports what it could not read, and leaves the reference", async () => {
  const { prepared, doc } = await prepare(
    `<body><img src="${R("/secret/key.png")}"><link rel="stylesheet" href="${R("/gone.css")}"></body>`,
    files({})
  )
  expect(doc.querySelector("img")?.getAttribute("src")).toBe(R("/secret/key.png"))
  expect(prepared.warnings).toEqual([
    `Could not load ${R("/gone.css")}: outside the webview's localResourceRoots`,
    `Could not load ${R("/secret/key.png")}: outside the webview's localResourceRoots`,
  ])
})

it("stops stylesheet imports that nest too deep", async () => {
  const entries: Record<string, [string, string]> = {}
  for (let depth = 0; depth < 7; depth += 1) {
    entries[R(`/c${depth}.css`)] = [
      "text/css",
      `@import "${R(`/c${depth + 1}.css`)}"; .d${depth}{}`,
    ]
  }
  const { prepared } = await prepare(
    `<head><link rel="stylesheet" href="${R("/c0.css")}"></head>`,
    files(entries)
  )
  expect(prepared.warnings.some((warning) => warning.includes("nest deeper than 4"))).toBe(true)
})

it("themes the body and the frame", async () => {
  const { doc } = await prepare(`<body class="vscode-light other"></body>`, files({}))
  expect(doc.body.className).toBe("other vscode-dark")
  expect(doc.body.getAttribute("data-vscode-theme-kind")).toBe("vscode-dark")
  expect(doc.getElementById("_vscodeThemeVariables")?.textContent).toBe(
    ":root { --vscode-foreground: red; }"
  )
  expect(doc.getElementById("_vscodeDefaultStyles")?.textContent).toContain("--vscode-font-family")
})

it("knows a webview resource URI when it sees one", () => {
  expect(isWebviewResource(R("/a"))).toBe(true)
  expect(isWebviewResource("https://example.com/a")).toBe(false)
  expect(isWebviewResource(undefined)).toBe(false)
  expect(bytesToBase64(new Uint8Array(70_000).fill(65))).toBe(btoa("A".repeat(70_000)))
})
