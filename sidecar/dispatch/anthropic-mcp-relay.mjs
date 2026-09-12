import { isDeepStrictEqual } from "node:util"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

const RELAY_CONFIG_ENV = "COGNIA_MCP_RELAY_CONFIG"

function relayScriptPath() {
  const sourceLayout = fileURLToPath(new URL("../mcp-stdio-relay.mjs", import.meta.url))
  if (existsSync(sourceLayout)) return sourceLayout
  return fileURLToPath(new URL("./mcp-stdio-relay.mjs", import.meta.url))
}

function encodeRelayConfig(entry, permissionToolName) {
  return Buffer.from(
    JSON.stringify({
      permissionToolName,
      transport: entry.type ?? "stdio",
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
      url: entry.url,
      headers: entry.headers,
      allowPrivateNetwork: entry.allowPrivateNetwork === true,
    }),
    "utf8"
  ).toString("base64url")
}

export function isPackagedRuntime(probe) {
  const runtime = probe ?? {
    pkg: process.pkg,
    bunStandalone: Boolean(globalThis.Bun?.isStandaloneExecutable),
  }
  return Boolean(runtime.pkg) || runtime.bunStandalone === true
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
    packaged = isPackagedRuntime(),
    permissionPromptToolName,
  } = {}
) {
  if (!servers || typeof servers !== "object") return {}
  return Object.fromEntries(
    Object.entries(servers).map(([name, entry]) => {
      if (
        !entry ||
        (entry.type !== "http" && entry.type !== "sse" && typeof entry.command !== "string")
      )
        return [name, entry]
      return [
        name,
        {
          type: "stdio",
          command: nodeExecutable,
          args: packaged ? [] : [scriptPath],
          env: {
            [RELAY_CONFIG_ENV]: encodeRelayConfig(
              entry,
              permissionPromptToolName?.startsWith(`mcp__${name}__`)
                ? permissionPromptToolName.slice(`mcp__${name}__`.length)
                : undefined
            ),
            ...(packaged ? { COGNIA_ROLE: "mcp-relay", COGNIA_MCP_RELAY_SCRIPT: scriptPath } : {}),
          },
          ...(typeof entry.timeout === "number" ? { timeout: entry.timeout } : {}),
          ...(entry.alwaysLoad === true ? { alwaysLoad: true } : {}),
        },
      ]
    })
  )
}

export const __TESTING__ = { RELAY_CONFIG_ENV, encodeRelayConfig }

/** A delegated approval may approve the checked input, never replace it after hooks ran. */
export function permissionDecisionHasUnprovenRewrite(result, originalInput) {
  const decisions = [result, result?.structuredContent]
  const texts = (Array.isArray(result?.content) ? result.content : [])
    .filter((content) => content?.type === "text")
    .map((content) => content.text)
  if (typeof result === "string") texts.push(result)
  for (const text of [...texts, texts.join("\n"), texts.join("")]) {
    try {
      decisions.push(JSON.parse(text))
    } catch {
      /* SDK validates non-JSON responses. */
    }
  }
  return decisions.some(
    (decision) =>
      decision?.updatedInput !== undefined &&
      (originalInput === undefined || !isDeepStrictEqual(decision.updatedInput, originalInput))
  )
}
