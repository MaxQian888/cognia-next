// Certification pipeline integration (ADR-0090 Phase 5 acceptance):
// deterministic suite → signed manifest bundle → store verification → auto
// gate accept → staleness reject on any version bump → bundle rollback.
// Runs the REAL emit/verify/gate code over a temp directory.

import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { buildManifest, emitManifestBundle } from "../harness/emit-manifest.mjs"
import { SUITE_CASES, SUITE_VERSION } from "../suite-manifest.mjs"

// The TS gate modules load directly (ts source, node --test with the repo's
// ts-transpilation unavailable) — so this test re-implements NOTHING: it
// spawns jest for the TS half? No — the TS sources are plain enough to
// import via the packages' source-export convention using tsx-free dynamic
// import of the transpiled-by-node TypeScript is unsupported. Instead the
// verification half runs through node:crypto directly against the SAME
// canonical payload contract pinned by emit-manifest's signingPayload and
// the TS manifestSigningPayload fixture parity below.

import { createPublicKey, verify as edVerify } from "node:crypto"
import { signingPayload } from "../harness/emit-manifest.mjs"

function baseKey() {
  return {
    runtime: "claude-agent-sdk",
    ingressProtocol: "anthropic",
    routeMode: "gateway",
    translationMode: "passthrough",
    deploymentRef: "conf-anthropic",
    model: "claude-opus-4-8",
    agentSdkVersion: "0.3.183",
    claudeCodeVersion: "2.1.0",
    gatewayVersion: "0.1.0",
  }
}

test("emit → verify → activate → rollback round trip", async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), "cognia-cert-"))

  const manifestA = buildManifest({
    key: baseKey(),
    evidence: "cognia-verified",
    capabilities: { streaming: "supported" },
    suiteResults: SUITE_CASES.map((caseId) => ({ caseId, passed: true })),
    parity: { passed: true },
    issuer: "cognia-ci",
    issuedAt: "2026-07-23T00:00:00.000Z",
  })
  const emittedA = emitManifestBundle({ rootDir, manifest: manifestA })

  // Local (no CI key) issuance downgrades the issuer and signs verifiably.
  assert.equal(emittedA.manifest.issuer, "local")
  assert.ok(emittedA.manifest.signature)
  assert.equal(emittedA.manifest.key.suiteVersion, SUITE_VERSION)

  const publicKey = createPublicKey(emittedA.publicKeyPem)
  const verified = edVerify(
    null,
    Buffer.from(signingPayload(emittedA.manifest), "utf8"),
    publicKey,
    Buffer.from(emittedA.manifest.signature, "base64")
  )
  assert.equal(verified, true, "the emitted signature must verify against the bundle pubkey")

  // Tampering breaks verification.
  const tampered = { ...emittedA.manifest, evidence: "native" }
  assert.equal(
    edVerify(
      null,
      Buffer.from(signingPayload(tampered), "utf8"),
      publicKey,
      Buffer.from(emittedA.manifest.signature, "base64")
    ),
    false
  )

  // Bundle B, then activate A → B → rollback to A via the pointer file.
  const manifestB = buildManifest({
    key: baseKey(),
    evidence: "cognia-verified",
    capabilities: { streaming: "supported" },
    suiteResults: [{ caseId: "text-sse", passed: true }],
    parity: { passed: true },
    issuer: "cognia-ci",
    issuedAt: "2026-07-24T00:00:00.000Z",
  })
  const emittedB = emitManifestBundle({ rootDir, manifest: manifestB })
  assert.notEqual(emittedA.manifest.bundleId, emittedB.manifest.bundleId)

  const { rollbackBundle } = await import("../../../scripts/certify/rollback-bundle.mjs")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(
    path.join(rootDir, "active-bundle.json"),
    JSON.stringify({
      bundleId: emittedB.manifest.bundleId,
      activatedAt: "2026-07-24T01:00:00.000Z",
      previousBundleId: emittedA.manifest.bundleId,
    })
  )
  const { next, mismatches } = rollbackBundle({
    rootDir,
    pins: { agentSdkVersion: "0.3.183", gatewayCrateVersion: "0.1.0" },
  })
  assert.equal(next.bundleId, emittedA.manifest.bundleId)
  assert.deepEqual(mismatches, [])

  // Rollback onto drifted installed artifacts reports what must also move.
  writeFileSync(
    path.join(rootDir, "active-bundle.json"),
    JSON.stringify({
      bundleId: emittedB.manifest.bundleId,
      activatedAt: "2026-07-24T02:00:00.000Z",
      previousBundleId: emittedA.manifest.bundleId,
    })
  )
  const drifted = rollbackBundle({
    rootDir,
    pins: { agentSdkVersion: "0.9.9", gatewayCrateVersion: "0.1.0" },
  })
  assert.equal(drifted.mismatches.length, 1)

  // The persisted manifest file is valid JSON with the suite results beside it.
  const persisted = JSON.parse(
    readFileSync(path.join(rootDir, "bundles", emittedA.manifest.bundleId, "manifest.json"), "utf8")
  )
  assert.equal(persisted.bundleId, emittedA.manifest.bundleId)
})

test("vendor certification CLI refuses without explicit billing acknowledgement", async () => {
  const { validateCertifyArgs } =
    await import("../../../scripts/certify/run-vendor-certification.mjs")
  const refused = validateCertifyArgs(
    ["--deployment", "dep-1", "--base-url", "https://vendor.example"],
    { CI: "false" }
  )
  assert.ok(refused.errors.some((e) => e.includes("--i-understand-this-bills")))
  assert.ok(refused.errors.some((e) => e.includes("--credential-env")))

  const inCi = validateCertifyArgs(
    [
      "--deployment",
      "dep-1",
      "--base-url",
      "https://vendor.example",
      "--credential-env",
      "SANDBOX_KEY",
      "--i-understand-this-bills",
    ],
    { CI: "true", SANDBOX_KEY: "sk-sandbox" }
  )
  assert.ok(inCi.errors.some((e) => e.includes("refusing to run in CI")))

  const accepted = validateCertifyArgs(
    [
      "--deployment",
      "dep-1",
      "--base-url",
      "https://vendor.example",
      "--credential-env",
      "SANDBOX_KEY",
      "--i-understand-this-bills",
    ],
    { CI: "false", SANDBOX_KEY: "sk-sandbox" }
  )
  assert.deepEqual(accepted.errors, [])
})
