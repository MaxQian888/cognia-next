#!/usr/bin/env node
// Certification rollback (ADR-0090 Phase 5): flip active-bundle.json back to
// its previousBundleId after verifying the previous manifest still exists
// AND its pinned SDK/Gateway versions match the currently installed
// artifacts (otherwise the caller must also roll those back — printed).

import { readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export function rollbackBundle({ rootDir, read = readFileSync, write = writeFileSync, pins }) {
  const pointerPath = path.join(rootDir, "active-bundle.json")
  const pointer = JSON.parse(read(pointerPath, "utf8"))
  if (!pointer.previousBundleId) {
    throw new Error("no previous bundle recorded — nothing to roll back to")
  }
  const manifestPath = path.join(rootDir, "bundles", pointer.previousBundleId, "manifest.json")
  const manifest = JSON.parse(read(manifestPath, "utf8"))

  const mismatches = []
  if (pins) {
    if (manifest.key.agentSdkVersion !== pins.agentSdkVersion) {
      mismatches.push(
        `agent SDK: bundle certifies ${manifest.key.agentSdkVersion}, installed ${pins.agentSdkVersion}`
      )
    }
    if (manifest.key.gatewayVersion !== pins.gatewayCrateVersion) {
      mismatches.push(
        `gateway: bundle certifies ${manifest.key.gatewayVersion}, installed ${pins.gatewayCrateVersion}`
      )
    }
  }

  const next = {
    bundleId: pointer.previousBundleId,
    activatedAt: new Date().toISOString(),
    previousBundleId: pointer.bundleId,
  }
  write(pointerPath, JSON.stringify(next, null, 2))
  return { next, mismatches }
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())
if (isEntry) {
  const { PINNED_RUNTIME_VERSIONS } =
    await import("../../packages/agent-config-types/src/runtime-versions.ts")
  const rootDir =
    process.env.COGNIA_CERT_ROOT ?? path.join(os.homedir(), ".cognia", "agent-certification")
  const { next, mismatches } = rollbackBundle({ rootDir, pins: PINNED_RUNTIME_VERSIONS })
  console.log(`[rollback] active bundle is now ${next.bundleId}`)
  if (mismatches.length > 0) {
    console.error(
      "[rollback] WARNING — the certified artifact versions do not match the installed ones:"
    )
    for (const m of mismatches) console.error(`  ${m}`)
    console.error(
      "  Roll back the corresponding artifacts too, or the bundle stays stale for auto."
    )
    process.exit(2)
  }
}
