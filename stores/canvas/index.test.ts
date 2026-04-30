describe("stores/canvas index exports", () => {
  it("re-exports the canvas store modules without a default export", () => {
    const indexExports = require("./index")
    const chunkedDocumentStoreExports = require("./chunked-document-store")
    const keybindingStoreExports = require("./keybinding-store")
    const commentStoreExports = require("./comment-store")
    const canvasSettingsStoreExports = require("./canvas-settings-store")

    expect(indexExports.useChunkedDocumentStore).toBe(
      chunkedDocumentStoreExports.useChunkedDocumentStore
    )
    expect(indexExports.useKeybindingStore).toBe(keybindingStoreExports.useKeybindingStore)
    expect(indexExports.DEFAULT_KEYBINDINGS).toBe(keybindingStoreExports.DEFAULT_KEYBINDINGS)
    expect(indexExports.parseKeyEvent).toBe(keybindingStoreExports.parseKeyEvent)
    expect(indexExports.formatKeybinding).toBe(keybindingStoreExports.formatKeybinding)
    expect(indexExports.useCommentStore).toBe(commentStoreExports.useCommentStore)
    expect(indexExports.useCanvasSettingsStore).toBe(
      canvasSettingsStoreExports.useCanvasSettingsStore
    )
    expect(indexExports.default).toBeUndefined()
  })
})
