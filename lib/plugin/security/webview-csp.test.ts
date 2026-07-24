import {
  acquireCogniaContextPanelApiSource,
  acquireCogniaWebviewApiSource,
  buildWebviewCsp,
  wrapWebviewHtml,
} from "./webview-csp"

describe("buildWebviewCsp", () => {
  it("denies connect-src when no domains are declared (fail-closed, egress-consistent)", () => {
    expect(buildWebviewCsp({})).toContain("connect-src 'none'")
    expect(buildWebviewCsp({})).not.toContain("connect-src *")
    expect(buildWebviewCsp({ allowedDomains: [] })).toContain("connect-src 'none'")
    expect(buildWebviewCsp({ allowedDomains: [] })).not.toContain("connect-src *")
  })

  it("uses connect-src * when '*' is declared", () => {
    expect(buildWebviewCsp({ allowedDomains: ["*"] })).toContain("connect-src *")
  })

  it("clamps connect-src to declared https/wss origins", () => {
    const csp = buildWebviewCsp({ allowedDomains: ["api.example.com"] })
    expect(csp).toContain("connect-src https://api.example.com wss://api.example.com")
    expect(csp).not.toContain("connect-src *")
  })

  it("expands multiple domains", () => {
    const csp = buildWebviewCsp({ allowedDomains: ["a.com", "b.com"] })
    expect(csp).toContain("https://a.com")
    expect(csp).toContain("https://b.com")
  })

  it("always sets default-src 'none' and inline script/style", () => {
    const csp = buildWebviewCsp({ allowedDomains: ["x.com"] })
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'unsafe-inline'")
    expect(csp).toContain("style-src 'unsafe-inline'")
  })

  it("ignores blank domain entries", () => {
    const csp = buildWebviewCsp({ allowedDomains: ["  ", "ok.com"] })
    expect(csp).toContain("https://ok.com")
    expect(csp).not.toContain("https:// ")
  })
})

describe("wrapWebviewHtml", () => {
  it("embeds the CSP meta tag and the api polyfill", () => {
    const html = wrapWebviewHtml("<h1>Hi</h1>", { allowedDomains: ["api.example.com"] })
    expect(html).toContain("Content-Security-Policy")
    expect(html).toContain("connect-src https://api.example.com")
    expect(html).toContain("acquireCogniaWebviewApi")
    expect(html).toContain("<h1>Hi</h1>")
    expect(html).toMatch(/^<!doctype html>/)
  })

  it("injects the context-panel client only when asked", () => {
    const plain = wrapWebviewHtml("<main></main>", { allowedDomains: [] })
    expect(plain).not.toContain("acquireCogniaContextPanelApi")

    const panelBacked = wrapWebviewHtml("<main></main>", {
      allowedDomains: [],
      contextPanelApi: true,
    })
    expect(panelBacked).toContain("acquireCogniaContextPanelApi")
  })
})

describe("acquireCogniaContextPanelApiSource", () => {
  it("emits a once-guarded RPC client covering every mirrored method and event", () => {
    const src = acquireCogniaContextPanelApiSource()
    expect(src).toContain("can only be called once")
    expect(src).toContain('"cognia.contextPanel"')
    for (const method of [
      "reveal",
      "setBadge",
      "getActiveContext",
      "getWorkbenchState",
      "setMode",
      "setPinned",
      "register",
      "dispose",
      "onDidChangeActiveContext",
      "onDidChangeWorkbenchState",
      "onDidChangeVisibility",
    ]) {
      expect(src).toContain(method)
    }
    // The ready marker is what makes the host replay missed state.
    expect(src).toContain('kind: "ready"')
  })
})

describe("acquireCogniaWebviewApiSource", () => {
  it("emits a once-guarded postMessage/getState/setState shim", () => {
    const src = acquireCogniaWebviewApiSource()
    expect(src).toContain("can only be called once")
    expect(src).toContain("__cogniaWebview")
    expect(src).toContain("postMessage")
    expect(src).toContain("setState")
  })

  it("listens for the host's restore-state seed and exposes onDidChangeState", () => {
    const src = acquireCogniaWebviewApiSource()
    // The listener must attach at script eval (outside the acquire guard) so a
    // restore posted on iframe load is never missed.
    expect(src).toContain('"restore-state"')
    expect(src).toContain("onDidChangeState")
    expect(src.indexOf("addEventListener")).toBeLessThan(
      src.indexOf("window.acquireCogniaWebviewApi = function")
    )
  })
})
