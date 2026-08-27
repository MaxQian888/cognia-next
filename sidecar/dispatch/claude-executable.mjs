import fs from "node:fs"
import path from "node:path"

const MISSING_CLAUDE_MESSAGE =
  "Claude runtime is unavailable. Use the full Cognia distribution, set " +
  "COGNIA_CLAUDE_EXECUTABLE to a target-native Claude executable, or put claude on PATH."

function defaultIsExecutable(candidate, platform) {
  try {
    const stat = fs.statSync(candidate)
    return stat.isFile() && (platform === "win32" || (stat.mode & 0o111) !== 0)
  } catch {
    return false
  }
}

/** Resolve the separately packaged Claude runtime for a compiled host. */
export function resolveStandaloneClaudeExecutable({
  execPath = process.execPath,
  env = process.env,
  platform = process.platform,
  isExecutable = (candidate) => defaultIsExecutable(candidate, platform),
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix
  const binaryName = platform === "win32" ? "claude.exe" : "claude"

  // Explicit configuration first, bundled default second, PATH last.
  //
  // `COGNIA_CLAUDE_EXECUTABLE` is what the failure message tells operators to
  // set, so it has to be able to WIN. Checking the adjacent runtime ahead of it
  // meant that on the full distribution — the one that always ships an adjacent
  // `claude` — the variable was read only when it could no longer matter, so
  // pinning a specific build did nothing and said nothing.
  const configured = env.COGNIA_CLAUDE_EXECUTABLE
  if (configured) {
    const resolved = pathApi.isAbsolute(configured)
      ? configured
      : pathApi.resolve(pathApi.dirname(execPath), configured)
    if (isExecutable(resolved)) return resolved
  }

  const adjacent = pathApi.join(pathApi.dirname(execPath), binaryName)
  if (isExecutable(adjacent)) return adjacent

  const pathValue = env.PATH ?? env.Path ?? ""
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""]
  for (const directory of pathValue.split(pathApi.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathApi.join(
        directory,
        platform === "win32" ? `claude${extension}` : "claude"
      )
      if (isExecutable(candidate)) return candidate
    }
  }

  throw new Error(MISSING_CLAUDE_MESSAGE)
}

/**
 * Source runtimes let the Agent SDK resolve its adjacent platform package.
 * The Bun executable build replaces this function with the standalone
 * resolver above, while keeping SDK-owned source runtimes unchanged.
 */
export function resolveEmbeddedClaudeExecutable() {
  if (globalThis.__COGNIA_COMPILED_HOST__ === true) {
    return resolveStandaloneClaudeExecutable()
  }
  return undefined
}

/** Apply only the host-owned executable option; renderer input cannot set it. */
export function applyEmbeddedClaudeExecutable(
  options,
  resolveExecutable = resolveEmbeddedClaudeExecutable
) {
  const executable = resolveExecutable()
  return executable ? { ...options, pathToClaudeCodeExecutable: executable } : options
}
