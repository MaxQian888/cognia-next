import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const RELAY_CONFIG_ENV = "COGNIA_MCP_RELAY_CONFIG"

function relayScriptPath() {
  const sourceLayout = fileURLToPath(new URL("../mcp-stdio-relay.mjs", import.meta.url))
  if (existsSync(sourceLayout)) return sourceLayout
  return fileURLToPath(new URL("./mcp-stdio-relay.mjs", import.meta.url))
}

function encodeRelayConfig(entry) {
  return Buffer.from(
    JSON.stringify({
      transport: entry.type,
      url: entry.url,
      headers: entry.headers,
      allowPrivateNetwork: entry.allowPrivateNetwork === true,
    }),
    "utf8"
  ).toString("base64url")
}

/**
 * Convert Anthropic-managed remote entries to SDK-managed stdio relays. The
 * Agent SDK retains lifecycle/reconnect ownership, while the relay owns the
 * upstream socket and can enforce the same guarded DNS lookup as AI SDK/OAuth.
 * Credentials stay in the child environment and never enter argv/process lists.
 */
export function guardAnthropicRemoteMcpServers(
  servers,
  {
    nodeExecutable = process.execPath,
    scriptPath = relayScriptPath(),
    packaged = Boolean(process.pkg),
  } = {}
) {
  if (!servers || typeof servers !== "object") return {}
  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => {
      if (!entry || (entry.type !== "http" && entry.type !== "sse")) return [name, entry]
      return [
        name,
        {
          type: "stdio",
          command: nodeExecutable,
          args: packaged ? [] : [scriptPath],
          env: {
            [RELAY_CONFIG_ENV]: encodeRelayConfig(entry),
            ...(packaged
              ? { COGNIA_ROLE: "mcp-relay", COGNIA_MCP_RELAY_SCRIPT: scriptPath }
              : {}),
          },
          ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
          ...(entry.alwaysLoad === true ? { alwaysLoad: true } : {}),
        },
      ]
    })
  )
}

export const __TESTING__ = { RELAY_CONFIG_ENV, encodeRelayConfig }
