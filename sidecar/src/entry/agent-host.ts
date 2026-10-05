import "../platform/net/install-fetch-interceptor.ts"
import { pathToFileURL } from "node:url"
import { initializeTelemetry, shutdownTelemetry } from "../platform/telemetry/index.ts"
import { createAgentHost, loadConfiguredEngines } from "../host/index.ts"
export * from "../host/index.ts"

let host: ReturnType<typeof createAgentHost> | undefined
let shutdown: Promise<unknown> | undefined
const shutdownHostTelemetry = () => (shutdown ??= shutdownTelemetry())
function defaultHost() {
  if (!host) {
    initializeTelemetry()
    host = createAgentHost({ shutdownHostTelemetry })
  }
  return host
}
// Observers are a public test seam and never initialize a runtime on import.
export const emitObservers = new Set<(payload: unknown) => void>()
function observeHost() {
  const current = defaultHost()
  current.emitObservers.add(forwardObservers)
  return current
}
function forwardObservers(payload: unknown) {
  for (const observe of emitObservers) {
    try {
      observe(payload)
    } catch {
      /* Observers cannot break the wire. */
    }
  }
}
export function emitForTests(payload: unknown) {
  observeHost().emitForTests(payload)
}
export function startAgentHost() {
  void loadConfiguredEngines().then(
    () => observeHost().startAgentHost(),
    (error: unknown) => {
      console.error(error)
      process.exit(1)
    }
  )
}
export async function smoke() {
  await loadConfiguredEngines()
  return observeHost().smoke()
}
export function runAgentHostEntry(url: string) {
  const isEntry =
    process.env.COGNIA_ROLE === "sidecar" || url === pathToFileURL(process.argv[1] ?? "").href
  if (!isEntry) return
  if (process.argv.includes("--smoke")) {
    void smoke().catch((error: unknown) => {
      console.error(error)
      process.exit(1)
    })
  } else startAgentHost()
}
