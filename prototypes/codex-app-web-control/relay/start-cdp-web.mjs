#!/usr/bin/env node

import { randomBytes } from "node:crypto"
import { unlink } from "node:fs/promises"

import { buildCdpWebService, cdpWebLabel } from "./cdp-web-service.mjs"
import {
  commandResult,
  defaultStateDir,
  ensurePrivateDirectory,
  launchctlDomain,
  launchctlJobExists,
  readJson,
  waitFor,
} from "./shared.mjs"

const argv = process.argv.slice(2)
const valueAfter = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : fallback
}
const stateDir = valueAfter("--state-dir", process.env.CODEX_RELAY_STATE_DIR ?? defaultStateDir())
const label = cdpWebLabel()

function printDescriptor(descriptor, reused) {
  process.stdout.write(
    `${reused ? "Reusing" : "Started"} launchd-owned Cognia Codex relay (pid ${descriptor.pid}).\n` +
      `Cognia normal-App control: ${descriptor.url}\n` +
      `Cognia Web pairing code: ${descriptor.pairingCode}\n` +
      `Stop: pnpm --dir prototypes/codex-app-web-control cdp:web:stop\n`
  )
}

async function descriptorIsLive(descriptor) {
  if (!descriptor?.baseUrl || !descriptor?.token || !descriptor?.url) return false
  try {
    const response = await fetch(`${descriptor.baseUrl}/api/status`, {
      headers: { authorization: `Bearer ${descriptor.token}` },
      signal: AbortSignal.timeout(2000),
    })
    return response.ok
  } catch {
    return false
  }
}

function serviceRunning() {
  const printed = commandResult("/bin/launchctl", ["print", `${launchctlDomain()}/${label}`])
  return (
    printed.ok && (/\bstate = running\b/.test(printed.stdout) || /\bpid = \d+/.test(printed.stdout))
  )
}

const existingService = launchctlJobExists(label)
const initialService = buildCdpWebService({
  launchId: randomBytes(12).toString("hex"),
  stateDir,
  forwardedArgs: argv,
  label,
})

if (existingService) {
  const descriptor = await readJson(initialService.paths.cdpWebDescriptor)
  if (await descriptorIsLive(descriptor)) {
    printDescriptor(descriptor, true)
    process.exit(0)
  }
  if (!serviceRunning()) {
    commandResult("/bin/launchctl", ["remove", label])
  }
}

if (!launchctlJobExists(label)) {
  await ensurePrivateDirectory(initialService.paths.root)
  await unlink(initialService.paths.cdpWebDescriptor).catch(() => {})
  const submitted = commandResult("/bin/launchctl", initialService.launchArgs)
  if (!submitted.ok) {
    throw new Error(submitted.stderr || submitted.error || "Unable to start launchd-owned Relay")
  }
}

const descriptor = await waitFor(
  async () => {
    const candidate = await readJson(initialService.paths.cdpWebDescriptor)
    return (await descriptorIsLive(candidate)) ? candidate : null
  },
  {
    timeoutMs: 300_000,
    intervalMs: 500,
    description: "launchd-owned Cognia Codex relay",
  }
)
printDescriptor(descriptor, existingService)
