/**
 * Persistent OAuth state for remote MCP servers, stored separately from the
 * declarative `.mcp.json` config in `~/.cognia/mcp-auth.json`:
 *
 *   { "<serverName>": { tokens, clientInformation, codeVerifier } }
 *
 * Keeping tokens out of the config file (mirroring OpenCode's `mcp-auth.json`)
 * means a user can commit / share `.mcp.json` without leaking credentials, and
 * `/mcp logout` can wipe one server's grant without touching its config.
 */
import nodeFs from "node:fs"
import path from "node:path"

export interface McpAuthEntry {
  /** OAuth tokens (access/refresh) as returned by the SDK. */
  tokens?: Record<string, unknown>
  /** Dynamically-registered client info (client_id/secret), if any. */
  clientInformation?: Record<string, unknown>
  /** In-flight PKCE code verifier (cleared once tokens are saved). */
  codeVerifier?: string
}

export type McpAuthFile = Record<string, McpAuthEntry>

export interface McpAuthFs {
  exists(path: string): boolean
  readText(path: string): string
  writeText(path: string, data: string): void
}

const defaultFs: McpAuthFs = {
  exists: (p) => nodeFs.existsSync(p),
  readText: (p) => nodeFs.readFileSync(p, "utf8"),
  writeText: (p, data) => {
    nodeFs.mkdirSync(path.dirname(p), { recursive: true })
    // 0600 so other users on a shared box can't read the tokens.
    nodeFs.writeFileSync(p, data, { encoding: "utf8", mode: 0o600 })
  },
}

export function mcpAuthPath(home: string): string {
  return path.join(home, "mcp-auth.json")
}

function readFile(home: string, fs: McpAuthFs): McpAuthFile {
  const file = mcpAuthPath(home)
  if (!fs.exists(file)) return {}
  try {
    const parsed = JSON.parse(fs.readText(file)) as unknown
    if (parsed && typeof parsed === "object") return parsed as McpAuthFile
  } catch {
    // corrupt store → treat as empty (re-auth recreates it)
  }
  return {}
}

function writeFile(home: string, data: McpAuthFile, fs: McpAuthFs): void {
  fs.writeText(mcpAuthPath(home), JSON.stringify(data, null, 2))
}

/** Read one server's OAuth entry (empty object when none stored). */
export function readAuthEntry(home: string, name: string, fs: McpAuthFs = defaultFs): McpAuthEntry {
  return readFile(home, fs)[name] ?? {}
}

/** Merge a partial update into a server's OAuth entry and persist. */
export function patchAuthEntry(
  home: string,
  name: string,
  patch: McpAuthEntry,
  fs: McpAuthFs = defaultFs
): void {
  const data = readFile(home, fs)
  data[name] = { ...(data[name] ?? {}), ...patch }
  writeFile(home, data, fs)
}

/** Delete a server's OAuth entry (`/mcp logout`). Returns true if one existed. */
export function clearAuthEntry(home: string, name: string, fs: McpAuthFs = defaultFs): boolean {
  const data = readFile(home, fs)
  if (!(name in data)) return false
  delete data[name]
  writeFile(home, data, fs)
  return true
}

/** Whether a server currently has stored tokens (i.e. is authenticated). */
export function hasAuthTokens(home: string, name: string, fs: McpAuthFs = defaultFs): boolean {
  const entry = readFile(home, fs)[name]
  return Boolean(entry?.tokens && typeof entry.tokens === "object")
}
