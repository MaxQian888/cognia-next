import { defineWebview } from "./define-webview"

describe("defineWebview", () => {
  it("returns the webview definition unchanged", () => {
    const w = defineWebview({
      id: "dash",
      containerId: "explorer",
      title: "Dashboard",
      html: "<h1>Hi</h1>",
    })
    expect(w).toMatchObject({ id: "dash", containerId: "explorer", html: "<h1>Hi</h1>" })
  })

  it("preserves entry/export/surface/when", () => {
    const w = defineWebview({
      id: "w",
      containerId: "c",
      entry: "v.js",
      export: "body",
      surface: "window",
      when: "project.active",
    })
    expect(w).toMatchObject({ surface: "window", when: "project.active", export: "body" })
  })
})
