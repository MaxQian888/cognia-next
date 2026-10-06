import type { PluginAPIPermission } from "@/types/plugin/plugin"
import type {
  PluginNodeRuntimeAPI,
  PluginNodeRuntimeDeclaration,
  PluginNodeRuntimeStatus,
} from "@/types/plugin/plugin-node-runtime"
import { normalizePluginRelativePath } from "../core/plugin-path"
import { invokePluginApi, isPluginGatewayAvailable, PluginGatewayError } from "../core/transport"
import { hasApiOrGuardPermission } from "./api-permission-gate"

const WRITE_PERMISSIONS: readonly PluginAPIPermission[] = [
  "filesystem:read",
  "filesystem:write",
  "shell:execute",
]

/** Uses the shared desktop/headless/remote gateway; never imports Node code into a WebView. */
export function createNodeRuntimeAPI(
  pluginId: string,
  declaration: PluginNodeRuntimeDeclaration | undefined
): PluginNodeRuntimeAPI {
  async function call(method: keyof PluginNodeRuntimeAPI): Promise<PluginNodeRuntimeStatus> {
    const api = `nodeRuntime:${method}`
    const fail = (
      code: "NOT_SUPPORTED" | "INVALID_REQUEST" | "PERMISSION_DENIED",
      message: string
    ): never => {
      throw new PluginGatewayError({ code, message, pluginId, api, requestId: `local-${api}` })
    }
    if (!declaration) fail("NOT_SUPPORTED", "This plugin does not declare an optional Node runtime")
    // The installed manifest is checked again by the host. This validation also
    // protects direct callers that did not pass through manifest validation.
    try {
      normalizePluginRelativePath(declaration!.directory)
      normalizePluginRelativePath(declaration!.entry)
    } catch {
      fail("INVALID_REQUEST", "Node runtime paths must stay inside the plugin package")
    }
    if (!isPluginGatewayAvailable()) {
      fail("NOT_SUPPORTED", "Optional Node runtimes require a supported connected host")
    }
    const permissions: readonly PluginAPIPermission[] =
      method === "status"
        ? ["filesystem:read"]
        : method === "prepare"
          ? [...WRITE_PERMISSIONS, "network:fetch"]
          : WRITE_PERMISSIONS
    for (const permission of permissions) {
      if (!hasApiOrGuardPermission(pluginId, permission)) {
        fail("PERMISSION_DENIED", `Node runtime ${method} requires ${permission}`)
      }
    }
    return invokePluginApi<PluginNodeRuntimeStatus>(
      pluginId,
      api,
      {},
      {
        // prepare acknowledges a host job; probe has a bounded 30-second child.
        timeoutMs: method === "probe" ? 40_000 : 30_000,
        retries: 0,
      }
    )
  }
  return {
    status: () => call("status"),
    prepare: () => call("prepare"),
    cancel: () => call("cancel"),
    probe: () => call("probe"),
    remove: () => call("remove"),
  }
}
