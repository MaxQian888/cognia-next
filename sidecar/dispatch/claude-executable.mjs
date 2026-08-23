/**
 * Source runtimes let the Agent SDK resolve its adjacent platform package.
 * The Bun executable build replaces this function with an embedded-file
 * extractor for the selected target.
 */
export function resolveEmbeddedClaudeExecutable() {
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
