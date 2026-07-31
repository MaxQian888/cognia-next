import * as sdk from "./message-renderer"
import type {
  MessagePartRendererEntry,
  MessagePartRendererProps,
  PluginMessagePartAPI,
  PluginMessageRendererDef,
} from "./message-renderer"

describe("plugin-sdk api/message-renderer", () => {
  it("exposes the authoring helper and message part renderer registry functions", () => {
    expect(typeof sdk.defineMessageRenderer).toBe("function")
    expect(typeof sdk.registerMessagePartRenderer).toBe("function")
    expect(typeof sdk.getMessagePartRenderer).toBe("function")
    expect(typeof sdk.clearMessagePartRenderersForPlugin).toBe("function")
    expect(typeof sdk.clearAllMessagePartRenderers).toBe("function")
    expect(typeof sdk.listMessagePartRenderers).toBe("function")
    expect(typeof sdk.subscribeMessagePartRenderers).toBe("function")
    expect(typeof sdk.getMessagePartRenderersRevision).toBe("function")
    expect(typeof sdk.createMessagePartAPI).toBe("function")
    expect(typeof sdk.purgeMessagePartRenderersForPlugin).toBe("function")
  })

  it("re-exports message renderer and message part contract types", () => {
    const assertTypes = <
      _T extends
        | PluginMessageRendererDef
        | MessagePartRendererProps
        | MessagePartRendererEntry
        | PluginMessagePartAPI,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
