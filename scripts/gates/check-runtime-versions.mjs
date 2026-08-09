#!/usr/bin/env node
// ADR-0090 Phase 5 gate: the staleness inputs in
// packages/agent-config-types/src/runtime-versions.ts must match the actual
// pins. Drift here silently breaks certification staleness, so it fails CI.

import { readFileSync } from "node:fs"

export function checkRuntimeVersions({ read = (p) => readFileSync(p, "utf8") } = {}) {
  const errors = []

  const constants = read("packages/agent-config-types/src/runtime-versions.ts")
  const sdkPinned = constants.match(/agentSdkVersion:\s*"([^"]+)"/)?.[1]
  const claudeCodePinned = constants.match(/claudeCodeVersion:\s*"([^"]+)"/)?.[1]
  const gatewayPinned = constants.match(/gatewayCrateVersion:\s*"([^"]+)"/)?.[1]
  const suitePinned = constants.match(/certificationSuiteVersion:\s*"([^"]+)"/)?.[1]

  const sidecarPkg = JSON.parse(read("sidecar/package.json"))
  const sdkActual = sidecarPkg.dependencies?.["@anthropic-ai/claude-agent-sdk"]
  if (!sdkActual) {
    errors.push("sidecar/package.json: @anthropic-ai/claude-agent-sdk dependency not found")
  } else if (sdkActual.replace(/^[\^~=]/, "") !== sdkPinned) {
    errors.push(
      `agentSdkVersion drift: runtime-versions.ts says ${sdkPinned}, sidecar/package.json pins ${sdkActual}`
    )
  }
  const sdkPackage = JSON.parse(
    read("sidecar/node_modules/@anthropic-ai/claude-agent-sdk/package.json")
  )
  if (sdkPackage.claudeCodeVersion !== claudeCodePinned) {
    errors.push(
      `claudeCodeVersion drift: runtime-versions.ts says ${claudeCodePinned}, installed Agent SDK declares ${sdkPackage.claudeCodeVersion}`
    )
  }

  const cargo = read("crates/cognia-gateway/Cargo.toml")
  const gatewayActual = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
  if (gatewayActual !== gatewayPinned) {
    errors.push(
      `gatewayCrateVersion drift: runtime-versions.ts says ${gatewayPinned}, Cargo.toml says ${gatewayActual}`
    )
  }

  const suiteManifest = read("tests/conformance/suite-manifest.mjs")
  const suiteActual = suiteManifest.match(/export const SUITE_VERSION\s*=\s*"([^"]+)"/)?.[1]
  if (suiteActual !== suitePinned) {
    errors.push(
      `certificationSuiteVersion drift: runtime-versions.ts says ${suitePinned}, suite-manifest.mjs says ${suiteActual}`
    )
  }

  return errors
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())
if (isEntry) {
  const errors = checkRuntimeVersions()
  if (errors.length > 0) {
    console.error("[check-runtime-versions] staleness inputs drifted:")
    for (const error of errors) console.error(`  ${error}`)
    process.exit(1)
  }
  console.log("[check-runtime-versions] OK — pinned runtime versions match the sources")
}
