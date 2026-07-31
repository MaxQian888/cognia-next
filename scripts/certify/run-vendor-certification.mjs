#!/usr/bin/env node
// EXPLICIT, BILLABLE vendor certification (ADR-0090 Phase 5).
//
// Runs the versioned conformance suite against a REAL vendor deployment and
// emits a signed manifest (evidence "cognia-verified", or "vendor-certified"
// with --vendor-attestation). This is never part of CI's deterministic
// matrix: it refuses to run in CI unless CERTIFY_ALLOW_CI=1, requires an
// explicit billing acknowledgement, and requires a SANDBOX credential env
// var so production keys are never burned by accident.
//
// Usage:
//   node scripts/certify/run-vendor-certification.mjs \
//     --deployment <deploymentRef> --base-url <url> \
//     --credential-env <ENV_VAR> --i-understand-this-bills

import { parseArgs } from "node:util"

export function validateCertifyArgs(argv, env = process.env) {
  const { values } = parseArgs({
    args: argv,
    options: {
      deployment: { type: "string" },
      "base-url": { type: "string" },
      "credential-env": { type: "string" },
      "i-understand-this-bills": { type: "boolean", default: false },
      "vendor-attestation": { type: "string" },
    },
    strict: true,
  })
  const errors = []
  if (env.CI === "true" && env.CERTIFY_ALLOW_CI !== "1") {
    errors.push(
      "refusing to run in CI: vendor certification is billable (set CERTIFY_ALLOW_CI=1 to override)"
    )
  }
  if (!values["i-understand-this-bills"]) {
    errors.push("missing --i-understand-this-bills: real vendor turns are billable")
  }
  if (!values.deployment) errors.push("missing --deployment <deploymentRef>")
  if (!values["base-url"]) errors.push("missing --base-url <url>")
  const credentialEnv = values["credential-env"]
  if (!credentialEnv) {
    errors.push("missing --credential-env <ENV_VAR> (sandbox credential, never a production key)")
  } else if (!env[credentialEnv]) {
    errors.push(`credential env var ${credentialEnv} is not set`)
  }
  return { values, errors }
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())
if (isEntry) {
  const { values, errors } = validateCertifyArgs(process.argv.slice(2))
  if (errors.length > 0) {
    console.error("[certify] refused:")
    for (const error of errors) console.error(`  ${error}`)
    process.exit(1)
  }
  console.error(
    `[certify] BILLABLE run against ${values.deployment} (${values["base-url"]}) — ` +
      "driving the full versioned conformance suite with the real Agent SDK."
  )
  // The execution engine reuses the vertical-slice harness with the vendor
  // base URL substituted for the deterministic server, then emits the signed
  // manifest via tests/conformance/harness/emit-manifest.mjs. Evidence:
  // "vendor-certified" only with --vendor-attestation, else "cognia-verified".
  const { runVendorSuite } = await import("./vendor-suite.mjs")
  const code = await runVendorSuite(values)
  process.exit(code)
}
