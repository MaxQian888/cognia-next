import fs from "node:fs"
import path from "node:path"

/** Shared by Bun and esbuild so bundled hosts never depend on source paths. */
export function sidecarVersionDefines(root) {
  const readVersion = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8")).version
  return {
    __COGNIA_SIDECAR_VERSION_INFO__: JSON.stringify({
      sdkVersion: readVersion("sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
      sidecarVersion: readVersion("sidecar/package.json"),
    }),
  }
}
