import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ALLOWLIST,
  SCANNED_PATHS,
  SIDECAR_EXECUTION_PATHS,
  resolveScanPaths,
} from "./check-provider-name-branches.mjs"

const everyPathBut =
  (...gone) =>
  (p) =>
    !gone.includes(p)

test("scans whichever sidecar execution path exists while the migration is in flight", () => {
  assert.deepEqual(
    resolveScanPaths({ exists: everyPathBut("sidecar/src") }),
    SCANNED_PATHS.filter((p) => p !== "sidecar/src")
  )
  assert.deepEqual(
    resolveScanPaths({ exists: everyPathBut("sidecar/dispatch") }),
    SCANNED_PATHS.filter((p) => p !== "sidecar/dispatch")
  )
})

test("refuses to go blind: no sidecar path, or a vanished non-sidecar path, is an error", () => {
  assert.throws(
    () => resolveScanPaths({ exists: everyPathBut(...SIDECAR_EXECUTION_PATHS) }),
    /update SIDECAR_EXECUTION_PATHS/
  )
  assert.throws(
    () => resolveScanPaths({ exists: everyPathBut("lib/gateway") }),
    /lib\/gateway — update SCANNED_PATHS/
  )
})

test("allows provider ids in the specific dispatch fixtures, never their implementations", () => {
  for (const file of [
    "sidecar/src/runtimes/ai-sdk/index.test.ts",
    "sidecar/src/providers/protocol-adapters/ai-sdk-adapter.test.ts",
  ]) {
    assert.ok(ALLOWLIST.some((pattern) => pattern.test(file)))
    assert.ok(!ALLOWLIST.some((pattern) => pattern.test(file.replace(".test.ts", ".ts"))))
  }
  assert.ok(!ALLOWLIST.some((pattern) => pattern.test("sidecar/src/host/dispatch.test.ts")))
})
