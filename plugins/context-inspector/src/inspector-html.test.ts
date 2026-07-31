import { buildInspectorHtml, INSPECTOR_PANEL_ID } from "./inspector-html"

describe("buildInspectorHtml", () => {
  const html = buildInspectorHtml()

  it("acquires the context-panel client and exercises every mirrored method", () => {
    expect(html).toContain("acquireCogniaContextPanelApi()")
    for (const method of [
      "setBadge",
      "reveal",
      "setMode",
      "setPinned",
      "getActiveContext",
      "getWorkbenchState",
      "onDidChangeActiveContext",
      "onDidChangeWorkbenchState",
      "onDidChangeVisibility",
    ]) {
      expect(html).toContain(`api.${method}(`)
    }
  })

  it("targets its own panel id for self-referencing calls", () => {
    expect(html).toContain(JSON.stringify(INSPECTOR_PANEL_ID))
  })

  it("is self-contained — no external scripts or stylesheets (CSP would block them)", () => {
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
  })
})
