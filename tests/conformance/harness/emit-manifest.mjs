// Manifest emission + signing (ADR-0090 Phase 5).
//
// After a full deterministic suite run, assemble a CompatibilityManifest and
// sign it with Ed25519. CI provides the release key via
// COGNIA_CERT_SIGNING_KEY_PEM (issuer "cognia-ci"); local runs generate an
// ad-hoc key (issuer "local") whose public half is written beside the
// manifest — managed policy can reject local issuers.

import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { SUITE_VERSION } from "../suite-manifest.mjs"

/** Canonical signing payload — mirrors manifestSigningPayload (TS side). */
export function signingPayload(manifest) {
  const { signature: _signature, ...rest } = manifest
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize)
    if (value && typeof value === "object") {
      const out = {}
      for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) continue
        out[key] = canonicalize(value[key])
      }
      return out
    }
    return value
  }
  return JSON.stringify(canonicalize(rest))
}

export function buildManifest({
  key,
  evidence,
  level = "core",
  capabilities,
  suiteResults,
  parity,
  knownLosses = [],
  issuer,
  issuedAt = new Date().toISOString(),
  expiresAt,
}) {
  const bundleId = `bundle-${createHash("sha256")
    .update(JSON.stringify({ key, issuedAt }))
    .digest("hex")
    .slice(0, 16)}`
  return {
    manifestVersion: 1,
    bundleId,
    key: { ...key, suiteVersion: SUITE_VERSION },
    evidence,
    level,
    capabilities,
    suiteResults,
    parity,
    knownLosses,
    issuer,
    issuedAt,
    ...(expiresAt ? { expiresAt } : {}),
  }
}

/**
 * Sign + persist a manifest bundle. Returns { manifest, bundleDir,
 * publicKeyPem }. When COGNIA_CERT_SIGNING_KEY_PEM is absent, an ad-hoc
 * local key signs (issuer forced to "local").
 */
export function emitManifestBundle({ rootDir, manifest }) {
  const ciKeyPem = process.env.COGNIA_CERT_SIGNING_KEY_PEM
  let privateKey
  let publicKeyPem
  let issuer = manifest.issuer
  if (ciKeyPem) {
    privateKey = createPrivateKey(ciKeyPem)
    publicKeyPem = process.env.COGNIA_CERT_PUBKEY_PEM ?? ""
  } else {
    const pair = generateKeyPairSync("ed25519")
    privateKey = pair.privateKey
    publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString()
    issuer = "local"
  }
  const unsigned = { ...manifest, issuer }
  const signature = edSign(null, Buffer.from(signingPayload(unsigned), "utf8"), privateKey)
  const signed = { ...unsigned, signature: signature.toString("base64") }

  const bundleDir = path.join(rootDir, "bundles", signed.bundleId)
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(path.join(bundleDir, "manifest.json"), JSON.stringify(signed, null, 2))
  writeFileSync(
    path.join(bundleDir, "suite-results.json"),
    JSON.stringify(signed.suiteResults, null, 2)
  )
  if (publicKeyPem) {
    writeFileSync(path.join(bundleDir, "issuer-public-key.pem"), publicKeyPem)
  }
  return { manifest: signed, bundleDir, publicKeyPem }
}
