import type {
  McpUiResourceCsp,
  McpUiResourcePermissions,
} from "@modelcontextprotocol/ext-apps/app-bridge"

const CSP_KEYS = ["connectDomains", "resourceDomains", "frameDomains", "baseUriDomains"] as const
const PERMISSION_KEYS = ["camera", "microphone", "geolocation", "clipboardWrite"] as const

type CspKey = (typeof CSP_KEYS)[number]
type PermissionKey = (typeof PERMISSION_KEYS)[number]

export interface McpAppApprovals {
  origins?: Partial<Record<CspKey, string[]>>
  permissions?: Partial<Record<PermissionKey, boolean>>
}

export interface McpAppSandboxPolicy {
  allowed: boolean
  denied: string[]
  csp: McpUiResourceCsp
  permissions: McpUiResourcePermissions
  sandbox: "allow-scripts"
}

function normalizeOrigin(value: string): string {
  const wildcard = value.match(/^(https:|wss:)\/\/\*\.([a-z0-9.-]+)$/i)
  if (wildcard) return `${wildcard[1].toLowerCase()}//*.${wildcard[2].toLowerCase()}`
  const parsed = new URL(value)
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"
  if (!["https:", "wss:"].includes(parsed.protocol) && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`MCP App origin must use HTTPS/WSS or loopback HTTP: ${value}`)
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`MCP App CSP entries must be origins: ${value}`)
  }
  return parsed.origin
}

export function evaluateMcpAppSandbox(
  requestedCsp: McpUiResourceCsp = {},
  requestedPermissions: McpUiResourcePermissions = {},
  approvals: McpAppApprovals = {}
): McpAppSandboxPolicy {
  const denied: string[] = []
  const csp: McpUiResourceCsp = {}
  for (const key of CSP_KEYS) {
    const approved = new Set((approvals.origins?.[key] ?? []).map(normalizeOrigin))
    const requested = (requestedCsp[key] ?? []).map(normalizeOrigin)
    const missing = requested.filter((origin) => !approved.has(origin))
    if (missing.length) denied.push(`${key}:${missing.join(",")}`)
    if (requested.length) csp[key] = requested
  }

  const permissions: McpUiResourcePermissions = {}
  for (const key of PERMISSION_KEYS) {
    if (!requestedPermissions[key]) continue
    if (approvals.permissions?.[key] !== true) denied.push(`permission:${key}`)
    else permissions[key] = {}
  }
  return { allowed: denied.length === 0, denied, csp, permissions, sandbox: "allow-scripts" }
}

/**
 * The outer opaque-origin frame never runs server HTML. It only relays validated
 * JSON-RPC messages between AppBridge and a second, separately sandboxed frame.
 */
export const MCP_APP_SANDBOX_PROXY_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; frame-src 'self' blob: data:"></head>
<body><script>
(() => {
  let inner = null;
  const send = (message) => parent.postMessage(message, "*");
  addEventListener("message", (event) => {
    if (event.source === parent) {
      const message = event.data;
      if (message && message.jsonrpc === "2.0" && message.method === "ui/notifications/sandbox-resource-ready") {
        const params = message.params || {};
        const frame = document.createElement("iframe");
        frame.setAttribute("sandbox", params.sandbox || "allow-scripts");
        const permissions = params.permissions || {};
        const allow = [];
        if (permissions.camera) allow.push("camera");
        if (permissions.microphone) allow.push("microphone");
        if (permissions.geolocation) allow.push("geolocation");
        if (permissions.clipboardWrite) allow.push("clipboard-write");
        if (allow.length) frame.setAttribute("allow", allow.join("; "));
        frame.style.cssText = "border:0;width:100%;height:100%;display:block";
        frame.srcdoc = params.html || "";
        document.body.replaceChildren(frame);
        inner = frame.contentWindow;
        return;
      }
      if (inner && message && message.jsonrpc === "2.0") inner.postMessage(message, "*");
      return;
    }
    if (inner && event.source === inner && event.data && event.data.jsonrpc === "2.0") send(event.data);
  });
  send({ jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} });
})();
</script></body></html>`

export function injectMcpAppCsp(html: string, csp: McpUiResourceCsp): string {
  const connect = csp.connectDomains?.join(" ") || "'none'"
  const resources = csp.resourceDomains?.join(" ") || "'none'"
  const frames = csp.frameDomains?.join(" ") || "'none'"
  const base = csp.baseUriDomains?.join(" ") || "'none'"
  const policy = [
    "default-src 'none'",
    `connect-src ${connect}`,
    `script-src 'unsafe-inline' ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src ${resources}`,
    `media-src blob: ${resources}`,
    `frame-src ${frames}`,
    `base-uri ${base}`,
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ")
  const meta = `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', "&quot;")}">`
  return /<head[\s>]/i.test(html)
    ? html.replace(/<head([^>]*)>/i, `<head$1>${meta}`)
    : `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`
}
