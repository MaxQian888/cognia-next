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
  it("exposes the LSP server authoring helper and the registry's composite key", () => {
    expect(typeof sdk.defineLspServer).toBe("function")
    expect(sdk.lspServerKey("plugin", "ts")).toBe("plugin:ts")
  })

  it("keeps the host registry off the author surface (plugins declare manifest.lspServers)", () => {
    for (const hostOnly of [
      "configureLspRegistry",
      "registerLspServer",
      "unregisterLspServer",
      "unregisterByOwner",
      "listLspServers",
      "getLspServerForLanguage",
      "registerPluginLspServers",
    ]) {
      expect(sdk).not.toHaveProperty(hostOnly)
    }
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
