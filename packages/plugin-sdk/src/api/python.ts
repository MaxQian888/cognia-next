/**
 * Plugin SDK - `python` capability authoring/runtime surface.
 *
 * Type-only facade for Python plugin manifests, host settings, bridge messages,
 * and the optional `ctx.python` API mounted for Python-capable plugins.
 */

export type {
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
} from "@cognia/plugin-contract/types/plugin/plugin"
