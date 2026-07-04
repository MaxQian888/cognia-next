import type {
  PluginPythonAPI,
  PluginPythonModule,
  PythonHookDeclaration,
  PythonHookRegistration,
  PythonHostSettings,
  PythonIPCMessage,
  PythonLoadResult,
  PythonParamDef,
  PythonPluginManifest,
  PythonToolDef,
} from "./python"

describe("plugin-sdk api/python", () => {
  it("re-exports Python manifest, context API, and bridge types", () => {
    const assertTypes = <
      _T extends
        | PluginPythonAPI
        | PluginPythonModule
        | PythonPluginManifest
        | PythonToolDef
        | PythonParamDef
        | PythonHookRegistration
        | PythonHostSettings
        | PythonHookDeclaration
        | PythonLoadResult
        | PythonIPCMessage,
    >(): void => undefined

    expect(assertTypes).toBeDefined()
  })
})
