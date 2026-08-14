import { PLUGIN_RESOURCE_EFFECTS } from "./resource-effects"

describe("PLUGIN_RESOURCE_EFFECTS", () => {
  it("declares current handle-producing ctx methods explicitly", () => {
    expect(PLUGIN_RESOURCE_EFFECTS).toMatchObject({
      "ctx.webview.create": { kind: "returned-handle", disposeMethod: "dispose" },
      "ctx.modal.openModal": { kind: "returned-handle", disposeMethod: "close" },
      "ctx.modal.openById": { kind: "returned-handle", disposeMethod: "close" },
      "ctx.window.create": { kind: "returned-handle", disposeMethod: "close" },
    })
  })
})
