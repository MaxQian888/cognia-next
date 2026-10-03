/**
 * Leaf module: no imports, so the plugin SDK's `contracts` subpath can publish
 * this list without pulling the handler graph into an author's bundle.
 */

/**
 * Every outbound request/notification currently exposed by the sidecar but
 * lacking a canonical host-neutral adapter. Registering these is intentional:
 * requests receive a deterministic JSON-RPC capability error immediately and
 * notifications are logged by the dispatcher rather than disappearing as
 * "method not found" noise.
 */
export const EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS = [
  "env:asExternalUri",
  "env:clipboardReadText",
  "env:clipboardWriteText",
  "env:openExternal",
  "extensions:activate",
  "extensions:get",
  "terminal:create",
  "terminal:dispose",
  "terminal:hide",
  "terminal:sendText",
  "terminal:show",
  "webview:dispose",
  "webview:postMessage",
  "webview:reveal",
  "webview:setHtml",
  "webview:setTitle",
  "webview:show",
  "window:createWebviewPanel",
  "window:registerUriHandler",
  "window:registerWebviewViewProvider",
  "window:unregisterUriHandler",
  "window:unregisterWebviewViewProvider",
  "workspace:configurationGet",
  "workspace:configurationHas",
  "workspace:configurationInspect",
  "workspace:configurationUpdate",
] as const
