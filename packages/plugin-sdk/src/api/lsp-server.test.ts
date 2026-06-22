import * as sdk from "./lsp-server"
import type {
  LspBridgeAdapter,
  LspClientAdapter,
  LspServerOwner,
  LspServerRecord,
  LspServerState,
  PluginLspServerDef,
} from "./lsp-server"

describe("plugin-sdk api/lsp-server", () => {
  it("exposes the LSP server authoring helper and host registry", () => {
    expect(typeof sdk.defineLspServer).toBe("function")
    expect(typeof sdk.configureLspRegistry).toBe("function")
    expect(typeof sdk.registerLspServer).toBe("function")
    expect(typeof sdk.unregisterLspServer).toBe("function")
    expect(typeof sdk.unregisterByOwner).toBe("function")
    expect(typeof sdk.listLspServers).toBe("function")
    expect(typeof sdk.getLspServerForLanguage).toBe("function")
    expect(typeof sdk.registerPluginLspServers).toBe("function")
    expect(typeof sdk.lspServerKey).toBe("function")
    expect(sdk.lspServerKey("plugin", "ts")).toBe("plugin:ts")
  })

  it("defineLspServer is a typesafe identity function", () => {
    const def = sdk.defineLspServer({
      id: "example-lsp",
      name: "Example LSP",
      languages: ["typescript"],
      command: "example-lsp",
      args: ["--stdio"],
    })

    expect(def.id).toBe("example-lsp")
    expect(def.languages).toEqual(["typescript"])
  })

  it("re-exports LSP contribution and registry types", () => {
    const assertTypes = <
      _T extends
        | PluginLspServerDef
        | LspServerOwner
        | LspServerState
        | LspServerRecord
        | LspClientAdapter
        | LspBridgeAdapter,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
