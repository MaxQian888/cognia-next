import { createRequire } from "node:module"

interface VersionInfo {
  sdkVersion?: string
  sidecarVersion?: string
}
declare const __COGNIA_SIDECAR_VERSION_INFO__: VersionInfo | undefined

/** Bundles embed metadata; unbuilt Node hosts read their adjacent package. */
export function readVersionInfo(): VersionInfo {
  if (typeof __COGNIA_SIDECAR_VERSION_INFO__ !== "undefined") return __COGNIA_SIDECAR_VERSION_INFO__
  const require = createRequire(import.meta.url)
  const version = (specifier: string): string | undefined => {
    try {
      const value: unknown = require(specifier)
      return value &&
        typeof value === "object" &&
        "version" in value &&
        typeof value.version === "string"
        ? value.version
        : undefined
    } catch {
      return undefined
    }
  }
  return {
    sdkVersion: version("@anthropic-ai/claude-agent-sdk/package.json"),
    sidecarVersion: version("../../package.json"),
  }
}
