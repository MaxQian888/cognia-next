// Compatibility shim (ADR-0090 Phase 3 → retired per Phase 9 schedule).
//
// The host implementation moved to `agent-host.mjs`; every named export and
// the process-entry behavior are preserved here so stale spawn paths
// (`COGNIA_SIDECAR_SCRIPT`, Dockerfiles, packaged CLI sidecar role) keep
// working byte-for-byte. `startAgentHost` is idempotent, so double entry
// signals (shim guard + role import) never double-start the stdin loop.

export * from "./agent-host.mjs"

import { pathToFileURL } from "node:url"
import { smoke, startAgentHost } from "./agent-host.mjs"

const isEntryPoint = (() => {
  try {
    if (process.env.COGNIA_ROLE === "sidecar") return true
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href
  } catch {
    return false
  }
})()

if (isEntryPoint) {
  if (process.argv.includes("--smoke")) {
    smoke().catch((e) => {
      console.error(e)
      process.exit(1)
    })
  } else {
    startAgentHost()
  }
}
