import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

import { RemoteChromiumService } from "./browser-service.mjs"
import { WorkspaceFileBridge } from "./file-bridge.mjs"
import { RuntimeEventJournal, createRuntimeServer } from "./runtime-server.mjs"
import { AgentSupervisor } from "./supervisor.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(process.env.COGNIA_WORKSPACE_ROOT ?? "/workspace")
const profilesRoot = path.resolve(process.env.COGNIA_BROWSER_PROFILES_ROOT ?? "/profiles")
const overlayPath = path.resolve(
  process.env.COGNIA_BROWSER_OVERLAY_PATH ?? path.join(here, "overlay.injected.js")
)
const secret = process.env.COGNIA_WORKSPACE_RUNTIME_SECRET ?? ""
const port = Number(process.env.COGNIA_WORKSPACE_RUNTIME_PORT ?? 27910)
const host = process.env.COGNIA_WORKSPACE_RUNTIME_HOST ?? "0.0.0.0"

if (secret.length < 32) throw new Error("COGNIA_WORKSPACE_RUNTIME_SECRET must be at least 32 chars")

const overlayScript = await fs.readFile(overlayPath, "utf8")
const fileBridge = new WorkspaceFileBridge({ workspaceRoot })
const browserService = new RemoteChromiumService({
  chromium,
  overlayScript,
  workspaceRoot,
  profilesRoot,
  fileBridge,
})
const eventJournal = new RuntimeEventJournal()
const supervisor = new AgentSupervisor({
  workspaceRoot,
  onEvent: (event) => eventJournal.publish(event),
})
const runtime = createRuntimeServer({ secret, browserService, supervisor, eventJournal })
const address = await runtime.listen(port, host)
process.stdout.write(`${JSON.stringify({ type: "ready", address })}\n`)

let closing = false
async function shutdown() {
  if (closing) return
  closing = true
  await runtime.close()
}
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
