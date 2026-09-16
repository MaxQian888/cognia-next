import {
  buildInspectorHtml,
  buildProbeHtml,
  INSPECTOR_PANEL_ID,
  PROBE_PANEL_ID,
  PROBE_WEBVIEW_ID,
} from "./inspector-html"

describe("buildInspectorHtml", () => {
  const html = buildInspectorHtml()

  it("acquires the context-panel client and exercises every mirrored method", () => {
    expect(html).toContain("acquireCogniaContextPanelApi()")
    for (const method of [
      "setBadge",
      "reveal",
      "setMode",
      "setPinned",
      "register",
      "dispose",
      "getActiveContext",
      "getWorkbenchState",
      "onDidChangeActiveContext",
      "onDidChangeWorkbenchState",
      "onDidChangeVisibility",
    ]) {
      expect(html).toContain(`api.${method}(`)
    }
  })

  it("acquires the generic webview client and persists state across remounts", () => {
    expect(html).toContain("acquireCogniaWebviewApi()")
    for (const method of ["getState", "setState", "onDidChangeState"]) {
      expect(html).toContain(`webview.${method}(`)
    }
  })

  it("targets its own panel id for self-referencing calls", () => {
    expect(html).toContain(JSON.stringify(INSPECTOR_PANEL_ID))
  })

  it("registers the probe panel through the webview the manifest declares", () => {
    // `api.register` requires { id, webview, label, labelKey, resourceKinds,
    // activity } — pin the whole payload so a silent contract break fails here.
    expect(html).toContain(`id: PROBE_PANEL_ID`)
    expect(html).toContain(`webview: PROBE_WEBVIEW_ID`)
    expect(html).toContain(`label: "Inspector probe"`)
    expect(html).toContain(`labelKey: "panel.probe"`)
    expect(html).toContain(`resourceKinds: ["session"]`)
    expect(html).toContain(`activity: "inspect"`)
    expect(html).toContain(JSON.stringify(PROBE_PANEL_ID))
    expect(html).toContain(JSON.stringify(PROBE_WEBVIEW_ID))
    expect(html).toContain(`api.dispose(id)`)
  })

  it("reveals the probe panel across frames and guards in-flight register/dispose", () => {
    // reveal(panelId) qualifies the id under the calling plugin — the
    // inspector frame can bring its own dynamically registered panel forward.
    expect(html).toContain(`api.reveal(PROBE_PANEL_ID, "wide")`)
    // Both buttons disable for the duration of their RPC so a double-click
    // cannot register the same panel twice or dispose a stale id.
    expect(html).toContain(`var button = $("register");`)
    expect(html).toContain(`var button = $("dispose");`)
    expect(html).toContain(`button.disabled = true;`)
    expect(html).toContain(`.then(syncProbeButtons)`)
  })

  it("surfaces the workbench split layout", () => {
    expect(html).toContain("splitPanelId")
    expect(html).toContain("chip-split")
    // [hidden] on an inline-flex chip needs an explicit display rule.
    expect(html).toContain(".chip[hidden]")
  })

  it("exposes the log and the missing-API banner to assistive tech", () => {
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('role="alert"')
  })

  it("offers every workbench mode and every reveal mode", () => {
    for (const mode of ["collapsed", "narrow", "wide", "focus"]) {
      expect(html).toContain(`data-mode="${mode}"`)
    }
    for (const mode of ["narrow", "wide", "focus"]) {
      expect(html).toContain(`data-reveal="${mode}"`)
    }
  })

  it("gates layout controls on ownsActivePanel and mirrors userPinned", () => {
    // setMode/setPinned return false unless this plugin owns the visible
    // panel — the reference implementation must show that gate, not let a
    // click fail silently.
    expect(html).toContain("ownsActivePanel")
    expect(html).toContain("userPinned")
    expect(html).toContain('aria-pressed"')
  })

  it("renders against the injected design-token contract, not fixed colors", () => {
    for (const token of [
      "--background",
      "--foreground",
      "--card",
      "--muted",
      "--muted-foreground",
      "--secondary",
      "--accent",
      "--border",
      "--input",
      "--ring",
      "--radius",
      "--destructive",
      "--success",
      "--density-spacing",
      "--density-gap",
      "--density-input-height",
      "--motion-duration-scale",
    ]) {
      expect(html).toContain(`var(${token}`)
    }
    // The plugin-ui motion vocabulary is baked into the transitions.
    expect(html).toContain("cubic-bezier(0.32, 0.72, 0, 1)")
  })

  it("degrades visibly when the mirrored API is not injected", () => {
    expect(html).toContain('typeof window.acquireCogniaContextPanelApi === "function"')
    expect(html).toContain("api-banner")
  })

  it("bounds the log so a long session cannot grow the DOM forever", () => {
    expect(html).toContain("LOG_LIMIT")
    expect(html).toContain("removeChild")
  })

  it("is self-contained — no external scripts or stylesheets (CSP would block them)", () => {
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })
})

describe("buildProbeHtml", () => {
  const html = buildProbeHtml()

  it("gets the mirrored panel API like a manifest-declared panel frame", () => {
    expect(html).toContain("acquireCogniaContextPanelApi()")
    expect(html).toContain("api.onDidChangeActiveContext(")
    expect(html).toContain("api.onDidChangeVisibility(")
    expect(html).toContain("api.getActiveContext()")
  })

  it("acts on itself — a dynamically registered panel owns write calls too", () => {
    expect(html).toContain(`api.setBadge(PANEL_ID, badge)`)
    expect(html).toContain(`api.reveal(PANEL_ID, "focus")`)
    expect(html).toContain(JSON.stringify(PROBE_PANEL_ID))
  })

  it("is self-contained — no external scripts or stylesheets", () => {
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })
})
