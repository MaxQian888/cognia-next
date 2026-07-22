/**
 * Coverage for scripts/gates/check-gate-registry.mjs — the meta-gate that
 * makes "added a gate script, forgot to wire it" a build failure.
 *
 * The pure `auditRegistry` takes its inputs by injection, so every branch is
 * exercised without touching the real package.json. One live test then runs
 * the gate against the REAL repo state, because a meta-gate that only passes
 * against fixtures is exactly the failure mode it exists to prevent.
 *
 * Run with: node --test scripts/gates/check-gate-registry.test.mjs
 */

import { test } from "node:test"
import assert from "node:assert/strict"

import {
  EXEMPTIONS,
  VERIFICATION_PATTERNS,
  auditRegistry,
  isVerificationScript,
  main,
} from "./check-gate-registry.mjs"

test("isVerificationScript matches whole name segments, not substrings", () => {
  for (const name of [
    "lint",
    "typecheck",
    "format:check",
    "audit:slots",
    "sidecar:test:lsp",
    "i18n:validate",
    "foo:verify",
  ]) {
    assert.ok(isVerificationScript(name), `${name} should look like a verification script`)
  }

  for (const name of ["blueprint", "dev", "build", "storybook", "attestation", "latest"]) {
    assert.ok(!isVerificationScript(name), `${name} should NOT match`)
  }
})

test("VERIFICATION_PATTERNS is a non-empty list of regexes", () => {
  assert.ok(VERIFICATION_PATTERNS.length > 0)
  assert.ok(VERIFICATION_PATTERNS.every((re) => re instanceof RegExp))
})

test("auditRegistry flags a verification script that is neither registered nor exempt", () => {
  const result = auditRegistry(["lint", "widget:check"], {
    gates: [{ script: "lint", group: "lint", runtime: "node", blocking: true }],
    exemptions: {},
  })
  assert.deepEqual(result.unregistered, ["widget:check"])
  assert.deepEqual(result.missingScripts, [])
  assert.deepEqual(result.staleExemptions, [])
})

test("auditRegistry accepts a script that is registered, or exempt with a reason", () => {
  const gates = [{ script: "lint", group: "lint", runtime: "node", blocking: true }]

  const registered = auditRegistry(["lint"], { gates, exemptions: {} })
  assert.deepEqual(registered.unregistered, [])

  const exempted = auditRegistry(["lint", "widget:check"], {
    gates,
    exemptions: { "widget:check": "owned by the widget workflow" },
  })
  assert.deepEqual(exempted.unregistered, [])
})

test("auditRegistry flags a registry entry pointing at a script that does not exist", () => {
  const result = auditRegistry(["lint"], {
    gates: [
      { script: "lint", group: "lint", runtime: "node", blocking: true },
      { script: "ghost:check", group: "audit", runtime: "node", blocking: true },
    ],
    exemptions: {},
  })
  assert.deepEqual(result.missingScripts, ["ghost:check"])
})

test("auditRegistry flags a stale exemption whose script was deleted", () => {
  const result = auditRegistry(["lint"], {
    gates: [{ script: "lint", group: "lint", runtime: "node", blocking: true }],
    exemptions: { "removed:check": "was owned by a workflow that no longer exists" },
  })
  assert.deepEqual(result.staleExemptions, ["removed:check"])
})

test("auditRegistry flags an exemption with a blank reason", () => {
  const result = auditRegistry(["lint", "widget:check"], {
    gates: [{ script: "lint", group: "lint", runtime: "node", blocking: true }],
    exemptions: { "widget:check": "   " },
  })
  assert.deepEqual(result.emptyReasons, ["widget:check"])
})

test("auditRegistry ignores non-verification scripts entirely", () => {
  const result = auditRegistry(["dev", "build", "storybook"], { gates: [], exemptions: {} })
  assert.deepEqual(result.unregistered, [])
})

test("every exemption carries a non-empty reason", () => {
  for (const [script, reason] of Object.entries(EXEMPTIONS)) {
    assert.equal(typeof reason, "string", `${script} reason must be a string`)
    assert.ok(reason.trim().length > 0, `${script} must document WHY it is exempt`)
  }
})

test("live: the real repo satisfies the meta-gate", () => {
  // Not a fixture. If this fails, a real script in package.json is wired to
  // nothing — which is the whole point of the gate.
  assert.equal(main(), 0)
})
