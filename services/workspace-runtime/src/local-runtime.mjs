import fs from "node:fs/promises"
import path from "node:path"

import { RemoteChromiumService } from "./browser-service.mjs"
import { RuntimeEventJournal, createRuntimeServer } from "./runtime-server.mjs"

/**
 * Remove leftovers Playwright could not delete when a previous runtime was
 * killed mid-download. The staging directory is derived from `profilesRoot`
 * (never configurable), so this only ever empties Cognia's own folder.
 */
export async function resetStagingRoot(stagingRoot) {
  await fs.mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  for (const entry of await fs.readdir(stagingRoot)) {
    await fs.rm(path.join(stagingRoot, entry), { recursive: true, force: true })
  }
}

/**
 * Assemble the desktop's local browser runtime (ADR-0201): the browser service
 * in local mode behind the authenticated loopback control plane, with no
 * agent supervisor and no workspace file bridge.
 */
export async function startLocalRuntime({
  config,
  chromium,
  devices = {},
  host = "127.0.0.1",
  port = 0,
  serviceOptions = {},
}) {
  const overlayScript = await fs.readFile(config.overlayPath, "utf8")
  await fs.mkdir(config.profilesRoot, { recursive: true, mode: 0o700 })
  await resetStagingRoot(config.stagingRoot)
  const eventJournal = new RuntimeEventJournal()
  const browserService = new RemoteChromiumService({
    chromium,
    devices,
    overlayScript,
    profilesRoot: config.profilesRoot,
    stagingRoot: config.stagingRoot,
    mode: "local",
    onEvent: (event) => eventJournal.publish(event),
    maxSessions: config.maxSessions,
    maxPages: config.maxPages,
    // The user's own browser is never reaped for idleness.
    idleTimeoutMs: Number.POSITIVE_INFINITY,
    maxLifetimeMs: Number.POSITIVE_INFINITY,
    ...serviceOptions,
  })
  const runtime = createRuntimeServer({
    secret: config.secret,
    browserService,
    eventJournal,
  })
  const address = await runtime.listen(port, host)
  let closing = null
  return {
    address,
    browserService,
    eventJournal,
    close() {
      closing ??= runtime.close()
      return closing
    },
  }
}
