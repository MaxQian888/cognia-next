const COGNIA_RESOURCE_SCHEME = "cognia://"

/** Parse a Cognia MCP resource URI without loading any persistence modules. */
export function parseResourceUri(uri: string): { kind: string; id: string } | undefined {
  if (!uri.startsWith(COGNIA_RESOURCE_SCHEME)) return undefined
  const rest = uri.slice(COGNIA_RESOURCE_SCHEME.length)
  const separator = rest.indexOf("/")
  if (separator <= 0 || separator === rest.length - 1) return undefined
  return { kind: rest.slice(0, separator), id: rest.slice(separator + 1) }
}
