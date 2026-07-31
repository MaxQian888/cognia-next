import * as sdk from "./uri-handler"
import type { ParsedDeepLink, PluginUriHandlerDef, UriHandler } from "./uri-handler"

describe("plugin-sdk api/uri-handler", () => {
  it("exposes the authoring helper and URI handler registry functions", () => {
    expect(typeof sdk.defineUriHandler).toBe("function")
    expect(typeof sdk.registerUriHandler).toBe("function")
    expect(typeof sdk.getUriHandler).toBe("function")
    expect(typeof sdk.unregisterUriHandlersByPlugin).toBe("function")
    expect(typeof sdk.dispatchUri).toBe("function")
  })

  it("re-exports URI handler and deep-link contract types", () => {
    const assertTypes = <_T extends PluginUriHandlerDef | UriHandler | ParsedDeepLink>(): void =>
      undefined

    expect(assertTypes).toBeDefined()
  })
})
