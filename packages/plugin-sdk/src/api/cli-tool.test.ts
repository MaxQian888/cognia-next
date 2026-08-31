import * as sdk from "./cli-tool"
import type {
  PluginCliArgvToken,
  PluginCliBinaryRef,
  PluginCliCwdPolicy,
  PluginCliOutputParse,
  PluginCliToolDef,
} from "./cli-tool"

describe("plugin-sdk api/cli-tool", () => {
  it("exposes portable CLI-tool authoring and preview helpers", () => {
    expect(typeof sdk.defineCliTool).toBe("function")
    expect(typeof sdk.buildArgv).toBe("function")
    expect(typeof sdk.resolveCwd).toBe("function")
    expect(typeof sdk.parseOutput).toBe("function")
    expect(typeof sdk.CliTemplateError).toBe("function")
  })

  it("defineCliTool is a typesafe identity function", () => {
    const def = sdk.defineCliTool({
      name: "search_files",
      description: "Search workspace files.",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      binary: { kind: "requires", name: "rg" },
      argv: [{ literal: "--json" }, { param: "query" }],
      outputParse: "json",
    })

    expect(def.name).toBe("search_files")
    expect(def.argv).toHaveLength(2)
  })

  it("re-exports CLI manifest and executor types", () => {
    const assertTypes = <
      _T extends
        | PluginCliToolDef
        | PluginCliBinaryRef
        | PluginCliArgvToken
        | PluginCliOutputParse
        | PluginCliCwdPolicy,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
