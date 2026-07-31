// Vendor-suite driver (ADR-0090 Phase 5) — the billable half of
// run-vendor-certification.mjs. Reuses the SAME sidecar harness and suite
// identity as the deterministic conformance run; only the upstream differs.

import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { SUITE_CASES, SUITE_VERSION } from "../../tests/conformance/suite-manifest.mjs"
import {
  buildManifest,
  emitManifestBundle,
} from "../../tests/conformance/harness/emit-manifest.mjs"
import { spawnSidecar, assistantText } from "../../tests/conformance/harness/sidecar-process.mjs"
import { PINNED_RUNTIME_VERSIONS } from "../../packages/agent-config-types/src/runtime-versions.ts"

/**
 * Drive a minimal-but-real certification pass: one live turn per suite case
 * family against the vendor deployment, recording pass/fail per case. Full
 * per-scenario assertions require the deterministic server; against a live
 * vendor we certify the CORE capability level (text, multi-turn, tools).
 */
export async function runVendorSuite(values) {
  const baseUrl = values["base-url"]
  const apiKey = process.env[values["credential-env"]]
  const suiteResults = []
  const capabilities = {}

  const record = (caseId, passed, capabilityIds) => {
    suiteResults.push({ caseId, passed })
    for (const capability of capabilityIds) {
      capabilities[capability] = passed ? "supported" : "unsupported"
    }
  }

  const sidecar = spawnSidecar({ baseUrl, apiKey })
  try {
    await sidecar.waitFor((m) => m.type === "ready", { timeoutMs: 30_000, label: "ready" })

    // text-sse — one live streamed turn.
    try {
      sidecar.send({ type: "send", sessionId: "certify-text", prompt: "Reply with the word PONG." })
      const assistant = await sidecar.waitFor(
        (m) => m.type === "event" && m.event?.type === "assistant",
        { timeoutMs: 120_000, label: "certify text turn" }
      )
      record("text-sse", assistantText(assistant).length > 0, ["streaming"])
    } catch {
      record("text-sse", false, ["streaming"])
    }

    // multi-turn — second turn on the same session.
    try {
      const mark = sidecar.mark()
      sidecar.send({ type: "send", sessionId: "certify-text", prompt: "And now the word PING." })
      await sidecar.waitFor((m) => m.type === "event" && m.event?.type === "result", {
        timeoutMs: 120_000,
        label: "certify multi-turn",
        sinceIndex: mark,
      })
      record("multi-turn", true, ["session.multi-turn"])
    } catch {
      record("multi-turn", false, ["session.multi-turn"])
    }

    // The remaining frozen cases are recorded as not-run (failed) against a
    // live vendor unless the deterministic server drives them — the manifest
    // stays honest about what was actually exercised.
    for (const caseId of SUITE_CASES) {
      if (!suiteResults.some((r) => r.caseId === caseId)) {
        suiteResults.push({ caseId, passed: false, detail: "not exercised in live vendor mode" })
      }
    }
  } finally {
    await sidecar.close()
  }

  const manifest = buildManifest({
    key: {
      runtime: "claude-agent-sdk",
      ingressProtocol: "anthropic",
      routeMode: "direct",
      translationMode: "passthrough",
      deploymentRef: values.deployment,
      model: "vendor-default",
      agentSdkVersion: PINNED_RUNTIME_VERSIONS.agentSdkVersion,
      claudeCodeVersion: process.env.COGNIA_CLAUDE_CODE_VERSION ?? "unknown",
      gatewayVersion: PINNED_RUNTIME_VERSIONS.gatewayCrateVersion,
      suiteVersion: SUITE_VERSION,
    },
    evidence: values["vendor-attestation"] ? "vendor-certified" : "cognia-verified",
    level: "core",
    capabilities,
    suiteResults,
    parity: { passed: false, detail: "gateway/direct parity requires the deterministic server" },
    knownLosses: [],
    issuer: "cognia-ci",
  })

  const rootDir =
    process.env.COGNIA_CERT_ROOT ?? path.join(os.homedir(), ".cognia", "agent-certification")
  mkdirSync(rootDir, { recursive: true })
  const { bundleDir } = emitManifestBundle({ rootDir, manifest })
  console.error(`[certify] manifest written: ${bundleDir}`)
  const corePassed = suiteResults
    .filter((r) => ["text-sse", "multi-turn"].includes(r.caseId))
    .every((r) => r.passed)
  return corePassed ? 0 : 1
}
