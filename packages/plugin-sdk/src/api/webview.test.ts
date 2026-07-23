import * as sdk from "./webview"
import type {
  PluginWebviewDef,
  PluginWebviewHandle,
  PluginWebviewMessage,
  ResolvedPluginWebview,
} from "./webview"

describe("plugin-sdk api/webview", () => {
  it("exposes the authoring helper and webview registry/message functions", () => {
    expect(typeof sdk.defineWebview).toBe("function")
    expect(typeof sdk.registerWebview).toBe("function")
    expect(typeof sdk.unregisterWebviewsByPlugin).toBe("function")
    expect(typeof sdk.getWebview).toBe("function")
    expect(typeof sdk.getWebviewSnapshot).toBe("function")
    expect(typeof sdk.listWebviewsForContainer).toBe("function")
    expect(typeof sdk.subscribeWebviews).toBe("function")
    expect(typeof sdk.attachWebviewPoster).toBe("function")
    expect(typeof sdk.postMessageToWebview).toBe("function")
    expect(typeof sdk.dispatchWebviewMessage).toBe("function")
    expect(typeof sdk.onWebviewMessage).toBe("function")
  })

  it("re-exports webview contract types", () => {
    const assertTypes = <
      _T extends
        PluginWebviewDef | ResolvedPluginWebview | PluginWebviewHandle | PluginWebviewMessage,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
